/**
 * Newline-delimited JSON parsing for the two suites that spawn the built server
 * as a real child process (`tests/installation` and `tests/security`).
 *
 * Both suites poll the child's accumulated stdout on a timer while the child is
 * still writing to it, then parse what they have so far to decide whether the
 * response they are waiting for has arrived. That means the buffer is routinely
 * observed mid-frame — `tools/list` is roughly 36KB, comfortably larger than a
 * pipe chunk — and a naive parse of the trailing fragment throws
 * `SyntaxError: Unterminated string in JSON`.
 *
 * That failure is a race in the harness, not a defect in the server, and it
 * failed CI intermittently on `main`. Both suites had their own copy of the
 * parser and so had their own copy of the bug; this module exists so there is
 * one implementation to get right.
 *
 * **Failing loudly on genuinely bad output is the point** and is preserved. A
 * stray `console.log` on the protocol channel is the exact defect these suites
 * exist to catch. Stray output arrives through `console.*`, which terminates its
 * line, so it is followed by a newline, is parsed, and still throws. What is
 * skipped is only an unterminated final fragment — and a frame is unterminated
 * only because it has not finished arriving.
 */

/**
 * The prefix of `buffer` that is known to be complete: everything up to and
 * including the last newline. Returns `''` when no line has terminated yet.
 */
export function completeLines(buffer: string): string {
  const lastNewline = buffer.lastIndexOf('\n');
  return lastNewline === -1 ? '' : buffer.slice(0, lastNewline + 1);
}

/**
 * Parse every complete line of `buffer` as JSON, throwing on any that is not.
 *
 * `predicate` filters which lines are expected to be JSON at all. stdout is the
 * protocol channel and must carry nothing else, so it passes no predicate and
 * every line must parse. stderr is human-readable diagnostics interleaved with
 * structured records, so it passes one that selects the structured lines.
 */
export function parseNdjson<T>(buffer: string, predicate?: (line: string) => boolean): T[] {
  return completeLines(buffer)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => predicate?.(line) ?? true)
    .map((line) => JSON.parse(line) as T);
}

/** Selects the structured log records on stderr, ignoring any plain prose. */
export const isStructuredRecord = (line: string): boolean => line.startsWith('{');
