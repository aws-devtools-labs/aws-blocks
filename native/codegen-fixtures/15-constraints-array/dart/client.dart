// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class ApiSetTagsInput {
  final List<String> tags;

  ApiSetTagsInput({
    required this.tags,
  }) {
    if (!(tags.length >= 1)) throw ArgumentError('tags must have at least 1 items');
    if (!(tags.length <= 10)) throw ArgumentError('tags must have at most 10 items');
  }

  factory ApiSetTagsInput.fromJson(Map<String, dynamic> json) {
    return ApiSetTagsInput(
      tags: (json['tags'] as List<dynamic>).cast<String>(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'tags': tags,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiSetTagsInput &&
          blocksDeepEquals(tags, other.tags);

  @override
  int get hashCode => blocksDeepHash(tags);

  @override
  String toString() => 'ApiSetTagsInput(tags: $tags)';
}


class SetTagsResult {
  final bool ok;

  const SetTagsResult({
    required this.ok,
  });

  factory SetTagsResult.fromJson(Map<String, dynamic> json) {
    return SetTagsResult(
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
      other is SetTagsResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'SetTagsResult(ok: $ok)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<SetTagsResult> setTags({required ApiSetTagsInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.setTags', params);
    return SetTagsResult.fromJson(result as Map<String, dynamic>);
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

