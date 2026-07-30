/**
 * Config builders for tests.
 *
 * Every credential in this file is an obvious placeholder. `TEST_TOKEN` is a
 * syntactically JWT-shaped string built from the word "placeholder" so a reader
 * can tell at a glance it is not real, and `TEST_COMPANY_ID` is 24 zeros.
 */

import type { LumicsConfig, RawEnv } from '../../src/config.js';

/**
 * JWT-shaped but obviously fake. Shaped like a JWT on purpose: the redaction
 * tests need something the `eyJ...` pattern matches.
 */
export const TEST_TOKEN = 'eyJwbGFjZWhvbGRlcg.eyJub3RhcmVhbHRva2Vu.cGxhY2Vob2xkZXJzaWc';

/** 24 zeros. A valid ObjectId shape that cannot collide with a real record. */
export const TEST_COMPANY_ID = '000000000000000000000000';

/** Distinct 24-hex ids for path assertions, all obviously synthetic. */
export const TEST_DEVICE_ID = '111111111111111111111111';
export const TEST_COLLECTOR_ID = '222222222222222222222222';
export const TEST_SUBNET_ID = '333333333333333333333333';
export const TEST_ADDRESS_ID = '444444444444444444444444';
export const TEST_GROUP_ID = '555555555555555555555555';
export const TEST_COMPONENT_ID = '666666666666666666666666';

export const TEST_BASE_URL = 'https://lumics.invalid/api/v1';

/** A frozen config with every field set, overridable per test. */
export function makeConfig(overrides: Partial<LumicsConfig> = {}): LumicsConfig {
  return Object.freeze({
    token: TEST_TOKEN,
    companyId: TEST_COMPANY_ID,
    // Off by default, matching `loadConfig`: a test that needs a second company
    // has to say so, which is what makes the cross-company pin testable.
    allowCrossCompany: false,
    baseUrl: TEST_BASE_URL,
    timeoutMs: 5_000,
    maxOutputChars: 25_000,
    readOnly: false,
    features: { batchUpdate: false, tokenRevocation: false },
    transport: 'stdio' as const,
    http: undefined,
    ...overrides,
  });
}

/** A minimal valid environment for `loadConfig`, overridable per test. */
export function makeEnv(overrides: RawEnv = {}): RawEnv {
  return {
    LUMICS_TOKEN: TEST_TOKEN,
    LUMICS_COMPANY_ID: TEST_COMPANY_ID,
    ...overrides,
  };
}
