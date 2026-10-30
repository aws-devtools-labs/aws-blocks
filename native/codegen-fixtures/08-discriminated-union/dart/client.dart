// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

sealed class ApiDoActionInput {
  const ApiDoActionInput();
  Map<String, dynamic> toJson();
  static ApiDoActionInput fromJson(Map<String, dynamic> json) {
    switch (json['action'] as String) {
      case 'create': return CreateInput.fromJson(json);
      case 'delete': return DeleteInput.fromJson(json);
      case 'update': return UpdateInput.fromJson(json);
      default: throw ArgumentError('Unknown action: ${json['action']}');
    }
  }
}

class CreateInput extends ApiDoActionInput {
  final String title;

  const CreateInput({
    required this.title,
  });

  factory CreateInput.fromJson(Map<String, dynamic> json) {
    return CreateInput(
      title: json['title'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'create',
      'title': title,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CreateInput &&
          title == other.title;

  @override
  int get hashCode => title.hashCode;

  @override
  String toString() => 'CreateInput(title: $title)';
}

class DeleteInput extends ApiDoActionInput {
  final String id;

  const DeleteInput({
    required this.id,
  });

  factory DeleteInput.fromJson(Map<String, dynamic> json) {
    return DeleteInput(
      id: json['id'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'delete',
      'id': id,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DeleteInput &&
          id == other.id;

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'DeleteInput(id: $id)';
}

class UpdateInput extends ApiDoActionInput {
  final String id;
  final String title;

  const UpdateInput({
    required this.id,
    required this.title,
  });

  factory UpdateInput.fromJson(Map<String, dynamic> json) {
    return UpdateInput(
      id: json['id'] as String,
      title: json['title'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'update',
      'id': id,
      'title': title,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UpdateInput &&
          id == other.id &&
          title == other.title;

  @override
  int get hashCode => Object.hash(id, title);

  @override
  String toString() => 'UpdateInput(id: $id, title: $title)';
}



class DoActionResult {
  final bool ok;

  const DoActionResult({
    required this.ok,
  });

  factory DoActionResult.fromJson(Map<String, dynamic> json) {
    return DoActionResult(
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
      other is DoActionResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'DoActionResult(ok: $ok)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<DoActionResult> doAction({required ApiDoActionInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.doAction', params);
    return DoActionResult.fromJson(result as Map<String, dynamic>);
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

