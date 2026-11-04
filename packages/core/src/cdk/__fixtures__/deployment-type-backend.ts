// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from 'constructs';

// Captured at module evaluation, i.e. when BlocksBackend.create() imports this
// backend module — so the marker records the value blocks see during import.
const importTimeDeploymentType = process.env.BLOCKS_DEPLOYMENT_TYPE ?? 'unset';

export default function (scope: Construct) {
  new Construct(scope, `DeploymentTypeAtImport-${importTimeDeploymentType}`);
}
