import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { BUILD_PROFILE_ENV, buildProfile, withBuildProfile } from './shared/build_profile.js';

void describe('buildProfile', () => {
  afterEach(() => {
    delete process.env[BUILD_PROFILE_ENV];
  });

  void it('is empty without the env var, or when it is not a JSON object', () => {
    assert.deepStrictEqual(buildProfile(), {});
    for (const raw of ['not json', '[1,2]', '"text"', '42', 'null']) {
      process.env[BUILD_PROFILE_ENV] = raw;
      assert.deepStrictEqual(buildProfile(), {}, raw);
    }
  });

  void it('round-trips what withBuildProfile writes', () => {
    const profile = {
      serverInvoke: 'http-api',
      edgeToRegional: true,
      skipIsr: true,
      skipImageOptimization: false,
      deterministicBuildId: 'fixed',
    } as const;
    assert.deepStrictEqual(
      withBuildProfile(profile, () => buildProfile()),
      profile,
    );
  });

  void it('keeps only known fields with the right type', () => {
    process.env[BUILD_PROFILE_ENV] = JSON.stringify({
      serverInvoke: 'grpc',
      edgeToRegional: 'yes',
      skipIsr: true,
      skipImageOptimization: 1,
      deterministicBuildId: 7,
      unknown: 'x',
    });
    assert.deepStrictEqual(buildProfile(), { skipIsr: true });
  });
});
