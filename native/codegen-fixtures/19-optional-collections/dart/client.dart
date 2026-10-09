// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class GetUserResult {
  final String name;
  final List<String> tags;
  final List<int>? scores;
  final Map<String, String>? metadata;
  final List<String?>? nicknames;

  const GetUserResult({
    required this.name,
    required this.tags,
    this.scores,
    this.metadata,
    this.nicknames,
  });

  factory GetUserResult.fromJson(Map<String, dynamic> json) {
    return GetUserResult(
      name: json['name'] as String,
      tags: (json['tags'] as List<dynamic>).cast<String>(),
      scores: (json['scores'] as List<dynamic>?)?.map((e) => (e as num).toInt()).toList(),
      metadata: (json['metadata'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, v as String)),
      nicknames: (json['nicknames'] as List<dynamic>?)?.cast<String?>(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'tags': tags,
      if (scores != null) 'scores': scores,
      if (metadata != null) 'metadata': metadata,
      if (nicknames != null) 'nicknames': nicknames,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetUserResult &&
          name == other.name &&
          blocksDeepEquals(tags, other.tags) &&
          blocksDeepEquals(scores, other.scores) &&
          blocksDeepEquals(metadata, other.metadata) &&
          blocksDeepEquals(nicknames, other.nicknames);

  @override
  int get hashCode => Object.hash(name, blocksDeepHash(tags), blocksDeepHash(scores), blocksDeepHash(metadata), blocksDeepHash(nicknames));

  @override
  String toString() => 'GetUserResult(name: $name, tags: $tags, scores: $scores, metadata: $metadata, nicknames: $nicknames)';
}


class ApiUpdateUserInput {
  final String id;
  final List<String>? tags;
  final Map<String, String>? metadata;

  const ApiUpdateUserInput({
    required this.id,
    this.tags,
    this.metadata,
  });

  factory ApiUpdateUserInput.fromJson(Map<String, dynamic> json) {
    return ApiUpdateUserInput(
      id: json['id'] as String,
      tags: (json['tags'] as List<dynamic>?)?.cast<String>(),
      metadata: (json['metadata'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, v as String)),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      if (tags != null) 'tags': tags,
      if (metadata != null) 'metadata': metadata,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiUpdateUserInput &&
          id == other.id &&
          blocksDeepEquals(tags, other.tags) &&
          blocksDeepEquals(metadata, other.metadata);

  @override
  int get hashCode => Object.hash(id, blocksDeepHash(tags), blocksDeepHash(metadata));

  @override
  String toString() => 'ApiUpdateUserInput(id: $id, tags: $tags, metadata: $metadata)';
}


class UpdateUserResult {
  final bool ok;

  const UpdateUserResult({
    required this.ok,
  });

  factory UpdateUserResult.fromJson(Map<String, dynamic> json) {
    return UpdateUserResult(
      ok: json['ok'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'ok': ok,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UpdateUserResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'UpdateUserResult(ok: $ok)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<GetUserResult> getUser({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('api.getUser', params);
    return GetUserResult.fromJson(result as Map<String, dynamic>);
  }

  Future<UpdateUserResult> updateUser({required ApiUpdateUserInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.updateUser', params);
    return UpdateUserResult.fromJson(result as Map<String, dynamic>);
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

