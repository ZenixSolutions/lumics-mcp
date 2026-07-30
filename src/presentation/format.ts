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
  /** Character budget for the JSON payload. Defaults to the configured value. */
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
 * Shape a payload into the single text block a tool returns.
 *
 * Budget handling differs by shape, deliberately:
 *  - **Arrays** shed whole items from the end until they fit, so every item that
 *    survives is complete and parseable. A half-serialised object is worse than
 *    a missing one.
 *  - **Anything else** is hard-truncated with a disclosure, because there is no
 *    meaningful smaller unit to shed.
 */
export function shapeToolOutput(value: unknown, options: ShapeOptions = {}): ShapedOutput {
  const maxChars = options.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const projected = projectFields(value, options.fields);

  const notes: string[] = [...(options.notes ?? [])];
  let droppedItems = 0;
  let budgetTruncated = false;
  let limitReached = false;
  let payload: string;

  if (Array.isArray(projected)) {
    // The budget is fitted FIRST so the completeness note can be told about it:
    // the two disclosures used to be generated independently and could give
    // opposite advice in the same response.
    const fitted = fitArrayToBudget(projected, maxChars);
    droppedItems = fitted.dropped;
    budgetTruncated = fitted.dropped > 0;
    payload = fitted.json;

    const completeness = listCompletenessNote(
      projected.length,
      options.requestedLimit,
      budgetTruncated,
    );
    if (completeness !== undefined) {
      limitReached = true;
      notes.push(completeness);
    }

    if (budgetTruncated) {
      notes.push(budgetTruncationNote(fitted.dropped, projected.length - fitted.dropped, maxChars));
    }
  } else {
    const json = toCompactJson(projected);
    if (json.length > maxChars) {
      budgetTruncated = true;
      payload = json.slice(0, maxChars);
      notes.push(
        `NOTE ON TRUNCATION: this single object exceeded the ${String(maxChars)}-character output budget and was cut ` +
          `after ${String(maxChars)} characters, so the JSON below is INCOMPLETE and may not parse. Re-run with a ` +
          'fields projection to select only the properties you need.',
      );
    } else {
      payload = json;
    }
  }

  const text = notes.length === 0 ? payload : `${notes.join('\n\n')}\n\n${payload}`;
  return { text, budgetTruncated, droppedItems, limitReached };
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
