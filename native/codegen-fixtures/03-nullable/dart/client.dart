// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 1.0.0 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show ApiException, BlocksClient, BlocksException, ClientClosedException, InMemorySessionStore, SessionStore, TransportException, isBlocksError;

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


class Api {
  final BlocksClient _client;
  Api(this._client);

  Future<GetProfileResult> getProfile({required String userId}) async {
    final params = <dynamic>[
      userId,
    ];
    final result = await _client.call('api.getProfile', params);
    return GetProfileResult.fromJson(result as Map<String, dynamic>);
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

