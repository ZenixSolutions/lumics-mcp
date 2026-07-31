/**
 * `SERVER_VERSION` must equal `package.json`'s `version`.
 *
 * This is not housekeeping. `SERVER_VERSION` is what the server reports through
 * the MCP `initialize` handshake, the `--version` flag and the startup log line
 * — the only three ways anyone can tell which build they are running. It is kept
 * in step by hand because reading `package.json` at runtime would need
 * `resolveJsonModule` output in `dist/` and would break the published `bin`
 * shim, and that hand step is exactly the kind that gets skipped.
 *
 * It was skipped. `0.1.1` bumped `package.json`, left this constant at `0.1.0`,
 * and the mismatch reached `dist/`. A user upgrading to escape the IPAM write
 * defect (#17) would have reported version `0.1.0` — the broken release — and
 * neither they nor the maintainer could have told a fixed deployment from an
 * unfixed one, in the release where that distinction was the entire point.
 *
 * Nothing caught it: `release.yml` verifies the tag against `package.json` and
 * against `CHANGELOG.md`, but nothing verified the constant, so a `v0.1.1` tag
 * would have passed every guard and published.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SERVER_VERSION } from '../../src/constants.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function packageVersion(): string {
  const raw = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
  const version: unknown = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== 'string') {
    throw new TypeError('package.json has no string "version" field.');
  }
  return version;
}

describe('SERVER_VERSION is the version this package actually ships as', () => {
  it('equals package.json version', () => {
    expect(
      SERVER_VERSION,
      `SERVER_VERSION in src/constants.ts is "${SERVER_VERSION}" but package.json says "${packageVersion()}". They are kept in step by hand; update src/constants.ts. Everything the server tells a user about its own identity comes from the constant, so a mismatch means the released build misreports itself.`,
    ).toBe(packageVersion());
  });

  it('is a bare semver triple, matching the vX.Y.Z tag shape release.yml triggers on', () => {
    // release.yml fires on 'v*.*.*' and compares the tag to package.json with the
    // leading v stripped. A constant carrying a 'v' prefix or build metadata would
    // pass the equality test above only if package.json carried it too, which the
    // workflow would then reject — so pin the shape here where the message is clear.
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
