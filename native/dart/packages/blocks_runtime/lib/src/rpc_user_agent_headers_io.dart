// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'user_agent.dart';

Map<String, String> rpcUserAgentHeaders() => const {
  'x-blocks-user-agent': blocksUserAgentToken,
};
