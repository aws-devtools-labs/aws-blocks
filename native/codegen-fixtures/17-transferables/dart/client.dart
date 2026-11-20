// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle, FileTransferException, RealtimeException, RealtimeChannelClosedException, RealtimeConnectionException, RealtimeSubscriptionEndedException, TransferableException, InvalidDescriptorException;

// --- Models ---

class GetChannelResultMessage {
  final String message;
  final num timestamp;

  const GetChannelResultMessage({
    required this.message,
    required this.timestamp,
  });

  factory GetChannelResultMessage.fromJson(Map<String, dynamic> json) {
    return GetChannelResultMessage(
      message: json['message'] as String,
      timestamp: json['timestamp'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'message': message,
      'timestamp': timestamp,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetChannelResultMessage &&
          message == other.message &&
          timestamp == other.timestamp;

  @override
  int get hashCode => Object.hash(message, timestamp);

  @override
  String toString() => 'GetChannelResultMessage(message: $message, timestamp: $timestamp)';
}


// --- API Namespaces ---

class Api {
  final BlocksClient _client;
  Api(this._client);

  Future<RealtimeChannel<GetChannelResultMessage>> getChannel() async {
    final result = await _client.call('api.getChannel', const <dynamic>[]);
    return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => GetChannelResultMessage.fromJson(json));
  }

  Future<FileDownloadHandle> getFile({required String path}) async {
    final params = <dynamic>[
      path,
    ];
    final result = await _client.call('api.getFile', params);
    return FileDownloadHandle.fromJson(result as Map<String, dynamic>);
  }

  Future<FileUploadHandle> getUpload({required String path}) async {
    final params = <dynamic>[
      path,
    ];
    final result = await _client.call('api.getUpload', params);
    return FileUploadHandle.fromJson(result as Map<String, dynamic>);
  }
}


// --- CDK Blocks Client ---

class Blocks {
  late final Api api;
  late final BlocksClient _client;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    _client = client;
    api = Api(client);
  }

  /// Closes the client. A call after this throws a [ClientClosedException],
  /// and so does an `OidcClient` one of its calls returned. Closing twice
  /// does nothing more.
  void close() => _client.close();
}

