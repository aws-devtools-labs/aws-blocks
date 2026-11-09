// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/core';
import { AppSettingErrors } from '@aws-blocks/bb-app-setting';
import type { api as apiType } from 'aws-blocks';

export function appSettingTests(getApi: () => typeof apiType) {
  describe('AppSetting BB', () => {

    test('AppSetting - string setting returns initial value', async () => {
      const api = getApi();
      const { value } = await api.settingGetString();
      assert.strictEqual(value, 'https://api.example.com');
    });

    test('AppSetting - string setting put then get returns updated value', async () => {
      const api = getApi();
      await api.settingPutString('https://new-api.example.com');
      const { value } = await api.settingGetString();
      assert.strictEqual(value, 'https://new-api.example.com');
      // Restore original
      await api.settingPutString('https://api.example.com');
    });

    test('AppSetting - typed setting returns initial object', async () => {
      const api = getApi();
      const config = await api.settingGetTyped();
      assert.deepStrictEqual(config, { maxRetries: 3, timeout: 5000 });
    });

    test('AppSetting - typed setting put then get returns updated object', async () => {
      const api = getApi();
      await api.settingPutTyped({ maxRetries: 10, timeout: 30000 });
      const config = await api.settingGetTyped();
      assert.deepStrictEqual(config, { maxRetries: 10, timeout: 30000 });
      // Restore original
      await api.settingPutTyped({ maxRetries: 3, timeout: 5000 });
    });

    test('AppSetting - typed setting rejects invalid value', async () => {
      const api = getApi();
      await assert.rejects(
        () => api.settingPutTypedInvalid({ wrong: 'field' }),
        // Assert the rejection round-trips as a *branded* BB error over the
        // wire (so isBlocksError matches), not merely a message substring —
        // the wire sanitizer drops the raw message but preserves the name.
        (e: unknown) => isBlocksError(e, AppSettingErrors.ValidationFailed),
      );
    });

    test('AppSetting - numeric value round-trips without schema', async () => {
      const api = getApi();
      await api.settingPutNumber(0.7);
      const { value } = await api.settingGetNumber();
      assert.strictEqual(value, 0.7);
      assert.strictEqual(typeof value, 'number');
    });

    test('AppSetting - secret setting returns a non-empty value', async () => {
      const api = getApi();
      const { value } = await api.settingGetSecret();
      assert.ok(typeof value === 'string');
      assert.ok(value.length > 0);
    });

    test('AppSetting - secret setting put then get returns updated value', async () => {
      const api = getApi();
      const original = (await api.settingGetSecret()).value;
      await api.settingPutSecret('my-real-api-key');
      const { value } = await api.settingGetSecret();
      assert.strictEqual(value, 'my-real-api-key');
      // Restore original
      await api.settingPutSecret(original);
    });
  });
}
