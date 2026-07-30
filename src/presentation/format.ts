/**
 * Output shaping and the token budget.
 *
 * Three rules, each of them a defect the prototype had:
 *
 * **1. Compact JSON, never `JSON.stringify(x, null, 2)`.** Pretty-printing a
 * device list inflates it by roughly 30–40% in tokens and buys the model nothing
 * — it is not reading with its eyes. RFC-001 D5 item 9.
 *
 * **2. No fabricated pagination.** spec §4.3: "There is no pagination in this API
 * as documented." The only result-control parameter anywhere is `limit`; there is
 * no `offset`, `page`, `skip`, `cursor`, `after`, `sort` or `order`, and no list
 * response carries a total. The prototype synthesised `offset`, `has_more` and
 * `next_offset` — and `next_offset` referenced a parameter that does not exist.
 * An agent reading `has_more: false` reports a partial inventory as complete,
 * which RFC-001 calls the most damaging defect found. So: emit none of those
 * fields, and when a list comes back exactly `limit` long, say plainly that it
 * may be truncated *and* that there is no mechanism to fetch the rest. See
 * {@link listCompletenessNote}.
 *
 * **3. No double serialisation and no `structuredContent`.** RFC-001 D5 item 8:
 * declare an `outputSchema` or omit `structuredContent`, not both. v0.1 omits it,
 * so this module produces exactly one string and the factory puts it in exactly
 * one text block.
 */

import { DEFAULT_MAX_OUTPUT_CHARS } from '../constants.js';

export interface ShapeOptions {
  /**
   * Character budget for the **whole** returned text — disclosure notes and JSON
   * payload together, not the payload alone. Defaults to the configured value.
   * See {@link shapeToolOutput} for the one case that can exceed it.
   */
  readonly maxChars?: number;
  /** Whitelist of top-level fields to keep on each record. */
  readonly fields?: readonly string[] | undefined;
  /**
   * The `limit` that was sent to Lumics, if any. Supplying it is what enables
   * the truncation-honesty note; omitting it silently disables that disclosure,
   * so list tools must always pass it.
   */
  readonly requestedLimit?: number | undefined;
  /** Extra lines prepended to the payload, e.g. a client-side ranking notice. */
  readonly notes?: readonly string[] | undefined;
}

export interface ShapedOutput {
  /** The complete text to return to the model: notes, then compact JSON. */
  readonly text: string;
  /** True when the character budget forced items or content to be dropped. */
  readonly budgetTruncated: boolean;
  /** How many array items the budget removed. */
  readonly droppedItems: number;
  /** True when the result count equalled `requestedLimit`. */
  readonly limitReached: boolean;
}

/**
 * The no-pagination disclosure.
 *
 * Returns a note **only** when the number of returned items is exactly the
 * requested `limit`, which is the one observable signal the API gives that more
 * data may exist (spec §4.3 — no total, no next link, no cursor). Exported and
 * named so it can be unit-tested directly rather than only through a tool.
 *
 * @param itemCount Number of items actually returned.
 * @param requestedLimit The `limit` sent to Lumics, or `undefined` if none was.
 */
export function listCompletenessNote(
  itemCount: number,
  requestedLimit: number | undefined,
  budgetTruncated = false,
): string | undefined {
  if (requestedLimit === undefined || itemCount < requestedLimit) {
    return undefined;
  }
  // The advice has to know whether the same response was ALSO cut by the output
  // budget. "Re-run with a higher limit" and "re-run with a smaller limit" were
  // previously emitted side by side, and a model following the first one gets
  // FEWER records back — the budget sheds what the larger limit fetched, and
  // there is no pagination to recover with.
  const remedy = budgetTruncated
    ? 'A higher limit will NOT help and will make this worse: this same response was also cut by the output ' +
      'character budget (see the truncation note), so raising the limit only adds records that the budget then ' +
      'drops. Narrow the query, or pass a "fields" projection to make each record small enough that more of them ' +
      'fit, or ask the operator to raise LUMICS_MAX_OUTPUT_CHARS.'
    : 'To see more, re-run with a higher limit; to see fewer but be certain, narrow the query.';

  return (
    `NOTE ON COMPLETENESS: exactly ${String(itemCount)} results were returned, which equals the requested limit of ` +
    `${String(requestedLimit)}. There may be more matching records that are NOT in this response. The Lumics API ` +
    'provides no pagination mechanism whatsoever — no offset, page, cursor or sort parameter exists, and list ' +
    `responses carry no total count — so the remaining records cannot be retrieved by paging. ${remedy} Do NOT ` +
    'describe this result as a complete inventory.'
  );
}

