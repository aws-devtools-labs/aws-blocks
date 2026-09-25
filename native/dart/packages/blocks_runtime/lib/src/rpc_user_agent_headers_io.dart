import 'user_agent.dart';

Map<String, String> rpcUserAgentHeaders() => const {
  'x-blocks-user-agent': blocksUserAgentToken,
};
