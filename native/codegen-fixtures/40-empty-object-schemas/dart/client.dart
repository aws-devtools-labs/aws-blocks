// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class GetEnvelopeResult {
  final String id;
  final dynamic meta;
  final List<dynamic> attachments;
  final dynamic settings;

  const GetEnvelopeResult({
    required this.id,
    required this.meta,
    required this.attachments,
    this.settings,
  });

  factory GetEnvelopeResult.fromJson(Map<String, dynamic> json) {
    return GetEnvelopeResult(
      id: json['id'] as String,
      meta: json['meta'] as dynamic,
      attachments: (json['attachments'] as List<dynamic>).cast<dynamic>(),
      settings: json['settings'] as dynamic,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'meta': meta,
      'attachments': attachments,
      if (settings != null) 'settings': settings,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetEnvelopeResult &&
          id == other.id &&
          blocksDeepEquals(meta, other.meta) &&
          blocksDeepEquals(attachments, other.attachments) &&
          blocksDeepEquals(settings, other.settings);

  @override
  int get hashCode => Object.hash(id, blocksDeepHash(meta), blocksDeepHash(attachments), blocksDeepHash(settings));

  @override
  String toString() => 'GetEnvelopeResult(id: $id, meta: $meta, attachments: $attachments, settings: $settings)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<dynamic> getOptions({required dynamic options, dynamic extra}) async {
    final params = <dynamic>[
      options,
      if (extra != null) extra,
    ];
    final result = await _client.call('api.getOptions', params);
    return result as dynamic;
  }

  Future<dynamic> getSettings({required dynamic settings}) async {
    final params = <dynamic>[
      settings,
    ];
    final result = await _client.call('api.getSettings', params);
    return result as dynamic;
  }

  Future<GetEnvelopeResult> getEnvelope() async {
    final result = await _client.call('api.getEnvelope', const <dynamic>[]);
    return GetEnvelopeResult.fromJson(result as Map<String, dynamic>);
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

