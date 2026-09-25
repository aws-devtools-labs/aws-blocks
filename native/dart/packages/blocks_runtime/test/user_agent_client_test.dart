import 'package:blocks_runtime/src/user_agent.dart';
import 'package:blocks_runtime/src/user_agent_client.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

void main() {
  group('UserAgentClient', () {
    test('adds the User-Agent header on outbound requests', () async {
      final seen = <String, String?>{};
      final client = UserAgentClient(
        MockClient((req) async {
          seen[req.method] = req.headers['user-agent'];
          return http.Response('', 200);
        }),
      );
      await client.get(Uri.parse('https://s3.example/get'));
      await client.put(Uri.parse('https://s3.example/put'), body: [1, 2, 3]);
      expect(seen['GET'], blocksUserAgentToken);
      expect(seen['PUT'], blocksUserAgentToken);
    });
  });
}
