// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from 'constructs';

const parent = (globalThis as any).CURRENT_BLOCKS_STACK;
new Construct(parent, 'SideEffectMarker');
