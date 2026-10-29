// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class Entry {
  final dynamic payload;
  final dynamic optionalPayload;
  final dynamic nullablePayload;
  final Map<String, dynamic> metadata;
  final List<dynamic> tags;
  final Map<String, dynamic> sparse;
  final Map<String, dynamic>? claims;

  const Entry({
    required this.payload,
    this.optionalPayload,
    required this.nullablePayload,
    required this.metadata,
    required this.tags,
    required this.sparse,
    this.claims,
  });

  factory Entry.fromJson(Map<String, dynamic> json) {
    return Entry(
      payload: json['payload'] as dynamic,
      optionalPayload: json['optionalPayload'] as dynamic,
      nullablePayload: json['nullablePayload'] as dynamic,
      metadata: (json['metadata'] as Map<String, dynamic>).map((k, v) => MapEntry(k, v as dynamic)),
      tags: (json['tags'] as List<dynamic>).cast<dynamic>(),
      sparse: (json['sparse'] as Map<String, dynamic>).map((k, v) => MapEntry(k, v as dynamic)),
      claims: (json['claims'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, v as dynamic)),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'payload': payload,
      if (optionalPayload != null) 'optionalPayload': optionalPayload,
      'nullablePayload': nullablePayload,
      'metadata': metadata,
      'tags': tags,
      'sparse': sparse,
      if (claims != null) 'claims': claims,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Entry &&
          blocksDeepEquals(payload, other.payload) &&
          blocksDeepEquals(optionalPayload, other.optionalPayload) &&
          blocksDeepEquals(nullablePayload, other.nullablePayload) &&
          blocksDeepEquals(metadata, other.metadata) &&
          blocksDeepEquals(tags, other.tags) &&
          blocksDeepEquals(sparse, other.sparse) &&
          blocksDeepEquals(claims, other.claims);

  @override
  int get hashCode => Object.hash(blocksDeepHash(payload), blocksDeepHash(optionalPayload), blocksDeepHash(nullablePayload), blocksDeepHash(metadata), blocksDeepHash(tags), blocksDeepHash(sparse), blocksDeepHash(claims));

  @override
  String toString() => 'Entry(payload: $payload, optionalPayload: $optionalPayload, nullablePayload: $nullablePayload, metadata: $metadata, tags: $tags, sparse: $sparse, claims: $claims)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<dynamic> echo({required dynamic payload}) async {
    final params = <dynamic>[
      payload,
    ];
    final result = await _client.call('api.echo', params);
    return result as dynamic;
  }

  Future<Entry> store({required Entry entry}) async {
    final params = <dynamic>[
      entry.toJson(),
    ];
    final result = await _client.call('api.store', params);
    return Entry.fromJson(result as Map<String, dynamic>);
  }

  Future<List<dynamic>> collect({required List<dynamic> items, required Map<String, dynamic> metadata, required dynamic maybe, required List<dynamic> holes, required Map<String, dynamic> sparse, dynamic extra}) async {
    final params = <dynamic>[
      items,
      metadata,
      maybe,
      holes,
      sparse,
      if (extra != null) extra,
    ];
    final result = await _client.call('api.collect', params);
    return (result as List<dynamic>).cast<dynamic>();
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

