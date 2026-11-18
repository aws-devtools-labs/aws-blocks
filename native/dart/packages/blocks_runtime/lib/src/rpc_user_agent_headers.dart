import 'user_agent.dart';

/// Sends [blocksUserAgentToken] as `x-blocks-user-agent` on every RPC call so
/// client traffic metrics can attribute it; the server allows it on preflight.
Map<String, String> rpcUserAgentHeaders() => const {
  'x-blocks-user-agent': blocksUserAgentToken,
};
