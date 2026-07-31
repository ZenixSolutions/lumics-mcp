/**
 * INSTALLATION: what `npm publish` would actually put on the registry.
 *
 * `package.json` `files` is the only thing standing between the working tree and
 * the published tarball, and it fails silently in both directions: a pattern
 * that is too narrow drops something consumers need, and one that is too broad
 * ships something they should never receive. Neither shows up in a normal test
 * run, because nothing else in this suite looks at the package.
 *
 * Both directions have already happened here.
 *
 *  - **Too broad.** 0.1.0 shipped 44 source maps — 181 KB, 24% of the unpacked
 *    size — that no debugger could resolve, because they point at `../src/*.ts`,
 *    carry no `sourcesContent`, and `src` is not in the package (issue #9). Every
 *    consumer downloaded them on every cold `npx` for a benefit nobody could
 *    collect. They are still emitted for local debugging and excluded from the
 *    tarball by a negated pattern.
 *
 *  - **Too narrow** is the failure this file guards against next: `dist/` is the
 *    whole product, and a `files` edit that dropped part of it would publish a
 *    package that cannot start, which no other test would notice.
 *
 * This asks npm what it would pack rather than inspecting the tree, so it tests
 * the same resolution `npm publish` performs, including negations and
 * `.npmignore` precedence.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILT = existsSync(resolve(REPO_ROOT, 'dist', 'index.js'));

/** One entry of `npm pack --dry-run --json`'s file list. */
interface PackedFile {
  readonly path: string;
}

function packedPaths(): string[] {
  // --json goes to stdout; npm's human-readable notices go to stderr, so they do
  // not need stripping. `execFileSync` rather than a shell: no quoting to get
  // wrong, and a non-zero exit throws rather than yielding an empty list that
  // would make every assertion below vacuously pass.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw) as { files?: PackedFile[] }[];
  const files = parsed[0]?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      'npm pack --dry-run --json returned no file list; the assertions below would be meaningless.',
    );
  }
  return files.map((file) => file.path);
}

describe.skipIf(!BUILT)('the published tarball contains what it should, and nothing else', () => {
  const paths = BUILT ? packedPaths() : [];

  it('ships no source maps — they are emitted for local use only (issue #9)', () => {
    const maps = paths.filter((path) => path.endsWith('.map'));
    expect(
      maps,
      `${maps.length} source map(s) would be published. They resolve to nothing on a consumer's disk: they point at ../src/*.ts, carry no sourcesContent, and src is not in the package. Keep the "!dist/**/*.map" entry in package.json files. If shipping debuggable maps is now wanted, that is a deliberate change — see issue #9 for the trade-off.`,
    ).toEqual([]);
  });

  it('ships the entry point, the server entry, and the type declarations', () => {
    // The three paths package.json names in bin, exports and types. If a files
    // edit drops any of them the package installs and cannot run.
    for (const required of ['dist/index.js', 'dist/server.js', 'dist/server.d.ts']) {
      expect(paths, `${required} is named in package.json but would not be published.`).toContain(
        required,
      );
    }
  });

  it('ships the documents a consumer reads on the registry page', () => {
    for (const required of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
      expect(paths).toContain(required);
    }
  });

  it('ships no credential-shaped file', () => {
    // .env is gitignored, so this guards the case where a stray file is created
    // in the working tree and swept in by a broadened pattern.
    const suspicious = paths.filter((path) =>
      /(^|\/)\.env($|\.)|\.pem$|\.key$|(^|\/)\.npmrc$/.test(path),
    );
    expect(
      suspicious,
      `these would be published and must not be: ${suspicious.join(', ')}. See SECURITY.md.`,
    ).toEqual([]);
  });

  it('ships no tests, sources or repository scaffolding', () => {
    const unwanted = paths.filter(
      (path) =>
        path.startsWith('tests/') ||
        path.startsWith('src/') ||
        path.startsWith('docs/') ||
        path.startsWith('.github/') ||
        path.endsWith('tsconfig.json'),
    );
    expect(
      unwanted,
      `these are development-only and would be published: ${unwanted.join(', ')}.`,
    ).toEqual([]);
  });

  it('publishes only from dist and the four named documents', () => {
    // The catch-all. Anything that is neither dist/ nor one of the documents is
    // something nobody decided to ship, which is the state this file exists to
    // make visible rather than to permit.
    const documents = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    const unexpected = paths.filter((path) => !path.startsWith('dist/') && !documents.has(path));
    expect(
      unexpected,
      `unexpected in the tarball: ${unexpected.join(', ')}. Add it to this list deliberately or exclude it in package.json files.`,
    ).toEqual([]);
  });
});

describe.skipIf(BUILT)('package-contents test skipped', () => {
  it('reports that dist/ is absent rather than passing silently', () => {
    expect(BUILT).toBe(false);
  });
});
