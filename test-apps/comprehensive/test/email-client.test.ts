// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/core';
import { EmailErrors } from '@aws-blocks/bb-email-client';
import type { api as apiType } from 'aws-blocks';

export function emailClientTests(getApi: () => typeof apiType) {

  describe('EmailClient', () => {

    describe('send', () => {
      test('send single email returns messageId', async () => {
        const api = getApi();
        const result = await api.emailSend({
          to: 'success@simulator.amazonses.com',
          subject: 'Test email',
          body: 'Hello from e2e test',
        });
        assert.ok(result.messageId, 'Expected messageId to be returned');
        assert.strictEqual(typeof result.messageId, 'string');
        assert.ok(result.messageId.length > 0);
      });

      test('send HTML email', async () => {
        const api = getApi();
        const result = await api.emailSend({
          to: 'success@simulator.amazonses.com',
          subject: 'HTML Test',
          body: 'Plain text fallback',
          html: '<h1>Hello</h1><p>HTML content</p>',
        });
        assert.ok(result.messageId);
      });

      test('send to multiple recipients', async () => {
        const api = getApi();
        const result = await api.emailSend({
          to: [
            'success@simulator.amazonses.com',
            'success+2@simulator.amazonses.com',
          ],
          subject: 'Multi-recipient test',
          body: 'Sent to multiple recipients',
        });
        assert.ok(result.messageId);
      });

      test('send with cc and bcc', async () => {
        const api = getApi();
        const result = await api.emailSend({
          to: 'success@simulator.amazonses.com',
          subject: 'CC/BCC test',
          body: 'Testing cc and bcc',
          cc: ['success+cc@simulator.amazonses.com'],
          bcc: ['success+bcc@simulator.amazonses.com'],
        });
        assert.ok(result.messageId);
      });

      test('invalid email address returns error', async () => {
        const api = getApi();
        try {
          await api.emailSend({
            to: 'not-an-email',
            subject: 'Should fail',
            body: 'This should not send',
          });
          assert.fail('Expected error for invalid email address');
        } catch (e) {
          assert.ok(isBlocksError(e, EmailErrors.InvalidInput),
            `Expected ${EmailErrors.InvalidInput}, got ${e}`);
        }
      });

      test('invalid from address in recipient field returns error', async () => {
        const api = getApi();
        try {
          await api.emailSend({
            to: '@missing-local-part.com',
            subject: 'Should fail',
            body: 'This should not send',
          });
          assert.fail('Expected error for invalid email address');
        } catch (e) {
          assert.ok(isBlocksError(e, EmailErrors.InvalidInput),
            `Expected ${EmailErrors.InvalidInput}, got ${e}`);
        }
      });

      test('recipient count exceeding 50 returns error', async () => {
        const api = getApi();
        const tooManyRecipients = Array.from({ length: 51 },
          (_, i) => `success+${i}@simulator.amazonses.com`);
        try {
          await api.emailSend({
            to: tooManyRecipients,
            subject: 'Too many recipients',
            body: 'This exceeds the limit',
          });
          assert.fail('Expected error for exceeding recipient limit');
        } catch (e) {
          assert.ok(isBlocksError(e, EmailErrors.InvalidInput),
            `Expected ${EmailErrors.InvalidInput}, got ${e}`);
        }
      });

      test('combined to+cc+bcc exceeding 50 returns error', async () => {
        const api = getApi();
        const to = Array.from({ length: 20 },
          (_, i) => `success+to${i}@simulator.amazonses.com`);
        const cc = Array.from({ length: 20 },
          (_, i) => `success+cc${i}@simulator.amazonses.com`);
        const bcc = Array.from({ length: 11 },
          (_, i) => `success+bcc${i}@simulator.amazonses.com`);
        try {
          await api.emailSend({
            to,
            subject: 'Too many combined recipients',
            body: 'This exceeds the combined limit',
            cc,
            bcc,
          });
          assert.fail('Expected error for exceeding combined recipient limit');
        } catch (e) {
          assert.ok(isBlocksError(e, EmailErrors.InvalidInput),
            `Expected ${EmailErrors.InvalidInput}, got ${e}`);
        }
      });
    });

    describe('sendBatch', () => {
      test('sendBatch returns results array matching input order', async () => {
        const api = getApi();
        const messages = [
          {
            to: 'success@simulator.amazonses.com',
            subject: 'Batch 1',
            body: 'First message',
          },
          {
            to: 'success+2@simulator.amazonses.com',
            subject: 'Batch 2',
            body: 'Second message',
          },
          {
            to: 'success+3@simulator.amazonses.com',
            subject: 'Batch 3',
            body: 'Third message',
          },
        ];
        const result = await api.emailSendBatch(messages);
        assert.strictEqual(result.results.length, messages.length);
        for (const entry of result.results) {
          assert.strictEqual(entry.status, 'success');
          assert.ok(entry.messageId, 'Expected messageId for successful send');
        }
      });

      test('sendBatch with mixed valid and invalid emails', async () => {
        const api = getApi();
        const messages = [
          {
            to: 'success@simulator.amazonses.com',
            subject: 'Valid',
            body: 'This should succeed',
          },
          {
            to: 'invalid-email',
            subject: 'Invalid',
            body: 'This should fail',
          },
          {
            to: 'success+3@simulator.amazonses.com',
            subject: 'Also valid',
            body: 'This should also succeed',
          },
        ];
        const result = await api.emailSendBatch(messages);
        assert.strictEqual(result.results.length, 3);
        assert.strictEqual(result.results[0].status, 'success');
        assert.ok(result.results[0].messageId);
        assert.strictEqual(result.results[1].status, 'failed');
        assert.ok(result.results[1].error);
        assert.strictEqual(result.results[2].status, 'success');
        assert.ok(result.results[2].messageId);
      });

      test('sendBatch with empty array returns empty results', async () => {
        const api = getApi();
        const result = await api.emailSendBatch([]);
        assert.deepStrictEqual(result.results, []);
      });

      test('sendBatch with HTML content', async () => {
        const api = getApi();
        const messages = [
          {
            to: 'success@simulator.amazonses.com',
            subject: 'HTML Batch 1',
            body: 'Plain text',
            html: '<p>Rich content 1</p>',
          },
          {
            to: 'success+2@simulator.amazonses.com',
            subject: 'HTML Batch 2',
            body: 'Plain text',
            html: '<p>Rich content 2</p>',
          },
        ];
        const result = await api.emailSendBatch(messages);
        assert.strictEqual(result.results.length, 2);
        for (const entry of result.results) {
          assert.strictEqual(entry.status, 'success');
        }
      });

      test('sendBatch rejects message with too many recipients', async () => {
        const api = getApi();
        const tooManyRecipients = Array.from({ length: 51 },
          (_, i) => `success+${i}@simulator.amazonses.com`);
        const result = await api.emailSendBatch([
          {
            to: tooManyRecipients,
            subject: 'Over limit',
            body: 'This batch entry exceeds limits',
          },
        ]);
        assert.strictEqual(result.results.length, 1);
        assert.strictEqual(result.results[0].status, 'failed');
        assert.ok(result.results[0].error, 'Expected error message for failed entry');
        assert.ok(
          result.results[0].error!.toLowerCase().includes('50') ||
          result.results[0].error!.toLowerCase().includes('recipient'),
          `Expected error to mention "50" or "recipient", got: ${result.results[0].error}`,
        );
      });
    });
  });
}
