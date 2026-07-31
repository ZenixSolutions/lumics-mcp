/**
 * Tests for the harness's own newline-delimited JSON parser.
 *
 * This parser is not product code, but it gates two suites that verify a
 * security-relevant property — that stdout carries nothing but JSON-RPC frames —
 * and it failed CI intermittently on `main` by throwing on a frame that had not
 * finished arriving. The tolerance that fixes that is exactly the kind of change
 * that could be widened later into hiding the defect the suites exist to catch,
 * so the boundary is pinned here.
 */

import { describe, expect, it } from 'vitest';

import { completeLines, isStructuredRecord, parseNdjson } from '../helpers/ndjson.js';

interface Frame {
  readonly jsonrpc: string;
  readonly id?: number;
}

const frame = (id: number): string => `${JSON.stringify({ jsonrpc: '2.0', id, result: {} })}\n`;

describe('completeLines', () => {
  it('returns everything up to and including the last newline', () => {
    expect(completeLines('a\nb\nc')).toBe('a\nb\n');
  });

  it('returns the whole buffer when it ends on a newline', () => {
    expect(completeLines('a\nb\n')).toBe('a\nb\n');
  });

  it('returns nothing when no line has terminated yet', () => {
    expect(completeLines('{"jsonrpc":"2.0"')).toBe('');
  });

  it('returns nothing for an empty buffer', () => {
    expect(completeLines('')).toBe('');
  });
});

describe('parseNdjson', () => {
  it('parses a well-formed buffer', () => {
    expect(parseNdjson<Frame>(`${frame(1)}${frame(2)}${frame(3)}`)).toHaveLength(3);
  });

  it('ignores a trailing frame that has not finished arriving', () => {
    // The exact shape that failed CI on Node 22: two complete frames, then a
    // third still mid-write, as observed by the 100ms poll while the child runs.
    const partial = `${frame(1)}${frame(2)}{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"lumics_`;
    expect(() => parseNdjson<Frame>(partial)).not.toThrow();
    expect(parseNdjson<Frame>(partial)).toHaveLength(2);
  });

  it('splits a frame at any byte without throwing', () => {
    // Whatever offset the pipe chunks at, the result is the completed prefix.
    const whole = `${frame(1)}${frame(2)}`;
    for (let cut = 0; cut <= whole.length; cut += 1) {
      const prefix = whole.slice(0, cut);
      expect(() => parseNdjson<Frame>(prefix)).not.toThrow();
      expect(parseNdjson<Frame>(prefix).length).toBeLessThanOrEqual(2);
    }
  });

  // The control this must not weaken.
  it('still throws on a complete line that is not JSON', () => {
    expect(() => parseNdjson<Frame>(`${frame(1)}oops I logged to stdout\n`)).toThrow(SyntaxError);
  });

  it('still throws when the stray line is the last complete one', () => {
    expect(() => parseNdjson<Frame>(`${frame(1)}stray\n${frame(2)}`)).toThrow(SyntaxError);
  });

  it('ignores blank and whitespace-only lines', () => {
    expect(parseNdjson<Frame>(`${frame(1)}\n   \n${frame(2)}`)).toHaveLength(2);
  });

  it('applies the predicate before parsing, so non-JSON prose on stderr is skipped', () => {
    const stderr = `plain prose a client may print\n${JSON.stringify({ msg: 'built' })}\n`;
    expect(parseNdjson<{ msg: string }>(stderr, isStructuredRecord)).toEqual([{ msg: 'built' }]);
  });

  it('still throws on a malformed line that the predicate selects', () => {
    expect(() => parseNdjson(`{not valid json\n`, isStructuredRecord)).toThrow(SyntaxError);
  });
});
