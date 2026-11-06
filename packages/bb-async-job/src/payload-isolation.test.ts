// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTick } from 'node:timers/promises';
import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AsyncJob } from './index.mock.js';
import { AsyncJob as AwsAsyncJob } from './index.aws.js';
import type { AsyncJobContext } from './types.js';

interface Payload {
	customer: { id: string };
	tags: string[];
}

const fresh = (): Payload => ({ customer: { id: 'saved' }, tags: ['saved'] });
const scope = () => new Scope(`payload-${randomUUID()}`);

function mutate(payload: Payload): void {
	payload.customer.id = 'changed';
	payload.tags.push('changed');
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Job did not finish within 5 seconds')), 5000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

for (const batch of [false, true]) {
	for (const delaySeconds of [0, 1]) {
		test(`AsyncJob - ${batch ? 'batch' : 'single'} delivery snapshots inputs (delay ${delaySeconds}s)`, async () => {
			const delivered = deferred<Payload[]>();
			const received: Payload[] = [];
			const inputs = batch ? [fresh(), fresh()] : [fresh()];
			const job = new AsyncJob<Payload>(scope(), 'snapshot', {
				handler: async payload => {
					received.push(payload);
					if (received.length === inputs.length) delivered.resolve(received);
				},
			});
			if (batch) await job.submitBatch(inputs, { delaySeconds });
			else await job.submit(inputs[0], { delaySeconds });
			for (const input of inputs) mutate(input);

			assert.deepEqual(await bounded(delivered.promise), inputs.map(() => fresh()));
			for (let i = 0; i < received.length; i++) {
				assert.notStrictEqual(received[i], inputs[i]);
				assert.notStrictEqual(received[i].customer, inputs[i].customer);
			}
		});
	}
}

test('AsyncJob - each retry gets a fresh payload without mutating the caller', async () => {
	const delivered = deferred<void>();
	const attempts: Payload[] = [];
	const contexts: AsyncJobContext[] = [];
	const input = fresh();
	const job = new AsyncJob<Payload>(scope(), 'retry', {
		maxRetries: 2,
		handler: async (payload, context) => {
			attempts.push(JSON.parse(JSON.stringify(payload)));
			contexts.push(context);
			if (context.receiveCount === 1) {
				mutate(payload);
				throw new Error('First attempt fails after changing its payload');
			}
			delivered.resolve();
		},
	});
	const { jobId } = await job.submit(input);
	await bounded(delivered.promise);
	await nextTick();
	assert.deepEqual(attempts, [fresh(), fresh()]);
	assert.deepEqual(input, fresh());
	assert.deepEqual(contexts.map(context => context.receiveCount), [1, 2]);
	assert.ok(contexts.every(context => context.jobId === jobId && context.sentAt === contexts[0].sentAt));
	assert.equal(job._queue.totalCompleted, 1);
});

test('AsyncJob - terminal failure retains the original DLQ payload and tracked state', async () => {
	const attempts: Payload[] = [];
	const input = fresh();
	const job = new AsyncJob<Payload>(scope(), 'dlq', {
		maxRetries: 2,
		trackStatus: true,
		handler: async payload => {
			attempts.push(JSON.parse(JSON.stringify(payload)));
			mutate(payload);
			throw new Error('Always fails after changing its payload');
		},
	});
	const { jobId } = await job.submit(input);
	const status = await job.waitUntilComplete(jobId, { timeoutMs: 5000, pollIntervalMs: 10 });
	assert.equal(status.state, 'failed');
	assert.equal(status.attempts, 2);
	assert.deepEqual(attempts, [fresh(), fresh()]);
	assert.deepEqual(input, fresh());
	assert.equal(job._queue.failed.length, 1);
	assert.deepEqual(job._queue.failed[0].payload, fresh());
	assert.equal(job._queue.failed[0].jobId, jobId);
	assert.equal(job._queue.totalCompleted, 0);
});

for (const batch of [false, true]) {
	test(`AsyncJob - ${batch ? 'batch' : 'single'} delivery uses the validated JSON body once`, async () => {
		const delivered = deferred<unknown>();
		let serializations = 0;
		const input = {
			toJSON() {
				serializations++;
				return {
					date: new Date('2026-01-02T03:04:05.000Z'),
					bytes: Buffer.from([1, 2]),
					missing: undefined,
					values: [undefined, NaN, Infinity],
				};
			},
		};
		const job = new AsyncJob<unknown>(scope(), 'json', {
			handler: async payload => { delivered.resolve(payload); },
		});
		if (batch) await job.submitBatch([input]);
		else await job.submit(input);
		assert.deepEqual(await bounded(delivered.promise), {
			date: '2026-01-02T03:04:05.000Z',
			bytes: { type: 'Buffer', data: [1, 2] },
			values: [null, null, null],
		});
		assert.equal(serializations, 1, 'deliver the same JSON that passed size validation');
	});
}

test('AsyncJob - JSON scalar payloads are accepted', async () => {
	for (const input of [null, false, 0, 'text']) {
		const delivered = deferred<unknown>();
		const job = new AsyncJob<unknown>(scope(), 'scalar', {
			handler: async payload => { delivered.resolve(payload); },
		});
		await job.submit(input);
		assert.equal(await bounded(delivered.promise), input);
	}
});

test('AsyncJob - batch schema validation runs once per input and snapshots before enqueueing', async () => {
	const delivered = deferred<unknown[]>();
	const received: unknown[] = [];
	const inputs = [fresh(), fresh()];
	let validations = 0;
	const schema: StandardSchemaV1<unknown> = {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate: async value => {
				validations++;
				if (validations === 2) mutate(inputs[0]);
				return { value };
			},
		},
	};
	const job = new AsyncJob<unknown>(scope(), 'schema', {
		schema,
		handler: async payload => {
			received.push(payload);
			if (received.length === inputs.length) delivered.resolve(received);
		},
	});
	await job.submitBatch(inputs);
	assert.deepEqual(await bounded(delivered.promise), [fresh(), fresh()]);
	assert.equal(validations, inputs.length);
});

