// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// x-blocks-user-agent is not on the Blocks server's CORS allowlist, so a
// browser sending it fails the preflight and every RPC call is blocked.
Map<String, String> rpcUserAgentHeaders() => const {};
