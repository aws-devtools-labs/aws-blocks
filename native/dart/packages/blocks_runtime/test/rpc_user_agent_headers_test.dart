import 'package:blocks_runtime/src/rpc_user_agent_headers.dart';
import 'package:blocks_runtime/src/rpc_user_agent_headers_io.dart' as io;
import 'package:blocks_runtime/src/rpc_user_agent_headers_web.dart' as web;
import 'package:blocks_runtime/src/user_agent.dart';
import 'package:test/test.dart';

void main() {
  group('rpcUserAgentHeaders', () {
    test('the io variant sends the token', () {
      expect(io.rpcUserAgentHeaders(), {
        'x-blocks-user-agent': blocksUserAgentToken,
      });
    });

    test('the web variant omits the header', () {
      expect(web.rpcUserAgentHeaders(), isEmpty);
    });

    test('the dispatcher resolves to the io variant on native', () {
      expect(rpcUserAgentHeaders(), {
        'x-blocks-user-agent': blocksUserAgentToken,
      });
    });
  });
}
