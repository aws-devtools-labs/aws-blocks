// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-contract probe of the REAL aws-amplify@6 data client (`generateClient`)
 * against a local stub GraphQL endpoint (127.0.0.1, no AWS).
 *
 * The question: what would a Blocks backend have to serve for
 * `client.models.X.*` to work unchanged? The answer this pins down:
 *  - plain GraphQL over HTTP: POST `{ query, variables }` to `data.url`;
 *  - nothing checks that the server is AppSync;
 *  - `userPool` auth sends the RAW Cognito access token in `Authorization`
 *    (no `Bearer` prefix);
 *  - the operation names and input types are the AppSync model-transformer
 *    conventions (`createTodo(input: CreateTodoInput!)`,
 *    `listTodos(filter: ModelTodoFilterInput, limit, nextToken)`), derived
 *    from `model_introspection`, which is generated offline from an
 *    `a.schema` definition.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { a } from '@aws-amplify/data-schema';
import { generateModelsSync } from '@aws-amplify/graphql-generator';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';

interface Seen {
	method?: string;
	url?: string;
	headers: IncomingHttpHeaders;
	body: { query: string; variables: Record<string, unknown> };
}

const schema = a.schema({
	Todo: a.model({ content: a.string(), done: a.boolean() }).authorization((allow) => [allow.owner()]),
});
const introspection = JSON.parse(
	String(
		generateModelsSync({ schema: schema.transform().schema, target: 'introspection', directives: '' } as never)[
			'model-introspection.json'
		],
	),
);

const seen: Seen[] = [];
const item = { __typename: 'Todo', id: '1', content: 'x', done: false, owner: 'u', createdAt: 't', updatedAt: 't' };
let server: Server;

before(async () => {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			const body = JSON.parse(raw);
			seen.push({ method: req.method, url: req.url, headers: req.headers, body });
			const data = body.query.includes('createTodo') ? { createTodo: item } : { listTodos: { items: [item], nextToken: null } };
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ data }));
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as { port: number };
	const jwt = (s: string) => ({ payload: { sub: 'u' }, toString: () => s });
	Amplify.configure(
		{
			version: '1',
			data: {
				aws_region: 'us-west-2',
				url: `http://127.0.0.1:${port}/graphql`,
				default_authorization_type: 'AMAZON_COGNITO_USER_POOLS',
				authorization_types: [],
				model_introspection: introspection,
			},
		},
		{ Auth: { tokenProvider: { getTokens: async () => ({ accessToken: jwt('RAW-ACCESS-TOKEN'), idToken: jwt('ID') }) } } },
	);
});

after(() => server.close());

test('model introspection generates offline; auth rules arrive as metadata only', () => {
	assert.equal(introspection.version, 1);
	const auth = introspection.models.Todo.attributes.find((x: { type: string }) => x.type === 'auth');
	// The client only learns the rule; the SERVER (AppSync resolvers today, a
	// Blocks adapter otherwise) must enforce owner === the cognito:username claim.
	assert.deepEqual(
		auth?.properties.rules.map((r: { allow: string; ownerField: string; identityClaim: string }) => [r.allow, r.ownerField, r.identityClaim]),
		[['owner', 'owner', 'cognito:username']],
	);
	assert.equal(introspection.models.Todo.fields.owner, undefined, 'owner is not a declared field; the server adds it');
});

test('client.models.Todo.create/list are plain GraphQL POSTs that a non-AppSync server can satisfy', async () => {
	const client = generateClient<any>() as any;
	const created = await client.models.Todo.create({ content: 'x' });
	const listed = await client.models.Todo.list({ filter: { done: { eq: false } }, limit: 10 });
	assert.equal(created.errors, undefined);
	assert.equal(created.data?.id, '1');
	assert.equal(listed.data?.length, 1);

	const [c, l] = seen;
	assert.ok(c && l);
	for (const s of [c, l]) {
		assert.equal(s.method, 'POST');
		assert.equal(s.url, '/graphql');
		assert.equal(s.headers.authorization, 'RAW-ACCESS-TOKEN', 'raw token, no Bearer prefix');
	}
	assert.match(c.body.query, /createTodo\(input: \$input\)/);
	assert.match(c.body.query, /\$input: CreateTodoInput!/);
	assert.deepEqual(c.body.variables, { input: { content: 'x' } });
	assert.match(l.body.query, /listTodos\(filter: \$filter, limit: \$limit, nextToken: \$nextToken\)/);
	assert.match(l.body.query, /ModelTodoFilterInput/);
	assert.deepEqual(l.body.variables, { filter: { done: { eq: false } }, limit: 10 });
});
