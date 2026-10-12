// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * A backend whose default export reads the owner's `apiUrl` / `gateway` while
 * `create()` is still importing it — the shared gateway must already exist.
 */
export default function (owner: Construct & { apiUrl: string; gateway: Construct }) {
	new CfnOutput(owner, 'ApiUrlDuringImport', { value: owner.apiUrl });
	new Construct(owner, 'GatewayPathDuringImport').node.addMetadata('gatewayPath', owner.gateway.node.path);
}
