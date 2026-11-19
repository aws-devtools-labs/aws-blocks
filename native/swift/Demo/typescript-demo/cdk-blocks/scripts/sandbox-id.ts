// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The framework's helper, not a local copy: it copies an upgraded app's sandbox id
// forward from the pre-rename directory (D-031). A local re-implementation would
// mint a new id instead, deploy to a different stack, and leave the old sandbox
// standing in the account.
export { getSandboxId } from 'aws-cdk-blocks/scripts';