test('AsyncJob - invalid batch JSON enqueues none of the validated inputs', async () => {
	const job = new AsyncJob<unknown>(scope(), 'invalid-batch', { handler: async () => {} });
	await assert.rejects(() => job.submitBatch([fresh(), { value: 1n }]), TypeError);
	assert.equal(job._queue.totalSubmitted, 0);
});

interface RecordShape {
	messageId: string;
	body: string;
	attributes: { ApproximateReceiveCount: string; SentTimestamp: string };
}

// Only this fixture crosses private SDK/record plumbing; the assertions call
// the actual AWS runtime's submission and delivery code without AWS requests.
function awsFixture(handler: (payload: Payload, context: AsyncJobContext) => Promise<void>) {
	const job = new AwsAsyncJob<Payload>(scope(), 'aws', { handler, maxRetries: 2 });
	registerSdkIdentifiers(job.fullId, {
		queueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/payload-test',
	});
	const internals = job as unknown as {
		_sqsClient: {
			destroy(): void;
			send(command: { input: { MessageBody?: string; Entries?: Array<{ Id: string; MessageBody: string }> } }): Promise<unknown>;
		};
		_processRecord(record: RecordShape): Promise<void>;
	};
	internals._sqsClient.destroy();
	const records: RecordShape[] = [];
	internals._sqsClient = {
		destroy() {},
		async send(command) {
			const entries = command.input.Entries ?? [{ Id: '0', MessageBody: command.input.MessageBody }];
			for (const entry of entries) {
				assert.ok(typeof entry.MessageBody === 'string');
				records.push({
					messageId: `message-${entry.Id}`,
					body: entry.MessageBody,
					attributes: { ApproximateReceiveCount: '1', SentTimestamp: String(Date.now()) },
				});
			}
			return { MessageId: 'message-0', Successful: entries.map(entry => ({ Id: entry.Id, MessageId: `message-${entry.Id}` })) };
		},
	};
	return { job, records, deliver: (record: RecordShape) => internals._processRecord(record) };
}

for (const batch of [false, true]) {
	test(`AsyncJob AWS runtime - ${batch ? 'batch' : 'single'} submission isolates inputs`, async () => {
		let received: Payload | undefined;
		const { job, records, deliver } = awsFixture(async payload => { received = payload; });
		const input = fresh();
		if (batch) await job.submitBatch([input]);
		else await job.submit(input);
		mutate(input);
		await deliver(records[0]);
		assert.deepEqual(received, fresh());
	});
}

test('AsyncJob AWS runtime - redelivery parses the original body again', async () => {
	const attempts: Payload[] = [];
	const { job, records, deliver } = awsFixture(async (payload, context) => {
		attempts.push(JSON.parse(JSON.stringify(payload)));
		if (context.receiveCount === 1) {
			mutate(payload);
			throw new Error('First attempt fails after changing its payload');
		}
	});
	const input = fresh();
	await job.submit(input);
	await assert.rejects(() => deliver(records[0]), /First attempt fails/);
	await deliver({ ...records[0], attributes: { ...records[0].attributes, ApproximateReceiveCount: '2' } });
	assert.deepEqual(attempts, [fresh(), fresh()]);
	assert.deepEqual(input, fresh());
});
