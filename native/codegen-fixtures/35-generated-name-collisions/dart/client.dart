// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class ProfileUser_name {
  final String first;

  const ProfileUser_name({
    required this.first,
  });

  factory ProfileUser_name.fromJson(Map<String, dynamic> json) {
    return ProfileUser_name(
      first: json['first'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'first': first,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ProfileUser_name &&
          first == other.first;

  @override
  int get hashCode => first.hashCode;

  @override
  String toString() => 'ProfileUser_name(first: $first)';
}


class ProfileUserName {
  final String last;

  const ProfileUserName({
    required this.last,
  });

  factory ProfileUserName.fromJson(Map<String, dynamic> json) {
    return ProfileUserName(
      last: json['last'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'last': last,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ProfileUserName &&
          last == other.last;

  @override
  int get hashCode => last.hashCode;

  @override
  String toString() => 'ProfileUserName(last: $last)';
}


class ProfileMeta {
  final String x;

  const ProfileMeta({
    required this.x,
  });

  factory ProfileMeta.fromJson(Map<String, dynamic> json) {
    return ProfileMeta(
      x: json['x'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'x': x,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ProfileMeta &&
          x == other.x;

  @override
  int get hashCode => x.hashCode;

  @override
  String toString() => 'ProfileMeta(x: $x)';
}


enum ProfileState {
  inProgress,
  in_progress
;

  static const _jsonMap = <String, ProfileState>{
    'in-progress': inProgress,
    'in_progress': in_progress,
  };
  static const _toJsonMap = <ProfileState, String>{
    inProgress: 'in-progress',
    in_progress: 'in_progress',
  };
  String toJson() => _toJsonMap[this]!;
  static ProfileState fromJson(String json) => _jsonMap[json]!;
}


// --- API Namespaces ---

class Profile {
  final ProfileUser_name user_name;
  final ProfileUserName userName;
  final ProfileMeta Meta;
  final ProfileState state;

  const Profile({
    required this.user_name,
    required this.userName,
    required this.Meta,
    required this.state,
  });

  factory Profile.fromJson(Map<String, dynamic> json) {
    return Profile(
      user_name: ProfileUser_name.fromJson(json['user_name'] as Map<String, dynamic>),
      userName: ProfileUserName.fromJson(json['userName'] as Map<String, dynamic>),
      Meta: ProfileMeta.fromJson(json['Meta'] as Map<String, dynamic>),
      state: ProfileState.fromJson(json['state'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'user_name': user_name.toJson(),
      'userName': userName.toJson(),
      'Meta': Meta.toJson(),
      'state': state.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Profile &&
          user_name == other.user_name &&
          userName == other.userName &&
          Meta == other.Meta &&
          state == other.state;

  @override
  int get hashCode => Object.hash(user_name, userName, Meta, state);

  @override
  String toString() => 'Profile(user_name: $user_name, userName: $userName, Meta: $Meta, state: $state)';
}


class Bag {
  final String attributes;
  final Map<String, String> additionalProperties;

  const Bag({
    required this.attributes,
    this.additionalProperties = const {},
  });

  factory Bag.fromJson(Map<String, dynamic> json) {
    const knownKeys = {'attributes'};
    return Bag(
      attributes: json['attributes'] as String,
      additionalProperties: Map.fromEntries(
        json.entries.where((e) => !knownKeys.contains(e.key))
            .map((e) => MapEntry(e.key, e.value as String)),
      ),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'attributes': attributes,
      for (final e in additionalProperties.entries)
        if (!const {'attributes'}.contains(e.key)) e.key: e.value,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Bag &&
          attributes == other.attributes &&
          blocksDeepEquals(additionalProperties, other.additionalProperties);

  @override
  int get hashCode => Object.hash(attributes, blocksDeepHash(additionalProperties));

  @override
  String toString() => 'Bag(attributes: $attributes, additionalProperties: $additionalProperties)';
}


class Weird {
  final String backSlash;

  const Weird({
    required this.backSlash,
  });

  factory Weird.fromJson(Map<String, dynamic> json) {
    return Weird(
      backSlash: json['back\\slash'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'back\\slash': backSlash,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Weird &&
          backSlash == other.backSlash;

  @override
  int get hashCode => backSlash.hashCode;

  @override
  String toString() => 'Weird(backSlash: $backSlash)';
}


class ApiSendResult {
  final String sent;

  const ApiSendResult({
    required this.sent,
  });

  factory ApiSendResult.fromJson(Map<String, dynamic> json) {
    return ApiSendResult(
      sent: json['sent'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'sent': sent,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiSendResult &&
          sent == other.sent;

  @override
  int get hashCode => sent.hashCode;

  @override
  String toString() => 'ApiSendResult(sent: $sent)';
}


class Same {
  final String a;

  const Same({
    required this.a,
  });

  factory Same.fromJson(Map<String, dynamic> json) {
    return Same(
      a: json['a'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'a': a,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Same &&
          a == other.a;

  @override
  int get hashCode => a.hashCode;

  @override
  String toString() => 'Same(a: $a)';
}


class Same2 {
  final num b;

  const Same2({
    required this.b,
  });

  factory Same2.fromJson(Map<String, dynamic> json) {
    return Same2(
      b: json['b'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'b': b,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Same2 &&
          b == other.b;

  @override
  int get hashCode => b.hashCode;

  @override
  String toString() => 'Same2(b: $b)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<ApiSendResult> send({required String request, required String class$, String? args, String? json}) async {
    final params = <dynamic>[
      request,
      class$,
      if (args != null || json != null) args,
      if (json != null) json,
    ];
    final result = await _client.call('api.send', params);
    return ApiSendResult.fromJson(result as Map<String, dynamic>);
  }

  Future<Profile> getProfile({required Profile profile}) async {
    final params = <dynamic>[
      profile.toJson(),
    ];
    final result = await _client.call('api.getProfile', params);
    return Profile.fromJson(result as Map<String, dynamic>);
  }

  Future<Same> one() async {
    final result = await _client.call('api.one', const <dynamic>[]);
    return Same.fromJson(result as Map<String, dynamic>);
  }

  Future<Same2> two() async {
    final result = await _client.call('api.two', const <dynamic>[]);
    return Same2.fromJson(result as Map<String, dynamic>);
  }

  Future<String> relay({required String client}) async {
    final params = <dynamic>[
      client,
    ];
    final result = await _client.call('api.relay', params);
    return result as String;
  }

  Future<Bag> putBag({required Bag bag}) async {
    final params = <dynamic>[
      bag.toJson(),
    ];
    final result = await _client.call('api.putBag', params);
    return Bag.fromJson(result as Map<String, dynamic>);
  }

  Future<Weird> getWeird({required Weird weird}) async {
    final params = <dynamic>[
      weird.toJson(),
    ];
    final result = await _client.call('api.getWeird', params);
    return Weird.fromJson(result as Map<String, dynamic>);
  }
}


class ABApi {
  final BlocksClient _client;
  ABApi(this._client);

  Future<String> ping() async {
    final result = await _client.call('a.b.ping', const <dynamic>[]);
    return result as String;
  }
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;
  late final ABApi aB;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    api = ApiApi(client);
    aB = ABApi(client);
  }
}

