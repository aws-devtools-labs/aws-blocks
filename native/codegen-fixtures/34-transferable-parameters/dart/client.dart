// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;

// --- Models ---

class Note {
  final String id;
  final String body;

  const Note({
    required this.id,
    required this.body,
  });

  factory Note.fromJson(Map<String, dynamic> json) {
    return Note(
      id: json['id'] as String,
      body: json['body'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'body': body,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Note &&
          id == other.id &&
          body == other.body;

  @override
  int get hashCode => Object.hash(id, body);

  @override
  String toString() => 'Note(id: $id, body: $body)';
}


class ApiRelayInlineFeedMessage {
  final String text;

  const ApiRelayInlineFeedMessage({
    required this.text,
  });

  factory ApiRelayInlineFeedMessage.fromJson(Map<String, dynamic> json) {
    return ApiRelayInlineFeedMessage(
      text: json['text'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'text': text,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiRelayInlineFeedMessage &&
          text == other.text;

  @override
  int get hashCode => text.hashCode;

  @override
  String toString() => 'ApiRelayInlineFeedMessage(text: $text)';
}


// --- API Namespaces ---

class Bundle {
  final RealtimeChannel<Note> feed;
  final List<FileDownloadHandle> files;
  final FileUploadHandle? upload;

  const Bundle({
    required this.feed,
    required this.files,
    this.upload,
  });

  factory Bundle.fromJson(Map<String, dynamic> json) {
    return Bundle(
      feed: RealtimeChannel.fromJson(json['feed'] as Map<String, dynamic>, (json) => Note.fromJson(json)),
      files: (json['files'] as List<dynamic>).map((e) => FileDownloadHandle.fromJson(e as Map<String, dynamic>)).toList(),
      upload: json['upload'] != null ? FileUploadHandle.fromJson(json['upload'] as Map<String, dynamic>) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'feed': feed.toJson(),
      'files': files.map((e) => e.toJson()).toList(),
      if (upload != null) 'upload': upload?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Bundle &&
          feed == other.feed &&
          blocksDeepEquals(files, other.files) &&
          upload == other.upload;

  @override
  int get hashCode => Object.hash(feed, blocksDeepHash(files), upload);

  @override
  String toString() => 'Bundle(feed: $feed, files: $files, upload: $upload)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<String> relay({required RealtimeChannel<Note> feed}) async {
    final params = <dynamic>[
      feed.toJson(),
    ];
    final result = await _client.call('api.relay', params);
    return result as String;
  }

  Future<String> relayIfAny({required String room, RealtimeChannel<Note>? feed}) async {
    final params = <dynamic>[
      room,
      if (feed != null) feed.toJson(),
    ];
    final result = await _client.call('api.relayIfAny', params);
    return result as String;
  }

  Future<String> relayOrNull({required RealtimeChannel<Note>? feed}) async {
    final params = <dynamic>[
      feed?.toJson(),
    ];
    final result = await _client.call('api.relayOrNull', params);
    return result as String;
  }

  Future<String> relayAll({required List<RealtimeChannel<Note>> feeds, required Map<String, RealtimeChannel<Note>> byRoom}) async {
    final params = <dynamic>[
      feeds.map((e) => e.toJson()).toList(),
      byRoom.map((k, v) => MapEntry(k, v.toJson())),
    ];
    final result = await _client.call('api.relayAll', params);
    return result as String;
  }

  Future<String> relayInline({required RealtimeChannel<ApiRelayInlineFeedMessage> feed}) async {
    final params = <dynamic>[
      feed.toJson(),
    ];
    final result = await _client.call('api.relayInline', params);
    return result as String;
  }

  Future<String> share({required FileDownloadHandle download, required FileUploadHandle upload}) async {
    final params = <dynamic>[
      download.toJson(),
      upload.toJson(),
    ];
    final result = await _client.call('api.share', params);
    return result as String;
  }

  Future<String> forward({required Bundle bundle}) async {
    final params = <dynamic>[
      bundle.toJson(),
    ];
    final result = await _client.call('api.forward', params);
    return result as String;
  }
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    api = ApiApi(client);
  }
}

