/**
 * Shared assertions for the per-resource integration tests.
 *
 * Each tool module is tested the same way: drive the real registered tool over
 * an in-memory transport, then assert the exact request the injected fetch saw
 * (method, path, query, body) and that the vendor envelope was unwrapped. Keeping
 * the shared shape here means a new resource is a table entry rather than another
 * 200 lines of copy-paste.
 */

import { expect } from 'vitest';
import type { LumicsConfig } from '../../src/config.js';
import { makeConfig } from './config.js';
import { connect, notesOf, payloadOf, type Harness } from './mcp.js';
import { jsonResponse, recordFetch, type FetchRecorder, type RecordedCall } from './fetch.js';

export interface Exchange {
  readonly call: RecordedCall;
  readonly calls: readonly RecordedCall[];
  readonly text: string;
  readonly payload: unknown;
  readonly notes: string;
}

/**
 * Call one tool with a stubbed response and return both sides of the exchange.
 * Fails the test if the tool returned an error result, so a typo in an argument
 * surfaces as "tool errored" rather than as a confusing empty assertion.
 */
export async function exchange(
  tool: string,
  args: Record<string, unknown>,
  response: unknown,
  options: { readonly config?: LumicsConfig } = {},
): Promise<Exchange> {
  const fetcher: FetchRecorder = recordFetch(jsonResponse(response));
  const harness: Harness = await connect(options.config ?? makeConfig(), {
    clientOptions: { fetchImpl: fetcher.fetchImpl },
  });

  try {
    const called = await harness.call(tool, args);
    if (called.isError === true) {
      const block = called.content[0];
      throw new Error(
        `${tool} returned an error result: ${block?.type === 'text' ? block.text : '?'}`,
      );
    }
    const text = called.content[0]?.type === 'text' ? called.content[0].text : '';
    return {
      call: fetcher.only(),
      calls: fetcher.calls,
      text,
      payload: payloadOf(text),
      notes: notesOf(text),
    };
  } finally {
    await harness.close();
  }
}

/** Call one tool expecting failure, and return the error text plus the request log. */
export async function failingExchange(
  tool: string,
  args: Record<string, unknown>,
  response: unknown = {},
  options: { readonly config?: LumicsConfig } = {},
): Promise<{ readonly text: string; readonly calls: readonly RecordedCall[] }> {
  const fetcher = recordFetch(jsonResponse(response));
  const harness = await connect(options.config ?? makeConfig(), {
    clientOptions: { fetchImpl: fetcher.fetchImpl },
  });
  try {
    const called = await harness.call(tool, args);
    expect(called.isError, `${tool} was expected to fail`).toBe(true);
    const block = called.content[0];
    return { text: block?.type === 'text' ? block.text : '', calls: fetcher.calls };
  } finally {
    await harness.close();
  }
}

/** Keys the API does not have. Asserted absent from every tool output. */
export const FORBIDDEN_PAGINATION_KEYS = [
  'offset',
  'has_more',
  'hasMore',
  'next_offset',
  'nextOffset',
  'page',
  'total',
  'cursor',
  'skip',
  'after',
] as const;

/** Assert no fabricated pagination key appears anywhere in a tool's output. */
export function expectNoFabricatedPagination(text: string): void {
  for (const key of FORBIDDEN_PAGINATION_KEYS) {
    expect(text, `output must never carry a "${key}" key`).not.toMatch(new RegExp(`"${key}"\\s*:`));
  }
}

/** Assert the request carried none of the parameters the API does not accept. */
export function expectNoFabricatedQueryParams(call: RecordedCall): void {
  for (const parameter of ['offset', 'page', 'skip', 'cursor', 'after', 'sort', 'order']) {
    expect(
      call.url.searchParams.has(parameter),
      `request must not send a "${parameter}" parameter — the API has none`,
    ).toBe(false);
  }
}
