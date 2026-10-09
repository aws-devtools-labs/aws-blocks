// x-blocks-user-agent is not on the Blocks server's CORS allowlist, so a
// browser sending it fails the preflight and every RPC call is blocked.
Map<String, String> rpcUserAgentHeaders() => const {};
