/**
 * Output shaping and the pagination-honesty rule — `src/presentation/format.ts`.
 *
 * spec §4.3: the Lumics API has no pagination. The prototype synthesised
 * `offset`, `has_more: false` and a `next_offset` pointing at a parameter that
 * does not exist, which made a partial inventory read as complete. RFC-001 calls
 * that the most damaging defect it found.
 *
 * So this file does two things. It asserts the disclosure fires when it should
 * and says both of the things it has to say, and it asserts — negatively, over a
 * deliberately broad set of inputs — that no pagination key is ever emitted. The
 * negative assertion is the one that catches a future contributor "helpfully"
 * adding paging metadata.
 */

import { describe, expect, it } from 'vitest';
import {
  budgetTruncationNote,
  fitKeyedArraysToBudget,
  listCompletenessNote,
  projectFields,
  shapeToolOutput,
  toCompactJson,
} from '../../src/presentation/format.js';
import { DEFAULT_MAX_OUTPUT_CHARS, MIN_MAX_OUTPUT_CHARS } from '../../src/constants.js';

/**
 * Keys the API does not have and this server must never invent. `sort`/`order`
 * are included because the spec is explicit that they do not exist either.
 */
const FORBIDDEN_KEYS = [
  'offset',
  'has_more',
  'hasMore',
  'next_offset',
  'nextOffset',
  'page',
  'total',
  'totalCount',
  'cursor',
  'next',
  'nextPage',
  'skip',
  'after',
] as const;

/** Assert no forbidden key appears as a JSON key anywhere in a shaped output. */
function expectNoPaginationKeys(text: string): void {
  for (const key of FORBIDDEN_KEYS) {
    expect(text, `pagination key "${key}" must never appear as a JSON key`).not.toMatch(
      new RegExp(`"${key}"\\s*:`),
    );
  }
}

describe('listCompletenessNote', () => {
  it('is silent when fewer results came back than the limit allowed', () => {
    expect(listCompletenessNote(0, 100)).toBeUndefined();
    expect(listCompletenessNote(1, 100)).toBeUndefined();
    expect(listCompletenessNote(99, 100)).toBeUndefined();
  });

  it('is silent when no limit was sent, because there is nothing to compare against', () => {
    expect(listCompletenessNote(0, undefined)).toBeUndefined();
    expect(listCompletenessNote(1_000, undefined)).toBeUndefined();
  });

  it('fires when the count equals the requested limit', () => {
    const note = listCompletenessNote(100, 100);
    expect(note).toBeDefined();
    expect(note).toContain('exactly 100 results');
    expect(note).toContain('the requested limit of 100');
  });

  it('fires when the count somehow exceeds the limit, rather than assuming it cannot', () => {
    expect(listCompletenessNote(101, 100)).toBeDefined();
  });

  it('fires at a limit of 1, the easiest boundary to get wrong', () => {
    expect(listCompletenessNote(1, 1)).toBeDefined();
    expect(listCompletenessNote(0, 1)).toBeUndefined();
  });

  it('states BOTH that results may be truncated AND that there is no way to page', () => {
    const note = listCompletenessNote(50, 50) ?? '';
    // Truncation.
    expect(note).toMatch(/There may be more matching records that are NOT in this response/);
    // No mechanism to get them. Both halves are load-bearing: the first alone
    // invites the model to look for a next page.
    expect(note).toMatch(/no pagination mechanism whatsoever/);
    expect(note).toMatch(/no offset, page, cursor or sort parameter exists/);
    expect(note).toMatch(/carry no total count/);
    expect(note).toMatch(/cannot be retrieved by paging/);
    // And what to do instead.
    expect(note).toMatch(/re-run\s+with a higher limit/);
    // And the instruction that stops a false claim of completeness.
    expect(note).toMatch(/Do NOT describe this result as a complete inventory/);
  });

  it('never names a parameter the API does not have', () => {
    const note = listCompletenessNote(50, 50) ?? '';
    expectNoPaginationKeys(note);
    expect(note).not.toMatch(/next_offset=/);
  });
});