/** Disclosure for budget-driven truncation. Always states the number dropped. */
export function budgetTruncationNote(
  droppedItems: number,
  keptItems: number,
  maxChars: number,
): string {
  return (
    `NOTE ON TRUNCATION: this response exceeded the ${String(maxChars)}-character output budget, so ` +
    `${String(droppedItems)} of ${String(droppedItems + keptItems)} items were dropped and are not shown. ` +
    'The dropped items are not an indication that they do not exist. Re-run with a smaller limit, a narrower ' +
    'query, or an explicit fields projection to see the rest, or ask the operator to raise LUMICS_MAX_OUTPUT_CHARS.'
  );
}

/** Compact JSON. The one place `JSON.stringify` is called for tool output. */
export function toCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    // A cyclic or BigInt-bearing payload must still produce something useful.
    return JSON.stringify({ error: 'response could not be serialised to JSON' });
  }
}

/**
 * Keep only `fields` on a record, preserving the requested order. Applied to
 * each element of an array, or to a single object. Unknown field names are
 * simply absent from the result rather than an error: a projection is a hint,
 * and failing a whole call because the model guessed a field name is worse.
 */
export function projectFields(value: unknown, fields: readonly string[] | undefined): unknown {
  if (fields === undefined || fields.length === 0) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectRecord(item, fields));
  }
  return projectRecord(value, fields);
}

/**
 * How many characters of the budget a set of notes consumes, blank-line
 * separators and the gap before the payload included.
 */
function notesLength(notes: readonly string[]): number {
  if (notes.length === 0) {
    return 0;
  }
  const separators = (notes.length - 1) * 2 + 2; // "\n\n" between notes and before the payload
  return notes.reduce((sum, note) => sum + note.length, 0) + separators;
}

/**
 * What is left of `maxChars` for the payload once `notes` are counted.
 *
 * Exported because a tool that fits a payload itself — `lumics_get_metric_summary`
 * sheds per item class before returning, since {@link shapeToolOutput} cannot shed
 * from a keyed object — has to reserve the same way, or it fits to a budget the
 * notes then blow through.
 *
 * Never negative: notes that exceed the budget on their own take the payload to
 * zero rather than being cut themselves. A truncation or completeness disclosure
 * dropped to save characters is exactly the silent-shortening failure this whole
 * module exists to prevent, so the disclosures are the part that survives.
 */
export function budgetAfterNotes(notes: readonly string[], maxChars: number): number {
  return Math.max(0, maxChars - notesLength(notes));
}

function joinNotes(notes: readonly string[], payload: string): string {
  return notes.length === 0 ? payload : `${notes.join('\n\n')}\n\n${payload}`;
}

/**
 * Shape a payload into the single text block a tool returns.
 *
 * Budget handling differs by shape, deliberately:
 *  - **Arrays** shed whole items from the end until they fit, so every item that
 *    survives is complete and parseable. A half-serialised object is worse than
 *    a missing one.
 *  - **Anything else** is hard-truncated with a disclosure, because there is no
 *    meaningful smaller unit to shed.
 *
 * In both cases the notes are counted against the *same* budget as the payload,
 * and reserved before it is fitted. `maxChars` is documented as a cap on tool
 * output; fitting the payload to it and then prepending ~1,100 characters of
 * disclosure made every response exceed it, worst in relative terms at the
 * smallest configurable budget. The disclosures are never shortened or dropped
 * to make the sum fit — the payload gives way instead, down to nothing.
 */
export function shapeToolOutput(value: unknown, options: ShapeOptions = {}): ShapedOutput {
  const maxChars = options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const projected = projectFields(value, options.fields);
  const baseNotes: readonly string[] = [...(options.notes ?? [])];

  if (Array.isArray(projected)) {
    return shapeArray(projected, maxChars, baseNotes, options.requestedLimit);
  }
  return shapeSingle(projected, maxChars, baseNotes);
}

/**
 * Fit an array and its disclosures into one budget.
 *
 * The two are mutually dependent: shedding items adds a truncation note, the
 * note consumes budget, and the smaller budget may shed more items. So this
 * iterates to a fixed point rather than fitting once and hoping. Convergence is
 * guaranteed because a larger note set can only shed more, and the note set
 * changes size only by the digits of its counts; the loop is capped anyway, and
 * on the (unreachable in practice) cap the honest counts win over the last few
 * characters of budget.
 */
function shapeArray(
  items: readonly unknown[],
  maxChars: number,
  baseNotes: readonly string[],
  requestedLimit: number | undefined,
): ShapedOutput {
  const notesFor = (dropped: number): readonly string[] => {
    const built = [...baseNotes];
    const completeness = listCompletenessNote(items.length, requestedLimit, dropped > 0);
    if (completeness !== undefined) {
      built.push(completeness);
    }
    if (dropped > 0) {
      built.push(budgetTruncationNote(dropped, items.length - dropped, maxChars));
    }
    return built;
  };

  let fitted = fitArrayToBudget(items, budgetAfterNotes(baseNotes, maxChars));
  for (let pass = 0; pass < 5; pass += 1) {
    const refitted = fitArrayToBudget(items, budgetAfterNotes(notesFor(fitted.dropped), maxChars));
    const settled = refitted.dropped === fitted.dropped;
    fitted = refitted;
    if (settled) {
      break;
    }
  }

  const notes = notesFor(fitted.dropped);
  return {
    text: joinNotes(notes, fitted.json),
    budgetTruncated: fitted.dropped > 0,
    droppedItems: fitted.dropped,
    limitReached:
      listCompletenessNote(items.length, requestedLimit, fitted.dropped > 0) !== undefined,
  };
}

