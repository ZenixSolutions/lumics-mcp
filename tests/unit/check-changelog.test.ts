/**
 * Tests for the release gate in `scripts/check-changelog.mjs`.
 *
 * `release.yml` used to verify only that a heading for the tagged version
 * existed. A section can satisfy that and still be unfinished, and one was:
 * `0.1.0` published to npm with its section opening "Nothing below has shipped
 * yet; this section is the release note under construction and is finalised at
 * tag time." `CHANGELOG.md` ships inside the tarball, so the release told the
 * registry it had not happened. Issue #10.
 *
 * These run the script as a subprocess rather than importing it. That is
 * deliberate: what `release.yml` depends on is the CLI contract — exit status
 * and `::error` output — not an internal function, and `scripts/` is outside
 * every tsconfig in the repository. Testing the real interface also means a
 * refactor that broke argument handling would be caught.
 *
 * The first case is the one that matters: the actual text that shipped in
 * `0.1.0`, verbatim, must fail.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'check-changelog.mjs');

interface Result {
  readonly code: number;
  readonly output: string;
}

/** Write `text` to a scratch CHANGELOG and run the gate against it. */
function check(text: string, version: string): Result {
  const file = join(mkdtempSync(join(tmpdir(), 'changelog-')), 'CHANGELOG.md');
  writeFileSync(file, text, 'utf8');
  try {
    const output = execFileSync(process.execPath, [SCRIPT, version, file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const LINK = '[1.0.0]: https://github.com/ZenixSolutions/lumics-mcp/compare/v0.9.0...v1.0.0\n';
const good = (body: string): string =>
  `# Changelog\n\n## [1.0.0] - 2026-07-31\n\n${body}\n\n${LINK}`;

describe('the changelog release gate', () => {
  it('REGRESSION: rejects the exact text that shipped in 0.1.0', () => {
    // Verbatim from the published 0.1.0 tarball.
    const shipped = [
      '# Changelog',
      '',
      'Note that while the version is below `1.0.0`, the tool surface is not yet stable.',
      '',
      '## [1.0.0] - 2026-07-30',
      '',
      'First release. Nothing below has shipped yet; this section is the release note under construction',
      'and is finalised at tag time.',
      '',
      '### Added',
      '',
      '- A thing.',
      '',
      LINK,
    ].join('\n');

    const result = check(shipped, '1.0.0');
    expect(result.code).toBe(1);
    expect(result.output).toContain('nothing below has shipped');
    expect(result.output).toContain('under construction');
    expect(result.output).toContain('finalised at tag time');
  });

  it('accepts a finalised section', () => {
    const result = check(good('### Added\n\n- Something a user can read.'), '1.0.0');
    expect(result.code).toBe(0);
    expect(result.output).toContain('is finalised');
  });

  it('rejects a missing section', () => {
    const result = check(good('### Added\n\n- Something.'), '2.0.0');
    expect(result.code).toBe(1);
    expect(result.output).toContain('no section for 2.0.0');
  });

  it('rejects an undated heading', () => {
    const result = check(`# Changelog\n\n## [1.0.0]\n\n### Added\n\n- Thing.\n\n${LINK}`, '1.0.0');
    expect(result.code).toBe(1);
    expect(result.output).toContain('YYYY-MM-DD');
  });

  it('rejects a heading still marked Unreleased', () => {
    const result = check(
      `# Changelog\n\n## [1.0.0] - Unreleased\n\n### Added\n\n- Thing.\n\n${LINK}`,
      '1.0.0',
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('YYYY-MM-DD');
  });

  it('rejects an empty section', () => {
    const result = check(
      `# Changelog\n\n## [1.0.0] - 2026-07-31\n\n## [0.9.0] - 2026-01-01\n\nOld.\n\n${LINK}`,
      '1.0.0',
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('is empty');
  });

  it('rejects a missing comparison link', () => {
    const result = check(
      '# Changelog\n\n## [1.0.0] - 2026-07-31\n\n### Added\n\n- Thing.\n',
      '1.0.0',
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('no comparison link');
  });

  it('accepts a leading v on the version argument, as release.yml passes the tag', () => {
    // release.yml hands it GITHUB_REF_NAME, which is "v1.0.0".
    const result = check(good('### Added\n\n- Thing.'), 'v1.0.0');
    expect(result.code).toBe(0);
  });

  // The false positives that made a naive phrase list unusable here.
  it('does not fire on wording outside the version section', () => {
    // "not yet stable" lives in the file preamble, and an [Unreleased] heading
    // sits above the released section. Neither is a defect, and an earlier
    // whole-file scan would have failed every release on both.
    const text = [
      '# Changelog',
      '',
      'While the version is below `1.0.0`, the tool surface is not yet stable.',
      '',
      '## [Unreleased]',
      '',
      '### Changed',
      '',
      '- Something pending, described as TODO by its author.',
      '',
      '## [1.0.0] - 2026-07-31',
      '',
      '### Added',
      '',
      '- A finished note.',
      '',
      LINK,
    ].join('\n');

    const result = check(text, '1.0.0');
    expect(result.code).toBe(0);
  });

  it('stops at the next version heading rather than scanning to the end of the file', () => {
    const text = [
      '# Changelog',
      '',
      '## [1.0.0] - 2026-07-31',
      '',
      '### Added',
      '',
      '- A finished note.',
      '',
      '## [0.9.0] - 2026-01-01',
      '',
      'This older section is under construction and must not fail 1.0.0.',
      '',
      LINK,
    ].join('\n');

    const result = check(text, '1.0.0');
    expect(result.code).toBe(0);
  });

  // Quoting a banned phrase is not using it. The gate failed its own 0.1.2
  // release on exactly this, because the entry describing the gate quotes the
  // wording the gate bans.
  it('does not fire on a scaffolding phrase inside double quotes, across lines', () => {
    const text = [
      '# Changelog',
      '',
      '## [1.0.0] - 2026-07-31',
      '',
      '### Added',
      '',
      '- A release gate. The previous check missed it, and `0.9.0` published with "Nothing below',
      '  has shipped yet; this section is the release note under construction and is finalised at',
      '  tag time" still in it.',
      '',
      LINK,
    ].join('\n');

    const result = check(text, '1.0.0');
    expect(result.code).toBe(0);
  });

  it('does not fire on a phrase in inline code, a fence, or a blockquote', () => {
    const text = [
      '# Changelog',
      '',
      '## [1.0.0] - 2026-07-31',
      '',
      '### Added',
      '',
      '- A gate that rejects `under construction` in a section body.',
      '',
      '  > It rejected: TBD',
      '',
      '  ```',
      '  TODO: finish this',
      '  ```',
      '',
      LINK,
    ].join('\n');

    const result = check(text, '1.0.0');
    expect(result.code).toBe(0);
  });

  // The carve-out must not become a hole.
  it('still fires when the phrase is unquoted in the same section as a quoted one', () => {
    const text = [
      '# Changelog',
      '',
      '## [1.0.0] - 2026-07-31',
      '',
      '### Added',
      '',
      '- A gate. It rejected "under construction" last time.',
      '- This entry is still to be written.',
      '',
      LINK,
    ].join('\n');

    const result = check(text, '1.0.0');
    expect(result.code).toBe(1);
    expect(result.output).toContain('to be written');
  });

  it('exits 2 with usage when given no version, rather than passing vacuously', () => {
    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      code = (error as { status?: number }).status ?? -1;
    }
    expect(code).toBe(2);
  });
});
