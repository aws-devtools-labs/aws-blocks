// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'user_agent.dart';

/// Sends [blocksUserAgentToken] as `x-blocks-user-agent` on every RPC call so
/// client traffic metrics can attribute it; the server allows it on preflight.
Map<String, String> rpcUserAgentHeaders() => const {
  'x-blocks-user-agent': blocksUserAgentToken,
};
