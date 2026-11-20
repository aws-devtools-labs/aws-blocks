// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;

// --- Models ---

// --- API Namespaces ---

class Todo {
  final String id;
  final String title;
  final bool done;
  final int priority;

  const Todo({
    required this.id,
    required this.title,
    required this.done,
    required this.priority,
  });

  factory Todo.fromJson(Map<String, dynamic> json) {
    return Todo(
      id: json['id'] as String,
      title: json['title'] as String,
      done: json['done'] as bool,
      priority: (json['priority'] as num).toInt(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'done': done,
      'priority': priority,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Todo &&
          id == other.id &&
          title == other.title &&
          done == other.done &&
          priority == other.priority;

  @override
  int get hashCode => Object.hash(id, title, done, priority);

  @override
  String toString() => 'Todo(id: $id, title: $title, done: $done, priority: $priority)';
}


class ApiCreateTodoInput {
  final String title;
  final int priority;

  const ApiCreateTodoInput({
    required this.title,
    required this.priority,
  });

  factory ApiCreateTodoInput.fromJson(Map<String, dynamic> json) {
    return ApiCreateTodoInput(
      title: json['title'] as String,
      priority: (json['priority'] as num).toInt(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'title': title,
      'priority': priority,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiCreateTodoInput &&
          title == other.title &&
          priority == other.priority;

  @override
  int get hashCode => Object.hash(title, priority);

  @override
  String toString() => 'ApiCreateTodoInput(title: $title, priority: $priority)';
}


class Api {
  final BlocksClient _client;
  Api(this._client);

  Future<Todo> getTodo({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('api.getTodo', params);
    return Todo.fromJson(result as Map<String, dynamic>);
  }

  Future<Todo> createTodo({required ApiCreateTodoInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.createTodo', params);
    return Todo.fromJson(result as Map<String, dynamic>);
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