describe('budgetTruncationNote', () => {
  it('always states how many items were dropped out of how many there were', () => {
    const note = budgetTruncationNote(30, 70, 25_000);
    expect(note).toContain('30 of 100 items were dropped');
    expect(note).toContain('25000-character output budget');
    expect(note).toMatch(/not an indication that they do not exist/);
    expect(note).toMatch(/LUMICS_MAX_OUTPUT_CHARS/);
  });
});

describe('toCompactJson', () => {
  it('emits compact JSON, never pretty-printed', () => {
    expect(toCompactJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
    expect(toCompactJson({ a: 1 })).not.toContain('\n');
  });

  it('survives a cyclic payload rather than throwing on the output path', () => {
    const cyclic: Record<string, unknown> = { name: 'device' };
    cyclic.self = cyclic;
    expect(toCompactJson(cyclic)).toBe('{"error":"response could not be serialised to JSON"}');
  });

  it('survives a BigInt payload', () => {
    expect(toCompactJson({ big: 1n })).toBe('{"error":"response could not be serialised to JSON"}');
  });

  it('renders undefined as the string null rather than the empty string', () => {
    expect(toCompactJson(undefined)).toBe('null');
  });
});

describe('projectFields', () => {
  const records = [
    { id: 'a', name: 'one', extra: 1, nested: { deep: true } },
    { id: 'b', name: 'two', extra: 2 },
  ];

  it('returns the value untouched when no projection was asked for', () => {
    expect(projectFields(records, undefined)).toBe(records);
    expect(projectFields(records, [])).toBe(records);
  });

  it('keeps only the named fields, in the order requested', () => {
    expect(projectFields(records, ['name', 'id'])).toEqual([
      { name: 'one', id: 'a' },
      { name: 'two', id: 'b' },
    ]);
    const projected = projectFields(records, ['name', 'id']) as Record<string, unknown>[];
    expect(Object.keys(projected[0] as object)).toEqual(['name', 'id']);
  });

  it('projects a single object as well as an array', () => {
    expect(projectFields({ id: 'a', name: 'one', extra: 1 }, ['id'])).toEqual({ id: 'a' });
  });

  it('omits an unknown field rather than failing the whole call', () => {
    expect(projectFields(records, ['id', 'doesNotExist'])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('leaves primitives and nulls alone', () => {
    expect(projectFields([1, 'two', null], ['id'])).toEqual([1, 'two', null]);
    expect(projectFields(null, ['id'])).toBeNull();
  });

  it('does not reach into inherited properties', () => {
    const base = { inherited: 'nope' };
    const child = Object.create(base) as Record<string, unknown>;
    child.own = 'yes';
    expect(projectFields(child, ['own', 'inherited'])).toEqual({ own: 'yes' });
  });
});

describe('shapeToolOutput', () => {
  it('returns bare compact JSON with no notes when nothing needs disclosing', () => {
    const shaped = shapeToolOutput([{ id: 'a' }], { requestedLimit: 100 });
    expect(shaped.text).toBe('[{"id":"a"}]');
    expect(shaped.limitReached).toBe(false);
    expect(shaped.budgetTruncated).toBe(false);
    expect(shaped.droppedItems).toBe(0);
  });

  it('prepends the completeness disclosure when the array is exactly the limit long', () => {
    const items = Array.from({ length: 3 }, (_unused, index) => ({ id: index }));
    const shaped = shapeToolOutput(items, { requestedLimit: 3 });
    expect(shaped.limitReached).toBe(true);
    expect(shaped.text).toMatch(/^NOTE ON COMPLETENESS:/);
    expect(shaped.text).toContain('no pagination mechanism whatsoever');
    // The payload still follows the note, and still parses.
    expect(JSON.parse(shaped.text.slice(shaped.text.indexOf('[')))).toEqual(items);
  });

  it('does not disclose completeness for a single object, which has no count', () => {
    const shaped = shapeToolOutput({ id: 'a' }, { requestedLimit: 1 });
    expect(shaped.limitReached).toBe(false);
    expect(shaped.text).toBe('{"id":"a"}');
  });

  it('applies the projection before the budget so the projection can save the payload', () => {
    const items = Array.from({ length: 20 }, (_unused, index) => ({
      id: index,
      blob: 'x'.repeat(500),
    }));
    const projected = shapeToolOutput(items, { maxChars: 2_000, fields: ['id'] });
    expect(projected.budgetTruncated).toBe(false);
    expect(projected.text).not.toContain('blob');

    const unprojected = shapeToolOutput(items, { maxChars: 2_000 });
    expect(unprojected.budgetTruncated).toBe(true);
  });

  it('sheds whole array items so every surviving item parses', () => {
    const items = Array.from({ length: 50 }, (_unused, index) => ({
      id: index,
      blob: 'x'.repeat(100),
    }));
    const shaped = shapeToolOutput(items, { maxChars: 1_200 });
    expect(shaped.budgetTruncated).toBe(true);
    expect(shaped.droppedItems).toBeGreaterThan(0);

    const payload = shaped.text.slice(shaped.text.indexOf('['));
    const parsed: unknown = JSON.parse(payload);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(50 - shaped.droppedItems);
    // Nothing partial survived: the last item is a whole object.
    expect((parsed as { blob: string }[]).at(-1)?.blob).toHaveLength(100);
  });

  it('discloses budget truncation with the count, never silently', () => {
    const items = Array.from({ length: 50 }, (_unused, index) => ({
      id: index,
      blob: 'x'.repeat(100),
    }));
    const shaped = shapeToolOutput(items, { maxChars: 1_200 });
    expect(shaped.text).toContain('NOTE ON TRUNCATION:');
    expect(shaped.text).toContain(`${String(shaped.droppedItems)} of 50 items were dropped`);
  });

  it('drops every item when even one will not fit, and says so', () => {
    const shaped = shapeToolOutput([{ blob: 'x'.repeat(5_000) }], { maxChars: 100 });
    expect(shaped.droppedItems).toBe(1);
    expect(shaped.text).toContain('1 of 1 items were dropped');
    expect(shaped.text).toContain('[]');
  });

  it('hard-truncates a single oversized object and warns the JSON will not parse', () => {
    const shaped = shapeToolOutput({ blob: 'x'.repeat(5_000) }, { maxChars: 200 });
    expect(shaped.budgetTruncated).toBe(true);
    expect(shaped.droppedItems).toBe(0);
    expect(shaped.text).toContain('the JSON below is INCOMPLETE and may not parse');
    expect(shaped.text).toContain('fields projection');
  });

  it('reports both disclosures when a list is both limit-length and over budget', () => {
    const items = Array.from({ length: 10 }, (_unused, index) => ({
      id: index,
      blob: 'x'.repeat(200),
    }));
    const shaped = shapeToolOutput(items, { maxChars: 900, requestedLimit: 10 });
    expect(shaped.limitReached).toBe(true);
    expect(shaped.budgetTruncated).toBe(true);
    expect(shaped.text).toContain('NOTE ON COMPLETENESS:');
    expect(shaped.text).toContain('NOTE ON TRUNCATION:');
  });

  /**
   * Finding B2, first half. The two notes were generated independently, so a
   * response could carry "To see more, re-run with a higher limit" and "Re-run
   * with a smaller limit" side by side. A model following the first gets FEWER
   * records — the budget sheds what the larger limit fetched — and there is no
   * pagination to recover with.
   */
  it('never gives contradictory advice when both disclosures fire at once', () => {
    const items = Array.from({ length: 10 }, (_unused, index) => ({
      id: index,
      blob: 'x'.repeat(200),
    }));
    const shaped = shapeToolOutput(items, { maxChars: 900, requestedLimit: 10 });

    expect(shaped.text).toContain('NOTE ON COMPLETENESS:');
    expect(shaped.text).toContain('NOTE ON TRUNCATION:');
    // The completeness note must not recommend raising the limit here.
    expect(shaped.text).not.toContain('re-run with a higher limit');
    expect(shaped.text).toContain('A higher limit will NOT help');
    // And it must point at the remedies that do work.
    expect(shaped.text).toContain('fields');
    expect(shaped.text).toContain('LUMICS_MAX_OUTPUT_CHARS');
  });

  it('still recommends a higher limit when the budget was NOT the constraint', () => {
    const shaped = shapeToolOutput([{ id: 1 }, { id: 2 }], { maxChars: 10_000, requestedLimit: 2 });
    expect(shaped.budgetTruncated).toBe(false);
    expect(shaped.text).toContain('re-run with a higher limit');
    expect(shaped.text).not.toContain('A higher limit will NOT help');
  });

  it('listCompletenessNote takes the budget flag directly, so the rule is unit-testable', () => {
    const clean = listCompletenessNote(5, 5, false) ?? '';
    const truncated = listCompletenessNote(5, 5, true) ?? '';
    expect(clean).toContain('re-run with a higher limit');
    expect(truncated).not.toContain('re-run with a higher limit');
    // Both still say the thing that must never be dropped.
    for (const note of [clean, truncated]) {
      expect(note).toContain('no pagination mechanism whatsoever');
      expect(note).toContain('Do NOT');
    }
  });

  it('keeps caller-supplied notes ahead of the payload and in order', () => {
    const shaped = shapeToolOutput([{ id: 1 }], { notes: ['FIRST NOTE.', 'SECOND NOTE.'] });
    expect(shaped.text.indexOf('FIRST NOTE.')).toBeLessThan(shaped.text.indexOf('SECOND NOTE.'));
    expect(shaped.text.indexOf('SECOND NOTE.')).toBeLessThan(shaped.text.indexOf('['));
  });

  it('does not mutate the caller notes array', () => {
    const notes = ['ONE.'];
    shapeToolOutput(
      Array.from({ length: 5 }, () => ({})),
      { notes, requestedLimit: 5 },
    );
    expect(notes).toEqual(['ONE.']);
  });

  it('defaults the budget to the configured default when none is supplied', () => {
    const shaped = shapeToolOutput({ blob: 'x'.repeat(DEFAULT_MAX_OUTPUT_CHARS + 100) });
    expect(shaped.budgetTruncated).toBe(true);
    expect(shaped.text).toContain(String(DEFAULT_MAX_OUTPUT_CHARS));
  });
});

/**
 * `LUMICS_MAX_OUTPUT_CHARS` is documented as a cap on tool output, and it has to
 * be one. The payload used to be fitted to `maxChars` and the disclosure notes
 * prepended afterwards, so the returned text always exceeded the budget by the
 * length of the notes — measured at +112% on a 1,000-character budget, which is
 * the smallest value the configuration allows and therefore exactly where an
 * operator economising is worst served.
 *
 * The rule the fix implements: notes and payload share one budget, notes are
 * reserved first, and a disclosure is never dropped or shortened to make room —
 * if the notes alone fill the budget the payload goes to nothing instead.
 */
describe('maxChars caps the whole response, notes included', () => {
  const rows = (count: number, blob = 80): readonly unknown[] =>
    Array.from({ length: count }, (_unused, index) => ({ id: index, blob: 'x'.repeat(blob) }));

  it.each([1_000, 5_000, 25_000])(
    'fits the payload and its truncation disclosure inside a %i-character budget',
    (maxChars) => {
      const shaped = shapeToolOutput(rows(600), { maxChars });
      expect(shaped.budgetTruncated).toBe(true);
      expect(shaped.text.length).toBeLessThanOrEqual(maxChars);
    },
  );

  it.each([5_000, 25_000])('fits BOTH disclosures inside a %i-character budget', (maxChars) => {
    const shaped = shapeToolOutput(rows(600), { maxChars, requestedLimit: 600 });
    expect(shaped.limitReached).toBe(true);
    expect(shaped.budgetTruncated).toBe(true);
    expect(shaped.text).toContain('NOTE ON COMPLETENESS:');
    expect(shaped.text).toContain('NOTE ON TRUNCATION:');
    expect(shaped.text.length).toBeLessThanOrEqual(maxChars);
  });

  it('emits the disclosures in full at the smallest configurable budget', () => {
    const shaped = shapeToolOutput(rows(600), {
      maxChars: MIN_MAX_OUTPUT_CHARS,
      requestedLimit: 600,
    });
    // Both disclosures together are longer than the whole budget, so they are
    // what survives and the payload is what goes — never the other way round.
    expect(shaped.text).toContain('NOTE ON COMPLETENESS:');
    expect(shaped.text).toContain('NOTE ON TRUNCATION:');
    expect(shaped.droppedItems).toBe(600);
    // Everything except a two-character empty array is disclosure text, which is
    // the only case where the output may exceed the budget.
    expect(shaped.text.endsWith('\n\n[]')).toBe(true);
  });

  it('counts caller-supplied notes against the same budget', () => {
    const notes = ['A CALLER NOTE. ' + 'y'.repeat(600), 'A SECOND CALLER NOTE.'];
    const shaped = shapeToolOutput(rows(200), { maxChars: 2_000, notes });
    expect(shaped.text.length).toBeLessThanOrEqual(2_000);
    // The notes are still there in full: nothing was shortened to fit.
    for (const note of notes) {
      expect(shaped.text).toContain(note);
    }
  });

  it('caps a hard-truncated single object too', () => {
    const shaped = shapeToolOutput(
      { blob: 'x'.repeat(50_000) },
      { maxChars: 1_000, notes: ['A CALLER NOTE.'] },
    );
    expect(shaped.budgetTruncated).toBe(true);
    expect(shaped.text.length).toBeLessThanOrEqual(1_000);
    expect(shaped.text).toContain('A CALLER NOTE.');
    expect(shaped.text).toContain('INCOMPLETE and may not parse');
  });

  it('keeps every disclosure and empties the payload when the notes fill the budget', () => {
    const huge = 'A LONG CALLER DISCLOSURE. ' + 'z'.repeat(1_500);
    const shaped = shapeToolOutput(rows(50), {
      maxChars: 1_000,
      notes: [huge],
      requestedLimit: 50,
    });

    // The disclosures survive intact — that is the property that outranks the cap.
    expect(shaped.text).toContain(huge);
    expect(shaped.text).toContain('NOTE ON COMPLETENESS:');
    expect(shaped.text).toContain('NOTE ON TRUNCATION:');
    // And the payload, not a disclosure, is what was given up.
    expect(shaped.droppedItems).toBe(50);
    expect(shaped.text.endsWith('[]')).toBe(true);
  });

  it('still fits everything when the whole response is comfortably inside the budget', () => {
    const shaped = shapeToolOutput([{ id: 1 }], { maxChars: 1_000, notes: ['SHORT NOTE.'] });
    expect(shaped.budgetTruncated).toBe(false);
    expect(shaped.text).toBe('SHORT NOTE.\n\n[{"id":1}]');
  });

  it('reports a dropped count that matches the payload it actually emitted', () => {
    const items = rows(200);
    const shaped = shapeToolOutput(items, { maxChars: 1_000 });
    const payload = JSON.parse(shaped.text.slice(shaped.text.indexOf('['))) as unknown[];
    expect(payload.length).toBe(items.length - shaped.droppedItems);
    expect(shaped.text).toContain(`${String(shaped.droppedItems)} of 200 items were dropped`);
  });
});

/**
 * Finding H4's shedding half. `shapeToolOutput` can only drop items when the
 * payload's top level is an array; a keyed object gets hard-truncated into JSON
 * that does not parse. `lumics_get_metric_summary` returns a keyed object whenever
 * Lumics reports more than one item class (spec §12.4), so it needs this.
 */
describe('fitKeyedArraysToBudget', () => {
  const wide = (count: number, blob = 100): readonly unknown[] =>
    Array.from({ length: count }, (_unused, index) => ({ id: index, blob: 'x'.repeat(blob) }));

  it('returns the input untouched when it already fits', () => {
    const classes = { devices: wide(2) };
    const fitted = fitKeyedArraysToBudget(classes, 100_000);
    expect(fitted.value).toBe(classes);
    expect(fitted.dropped).toBe(0);
    expect(fitted.total).toBe(2);
  });

  it('sheds from the end of each class and reports the count', () => {
    const fitted = fitKeyedArraysToBudget({ devices: wide(50), pools: wide(50) }, 2_000);
    expect(fitted.dropped).toBeGreaterThan(0);
    expect(fitted.total).toBe(100);
    expect(toCompactJson(fitted.value).length).toBeLessThanOrEqual(2_000);
  });

  it('keeps every surviving item complete and parseable', () => {
    const fitted = fitKeyedArraysToBudget({ devices: wide(50), pools: wide(50) }, 2_000);
    const reparsed = JSON.parse(toCompactJson(fitted.value)) as Record<string, unknown[]>;
    expect(Object.keys(reparsed).sort()).toEqual(['devices', 'pools']);
    for (const items of Object.values(reparsed)) {
      for (const item of items) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('blob');
      }
    }
  });

  it('trims classes evenly rather than emptying one to save another', () => {
    const fitted = fitKeyedArraysToBudget({ devices: wide(40), pools: wide(40) }, 3_000);
    const counts = Object.values(fitted.value).map((items) => items.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });

  it('keeps every key present even when nothing fits, so the shape stays honest', () => {
    const fitted = fitKeyedArraysToBudget(
      { devices: wide(5, 5_000), pools: wide(5, 5_000) },
      1_000,
    );
    expect(Object.keys(fitted.value).sort()).toEqual(['devices', 'pools']);
    expect(fitted.dropped).toBe(10);
  });

  it('handles an empty object', () => {
    const fitted = fitKeyedArraysToBudget({}, 1_000);
    expect(fitted.total).toBe(0);
    expect(fitted.dropped).toBe(0);
  });
});

/**
 * The negative assertion, stated once and applied broadly. If a future change
 * adds paging metadata anywhere in the shaping path, every case here fails.
 */
describe('no fabricated pagination is ever emitted (spec section 4.3)', () => {
  const inputs: readonly { readonly label: string; readonly run: () => string }[] = [
    { label: 'empty array at limit', run: () => shapeToolOutput([], { requestedLimit: 0 }).text },
    {
      label: 'empty array under limit',
      run: () => shapeToolOutput([], { requestedLimit: 100 }).text,
    },
    {
      label: 'array exactly at limit',
      run: () => shapeToolOutput([{ id: 1 }, { id: 2 }], { requestedLimit: 2 }).text,
    },
    {
      label: 'array over limit',
      run: () => shapeToolOutput([{ id: 1 }, { id: 2 }], { requestedLimit: 1 }).text,
    },
    { label: 'array with no limit', run: () => shapeToolOutput([{ id: 1 }]).text },
    { label: 'single object', run: () => shapeToolOutput({ id: 1 }, { requestedLimit: 1 }).text },
    { label: 'null', run: () => shapeToolOutput(null, { requestedLimit: 1 }).text },
    { label: 'undefined', run: () => shapeToolOutput(undefined).text },
    { label: 'string payload', run: () => shapeToolOutput('text', { requestedLimit: 1 }).text },
    { label: 'number payload', run: () => shapeToolOutput(42).text },
    {
      label: 'budget-truncated array',
      run: () =>
        shapeToolOutput(
          Array.from({ length: 40 }, (_unused, index) => ({ id: index, blob: 'x'.repeat(200) })),
          { maxChars: 900, requestedLimit: 40 },
        ).text,
    },
    {
      label: 'budget-truncated single object',
      run: () => shapeToolOutput({ blob: 'x'.repeat(4_000) }, { maxChars: 100 }).text,
    },
    {
      label: 'projected array at limit',
      run: () => shapeToolOutput([{ id: 1, drop: 1 }], { requestedLimit: 1, fields: ['id'] }).text,
    },
    {
      label: 'nested object keyed by class (metrics/summaries shape)',
      run: () => shapeToolOutput({ devices: [{ id: 1 }] }, { requestedLimit: 1 }).text,
    },
  ];

  it.each(inputs.map((input) => [input.label, input] as const))(
    'emits no offset/has_more/next_offset/page/total key for %s',
    (_label, input: (typeof inputs)[number]) => {
      expectNoPaginationKeys(input.run());
    },
  );

  it('does not invent a pagination key even when the payload itself contains one', () => {
    // A payload key named `total` is the API's data, not our metadata. It must
    // survive verbatim — the rule is that *we* never synthesise one.
    const shaped = shapeToolOutput([{ id: 1, total: 5 }], { requestedLimit: 1 });
    expect(shaped.text).toContain('"total":5');
    // But no top-level envelope was added around it.
    expect(shaped.text.slice(shaped.text.indexOf('['))).toBe('[{"id":1,"total":5}]');
  });
});
