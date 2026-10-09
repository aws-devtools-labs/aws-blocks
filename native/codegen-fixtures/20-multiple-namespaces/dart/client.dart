// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class User {
  final String id;
  final String name;
  final String email;

  const User({
    required this.id,
    required this.name,
    required this.email,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'] as String,
      name: json['name'] as String,
      email: json['email'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'email': email,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is User &&
          id == other.id &&
          name == other.name &&
          email == other.email;

  @override
  int get hashCode => Object.hash(id, name, email);

  @override
  String toString() => 'User(id: $id, name: $name, email: $email)';
}


class UsersCreateInput {
  final String name;
  final String email;

  const UsersCreateInput({
    required this.name,
    required this.email,
  });

  factory UsersCreateInput.fromJson(Map<String, dynamic> json) {
    return UsersCreateInput(
      name: json['name'] as String,
      email: json['email'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'email': email,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UsersCreateInput &&
          name == other.name &&
          email == other.email;

  @override
  int get hashCode => Object.hash(name, email);

  @override
  String toString() => 'UsersCreateInput(name: $name, email: $email)';
}


class UsersApi {
  final BlocksClient _client;
  UsersApi(this._client);

  Future<User> get$({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('users.get', params);
    return User.fromJson(result as Map<String, dynamic>);
  }

  Future<List<User>> list() async {
    final result = await _client.call('users.list', const <dynamic>[]);
    return (result as List<dynamic>).map((e) => User.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<User> create({required UsersCreateInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('users.create', params);
    return User.fromJson(result as Map<String, dynamic>);
  }
}


class PostsListResult {
  final String id;
  final String title;
  final String authorId;

  const PostsListResult({
    required this.id,
    required this.title,
    required this.authorId,
  });

  factory PostsListResult.fromJson(Map<String, dynamic> json) {
    return PostsListResult(
      id: json['id'] as String,
      title: json['title'] as String,
      authorId: json['authorId'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'title': title,
      'authorId': authorId,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PostsListResult &&
          id == other.id &&
          title == other.title &&
          authorId == other.authorId;

  @override
  int get hashCode => Object.hash(id, title, authorId);

  @override
  String toString() => 'PostsListResult(id: $id, title: $title, authorId: $authorId)';
}


class PostsCreateInput {
  final String title;
  final String body;
  final String authorId;

  const PostsCreateInput({
    required this.title,
    required this.body,
    required this.authorId,
  });

  factory PostsCreateInput.fromJson(Map<String, dynamic> json) {
    return PostsCreateInput(
      title: json['title'] as String,
      body: json['body'] as String,
      authorId: json['authorId'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'title': title,
      'body': body,
      'authorId': authorId,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PostsCreateInput &&
          title == other.title &&
          body == other.body &&
          authorId == other.authorId;

  @override
  int get hashCode => Object.hash(title, body, authorId);

  @override
  String toString() => 'PostsCreateInput(title: $title, body: $body, authorId: $authorId)';
}


class PostsDeleteResult {
  final bool ok;

  const PostsDeleteResult({
    required this.ok,
  });

  factory PostsDeleteResult.fromJson(Map<String, dynamic> json) {
    return PostsDeleteResult(
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
      other is PostsDeleteResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'PostsDeleteResult(ok: $ok)';
}


class PostsApi {
  final BlocksClient _client;
  PostsApi(this._client);

  Future<List<PostsListResult>> list({required String authorId}) async {
    final params = <dynamic>[
      authorId,
    ];
    final result = await _client.call('posts.list', params);
    return (result as List<dynamic>).map((e) => PostsListResult.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<PostsListResult> create({required PostsCreateInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('posts.create', params);
    return PostsListResult.fromJson(result as Map<String, dynamic>);
  }

  Future<PostsDeleteResult> delete({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('posts.delete', params);
    return PostsDeleteResult.fromJson(result as Map<String, dynamic>);
  }
}


// --- Blocks Client ---

class Blocks {
  late final UsersApi users;
  late final PostsApi posts;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    users = UsersApi(client);
    posts = PostsApi(client);
  }
}

