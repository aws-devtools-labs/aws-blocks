// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_runtime/src/rpc_user_agent_headers.dart';
import 'package:blocks_runtime/src/user_agent.dart';
import 'package:test/test.dart';

void main() {
  test('rpcUserAgentHeaders sends the token', () {
    expect(rpcUserAgentHeaders(), {
      'x-blocks-user-agent': blocksUserAgentToken,
    });
  });
}
