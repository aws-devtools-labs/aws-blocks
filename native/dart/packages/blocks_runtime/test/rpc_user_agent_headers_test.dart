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
