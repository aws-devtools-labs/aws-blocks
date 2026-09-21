// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the IdP-registration custom-resource handler, exercising the
 * paths that only run at deploy time and can't be seen in a synth snapshot:
 * SSM read + retry/terminal behavior, the Create<->Update idempotency
 * fallbacks, and the Delete not-found swallow. Clients are faked — no AWS.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createHandler, type CfnEvent } from './idp-registration-lambda.js';

/** Record every command the handler sends, keyed by command class name. */
function recorder() {
	const calls: { name: string; input: any }[] = [];
	const send = async (cmd: any) => {
		calls.push({ name: cmd.constructor.name, input: cmd.input });
		return {};
	};
	return { calls, send };
}

const baseProps = {
	UserPoolId: 'us-west-2_pool',
	ProviderName: 'Google',
	ProviderType: 'Google',
	ClientIdParam: '/app-google-client-id',
	ClientSecretParam: '/app-google-client-secret',
	ProviderDetails: { authorize_scopes: 'openid email profile' },
	AttributeMapping: { email: 'email', name: 'name' },
};

// An SSM fake that returns a value keyed by parameter name.
function ssmReturning(values: Record<string, string>) {
	return {
		send: async (cmd: any) => ({ Parameter: { Value: values[cmd.input.Name] } }),
	};
}

const fast = { retries: 3, retryDelayMs: 1 };

test('Create: reads both secrets and registers the IdP with merged credentials', async () => {
	const ssm = ssmReturning({ '/app-google-client-id': 'CID', '/app-google-client-secret': 'CSECRET' });
	const idp = recorder();
	const handler = createHandler(ssm, idp, fast);
	const res = await handler({ RequestType: 'Create', ResourceProperties: baseProps } as CfnEvent);

	assert.strictEqual(res.PhysicalResourceId, 'us-west-2_pool|Google|Google');
	assert.strictEqual(idp.calls.length, 1);
	assert.strictEqual(idp.calls[0].name, 'CreateIdentityProviderCommand');
	assert.strictEqual(idp.calls[0].input.ProviderDetails.client_id, 'CID');
	assert.strictEqual(idp.calls[0].input.ProviderDetails.client_secret, 'CSECRET');
	assert.strictEqual(idp.calls[0].input.ProviderDetails.authorize_scopes, 'openid email profile');
});

test('Create: DuplicateProviderException falls back to UpdateIdentityProvider', async () => {
	const ssm = ssmReturning({ '/app-google-client-id': 'CID', '/app-google-client-secret': 'CSECRET' });
	let first = true;
	const calls: string[] = [];
	const idp = {
		send: async (cmd: any) => {
			calls.push(cmd.constructor.name);
			if (first && cmd.constructor.name === 'CreateIdentityProviderCommand') {
				first = false;
				throw { name: 'DuplicateProviderException' };
			}
			return {};
		},
	};
	const handler = createHandler(ssm, idp, fast);
	await handler({ RequestType: 'Create', ResourceProperties: baseProps } as CfnEvent);
	assert.deepStrictEqual(calls, ['CreateIdentityProviderCommand', 'UpdateIdentityProviderCommand']);
});

test('Update: calls UpdateIdentityProvider', async () => {
	const ssm = ssmReturning({ '/app-google-client-id': 'CID', '/app-google-client-secret': 'CSECRET' });
	const idp = recorder();
	const handler = createHandler(ssm, idp, fast);
	await handler({ RequestType: 'Update', ResourceProperties: baseProps } as CfnEvent);
	assert.deepStrictEqual(idp.calls.map((c) => c.name), ['UpdateIdentityProviderCommand']);
});

test('Update: ResourceNotFoundException falls back to CreateIdentityProvider', async () => {
	const ssm = ssmReturning({ '/app-google-client-id': 'CID', '/app-google-client-secret': 'CSECRET' });
	const calls: string[] = [];
	const idp = {
		send: async (cmd: any) => {
			calls.push(cmd.constructor.name);
			if (cmd.constructor.name === 'UpdateIdentityProviderCommand') throw { name: 'ResourceNotFoundException' };
			return {};
		},
	};
	const handler = createHandler(ssm, idp, fast);
	await handler({ RequestType: 'Update', ResourceProperties: baseProps } as CfnEvent);
	assert.deepStrictEqual(calls, ['UpdateIdentityProviderCommand', 'CreateIdentityProviderCommand']);
});

test('Delete: calls DeleteIdentityProvider and swallows ResourceNotFoundException', async () => {
	const ssm = ssmReturning({});
	const idp = {
		send: async (cmd: any) => {
			assert.strictEqual(cmd.constructor.name, 'DeleteIdentityProviderCommand');
			throw { name: 'ResourceNotFoundException' };
		},
	};
	const handler = createHandler(ssm, idp, fast);
	const res = await handler({ RequestType: 'Delete', ResourceProperties: baseProps } as CfnEvent);
	assert.strictEqual(res.PhysicalResourceId, 'us-west-2_pool|Google|Google');
});

test('readSecret: a terminal ParameterNotFound throws an actionable message', async () => {
	const ssm = { send: async () => { throw { name: 'ParameterNotFound' }; } };
	const idp = recorder();
	const handler = createHandler(ssm, idp, fast);
	await assert.rejects(
		handler({ RequestType: 'Create', ResourceProperties: baseProps } as CfnEvent),
		/was not found.*put-parameter/s,
	);
	assert.strictEqual(idp.calls.length, 0, 'no Cognito call when the credential is missing');
});

test('readSecret: a not-yet-present parameter is retried, then succeeds', async () => {
	const attemptsByName: Record<string, number> = {};
	const ssm = {
		send: async (cmd: any) => {
			const name = cmd.input.Name;
			attemptsByName[name] = (attemptsByName[name] ?? 0) + 1;
			// Fail the first read of each param, then return a value.
			if (attemptsByName[name] < 2) throw { name: 'ParameterNotFound' };
			return { Parameter: { Value: name.includes('secret') ? 'CSECRET' : 'CID' } };
		},
	};
	const idp = recorder();
	const handler = createHandler(ssm as any, idp, fast);
	await handler({ RequestType: 'Create', ResourceProperties: baseProps } as CfnEvent);
	assert.strictEqual(attemptsByName['/app-google-client-id'], 2, 'client-id read retried once');
	assert.strictEqual(idp.calls[0].input.ProviderDetails.client_id, 'CID');
});
