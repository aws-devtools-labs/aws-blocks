// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom resource for an Aurora DSQL change data capture (CDC) stream.
 * CloudFormation has no resource type for CDC streams yet, so this Lambda
 * calls `CreateStream` / `DeleteStream` and the provider polls `GetStream`
 * (`isComplete`) until the stream is `ACTIVE` or gone.
 *
 * Properties: `ClusterIdentifier`, `KinesisStreamArn`, `RoleArn`.
 * Physical id: the DSQL stream identifier. Changing a property creates a new
 * stream; CloudFormation then deletes the old one.
 */

import {
  CreateStreamCommand,
  DeleteStreamCommand,
  DSQLClient,
  GetStreamCommand,
  ResourceNotFoundException,
  ValidationException,
} from '@aws-sdk/client-dsql';

interface StreamProperties {
  ClusterIdentifier: string;
  KinesisStreamArn: string;
  RoleArn: string;
}

interface Event {
  RequestType: 'Create' | 'Update' | 'Delete';
  RequestId: string;
  PhysicalResourceId?: string;
  ResourceProperties: StreamProperties & { ServiceToken?: string };
}

const client = new DSQLClient({});

/** IAM is eventually consistent: a new role can be refused for a short while. */
const ROLE_RETRY_MS = 5_000;
const ROLE_RETRY_ATTEMPTS = 12;

async function createStream(props: StreamProperties, requestId: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await client.send(
        new CreateStreamCommand({
          clusterIdentifier: props.ClusterIdentifier,
          targetDefinition: { kinesis: { streamArn: props.KinesisStreamArn, roleArn: props.RoleArn } },
          ordering: 'UNORDERED',
          format: 'JSON',
          // Idempotent across Lambda retries of the same CloudFormation request.
          clientToken: requestId.slice(0, 64),
        }),
      );
      if (!out.streamIdentifier) throw new Error('CreateStream returned no stream identifier');
      return out.streamIdentifier;
    } catch (error) {
      if (error instanceof ValidationException && attempt < ROLE_RETRY_ATTEMPTS) {
        console.warn(`CreateStream refused (attempt ${attempt}): ${error.message}; retrying`);
        await new Promise((resolve) => setTimeout(resolve, ROLE_RETRY_MS));
        continue;
      }
      throw error;
    }
  }
}

export async function onEvent(event: Event): Promise<{ PhysicalResourceId: string }> {
  const props = event.ResourceProperties;
  if (event.RequestType === 'Create') {
    return { PhysicalResourceId: await createStream(props, event.RequestId) };
  }
  if (event.RequestType === 'Update') {
    // Any property change targets a different cluster, stream, or role: make a
    // new CDC stream. Returning a new id makes CloudFormation delete the old one.
    return { PhysicalResourceId: await createStream(props, event.RequestId) };
  }
  const streamIdentifier = event.PhysicalResourceId ?? '';
  try {
    await client.send(new DeleteStreamCommand({ clusterIdentifier: props.ClusterIdentifier, streamIdentifier }));
  } catch (error) {
    // Already gone (or never created, e.g. a failed Create): nothing to delete.
    if (!(error instanceof ResourceNotFoundException || error instanceof ValidationException)) throw error;
  }
  return { PhysicalResourceId: streamIdentifier };
}

export async function isComplete(event: Event): Promise<{ IsComplete: boolean }> {
  const props = event.ResourceProperties;
  const streamIdentifier = event.PhysicalResourceId ?? '';
  try {
    const out = await client.send(
      new GetStreamCommand({ clusterIdentifier: props.ClusterIdentifier, streamIdentifier }),
    );
    const status = out.status ?? 'UNKNOWN';
    if (event.RequestType === 'Delete') return { IsComplete: status === 'DELETED' };
    if (status === 'ACTIVE') return { IsComplete: true };
    if (status === 'FAILED' || status === 'IMPAIRED' || status === 'DELETED') {
      throw new Error(`CDC stream ${streamIdentifier} is ${status}`);
    }
    return { IsComplete: false };
  } catch (error) {
    if (event.RequestType === 'Delete' && (error instanceof ResourceNotFoundException || error instanceof ValidationException)) {
      return { IsComplete: true };
    }
    throw error;
  }
}