/** Fit a single value, which has no smaller unit to shed, against the same budget. */
function shapeSingle(value: unknown, maxChars: number, baseNotes: readonly string[]): ShapedOutput {
  const json = toCompactJson(value);
  if (json.length <= budgetAfterNotes(baseNotes, maxChars)) {
    return {
      text: joinNotes(baseNotes, json),
      budgetTruncated: false,
      droppedItems: 0,
      limitReached: false,
    };
  }

  const noteFor = (cut: number): string =>
    `NOTE ON TRUNCATION: this single object exceeded the ${String(maxChars)}-character output budget and was cut ` +
    `after ${String(cut)} characters — the budget left once the notes above were counted — so the JSON below is ` +
    'INCOMPLETE and may not parse. Re-run with a fields projection to select only the properties you need.';

  // Same fixed point as the array path: the note costs budget, which shortens
  // the cut, which changes the note by a digit or two.
  let cut = budgetAfterNotes(baseNotes, maxChars);
  for (let pass = 0; pass < 5; pass += 1) {
    const next = budgetAfterNotes([...baseNotes, noteFor(cut)], maxChars);
    if (next === cut) {
      break;
    }
    cut = next;
  }

  return {
    text: joinNotes([...baseNotes, noteFor(cut)], json.slice(0, cut)),
    budgetTruncated: true,
    droppedItems: 0,
    limitReached: false,
  };
}

export interface KeyedFitResult {
  /** The same keys, each array trimmed from the end so the whole object fits. */
  readonly value: Readonly<Record<string, readonly unknown[]>>;
  readonly dropped: number;
  readonly total: number;
  /** The per-key cap that was applied, for the disclosure note. */
  readonly perKeyCap: number;
}

/**
 * Fit an object whose values are arrays — `{"devices": [...], "interfaces": [...]}`
 * — into the character budget by shedding items from the end of each array.
 *
 * {@link shapeToolOutput} can only shed items when the payload's *top level* is
 * an array; a keyed object is hard-truncated instead, which produces JSON that
 * does not parse. `lumics_get_metric_summary` returns exactly that shape whenever
 * Lumics reports more than one item class (spec §12.4), so the shedding has to be
 * available for it.
 *
 * A single per-key cap is searched rather than a per-key allowance, so no class
 * is emptied while another keeps a hundred rows, and every item that survives is
 * complete and parseable.
 */
export function fitKeyedArraysToBudget(
  classes: Readonly<Record<string, readonly unknown[]>>,
  maxChars: number,
): KeyedFitResult {
  const entries = Object.entries(classes);
  const total = entries.reduce((sum, [, items]) => sum + items.length, 0);
  const longest = entries.reduce((max, [, items]) => Math.max(max, items.length), 0);

  const capped = (cap: number): Record<string, readonly unknown[]> =>
    Object.fromEntries(entries.map(([key, items]) => [key, items.slice(0, cap)]));

  if (toCompactJson(classes).length <= maxChars) {
    return { value: classes, dropped: 0, total, perKeyCap: longest };
  }

  let low = 0;
  let high = longest;
  let bestCap = 0;
  let bestValue: Record<string, readonly unknown[]> = capped(0);

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = capped(mid);
    if (toCompactJson(candidate).length <= maxChars) {
      bestCap = mid;
      bestValue = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const kept = Object.values(bestValue).reduce((sum, items) => sum + items.length, 0);
  return { value: bestValue, dropped: total - kept, total, perKeyCap: bestCap };
}

/**
 * Binary-search the largest prefix of `items` whose compact JSON fits the
 * budget. Linear shedding is O(n) serialisations on a large list, which on a
 * 5,000-device tenant is measurable.
 */
function fitArrayToBudget(
  items: readonly unknown[],
  maxChars: number,
): { readonly json: string; readonly dropped: number } {
  const full = toCompactJson(items);
  if (full.length <= maxChars) {
    return { json: full, dropped: 0 };
  }

  let low = 0;
  let high = items.length;
  let bestJson = '[]';
  let bestCount = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = toCompactJson(items.slice(0, mid));
    if (candidate.length <= maxChars) {
      bestJson = candidate;
      bestCount = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return { json: bestJson, dropped: items.length - bestCount };
}

function projectRecord(value: unknown, fields: readonly string[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = source[field];
    }
  }
  return out;
}
