// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class GetProfileResult {
  final String name;
  final String? bio;
  final int? age;

  const GetProfileResult({
    required this.name,
    this.bio,
    this.age,
  });

  factory GetProfileResult.fromJson(Map<String, dynamic> json) {
    return GetProfileResult(
      name: json['name'] as String,
      bio: json['bio'] as String?,
      age: (json['age'] as num?)?.toInt(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      if (bio != null) 'bio': bio,
      if (age != null) 'age': age,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetProfileResult &&
          name == other.name &&
          bio == other.bio &&
          age == other.age;

  @override
  int get hashCode => Object.hash(name, bio, age);

  @override
  String toString() => 'GetProfileResult(name: $name, bio: $bio, age: $age)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<GetProfileResult> getProfile({required String userId}) async {
    final params = <dynamic>[
      userId,
    ];
    final result = await _client.call('api.getProfile', params);
    return GetProfileResult.fromJson(result as Map<String, dynamic>);
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

