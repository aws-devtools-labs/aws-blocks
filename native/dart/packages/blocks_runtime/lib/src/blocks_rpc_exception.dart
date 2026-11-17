// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/// Typed exception for JSON-RPC error responses from a Blocks backend.
class BlocksRpcException implements Exception {
  final int code;
  final String message;
  final dynamic data;

  BlocksRpcException({required this.code, required this.message, this.data});

  @override
  String toString() => 'BlocksRpcException($code): $message';
}
