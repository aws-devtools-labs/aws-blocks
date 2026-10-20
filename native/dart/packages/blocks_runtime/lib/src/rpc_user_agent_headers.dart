import 'rpc_user_agent_headers_web.dart'
    if (dart.library.io) 'rpc_user_agent_headers_io.dart'
    as platform;

Map<String, String> rpcUserAgentHeaders() => platform.rpcUserAgentHeaders();
