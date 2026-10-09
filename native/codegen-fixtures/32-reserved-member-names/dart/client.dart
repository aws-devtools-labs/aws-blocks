// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class Doc {
  final String $id;
  final int? $$v;
  final String toJson$;
  final String fromJson$;
  final int hashCode$;
  final String toString$;
  final int int$;
  final String String$;
  final Level level;

  const Doc({
    required this.$id,
    this.$$v,
    required this.toJson$,
    required this.fromJson$,
    required this.hashCode$,
    required this.toString$,
    required this.int$,
    required this.String$,
    required this.level,
  });

  factory Doc.fromJson(Map<String, dynamic> json) {
    return Doc(
      $id: json['_id'] as String,
      $$v: (json['__v'] as num?)?.toInt(),
      toJson$: json['toJson'] as String,
      fromJson$: json['fromJson'] as String,
      hashCode$: (json['hashCode'] as num).toInt(),
      toString$: json['toString'] as String,
      int$: (json['int'] as num).toInt(),
      String$: json['String'] as String,
      level: Level.fromJson(json['level'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      '_id': $id,
      if ($$v != null) '__v': $$v,
      'toJson': toJson$,
      'fromJson': fromJson$,
      'hashCode': hashCode$,
      'toString': toString$,
      'int': int$,
      'String': String$,
      'level': level.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Doc &&
          $id == other.$id &&
          $$v == other.$$v &&
          toJson$ == other.toJson$ &&
          fromJson$ == other.fromJson$ &&
          hashCode$ == other.hashCode$ &&
          toString$ == other.toString$ &&
          int$ == other.int$ &&
          String$ == other.String$ &&
          level == other.level;

  @override
  int get hashCode => Object.hash($id, $$v, toJson$, fromJson$, hashCode$, toString$, int$, String$, level);

  @override
  String toString() => 'Doc(\$id: ${$id}, \$\$v: ${$$v}, toJson\$: ${toJson$}, fromJson\$: ${fromJson$}, hashCode\$: ${hashCode$}, toString\$: ${toString$}, int\$: ${int$}, String\$: ${String$}, level: $level)';
}


class Extras {
  final String additionalProperties$;
  final String id;
  final Map<String, int> additionalProperties;

  const Extras({
    required this.additionalProperties$,
    required this.id,
    this.additionalProperties = const {},
  });

  factory Extras.fromJson(Map<String, dynamic> json) {
    const knownKeys = {'additionalProperties', 'id'};
    return Extras(
      additionalProperties$: json['additionalProperties'] as String,
      id: json['id'] as String,
      additionalProperties: Map.fromEntries(
        json.entries.where((e) => !knownKeys.contains(e.key))
            .map((e) => MapEntry(e.key, e.value as int)),
      ),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'additionalProperties': additionalProperties$,
      'id': id,
      for (final e in additionalProperties.entries)
        if (!const {'additionalProperties', 'id'}.contains(e.key)) e.key: e.value,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Extras &&
          additionalProperties$ == other.additionalProperties$ &&
          id == other.id &&
          blocksDeepEquals(additionalProperties, other.additionalProperties);

  @override
  int get hashCode => Object.hash(additionalProperties$, id, blocksDeepHash(additionalProperties));

  @override
  String toString() => 'Extras(additionalProperties\$: ${additionalProperties$}, id: $id, additionalProperties: $additionalProperties)';
}


enum Level {
  values$,
  index$,
  name$,
  $hidden,
  ok
;

  static const _jsonMap = <String, Level>{
    'values': values$,
    'index': index$,
    'name': name$,
    '_hidden': $hidden,
    'ok': ok,
  };
  static const _toJsonMap = <Level, String>{
    values$: 'values',
    index$: 'index',
    name$: 'name',
    $hidden: '_hidden',
    ok: 'ok',
  };
  String toJson() => _toJsonMap[this]!;
  static Level fromJson(String json) => _jsonMap[json]!;
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Doc> getDoc({required String $id, int? int$}) async {
    final params = <dynamic>[
      $id,
      if (int$ != null) int$,
    ];
    final result = await _client.call('api.getDoc', params);
    return Doc.fromJson(result as Map<String, dynamic>);
  }

  Future<Extras> putExtras({required Extras extras}) async {
    final params = <dynamic>[
      extras.toJson(),
    ];
    final result = await _client.call('api.putExtras', params);
    return Extras.fromJson(result as Map<String, dynamic>);
  }

  Future<Level> getLevel() async {
    final result = await _client.call('api.getLevel', const <dynamic>[]);
    return Level.fromJson(result as String);
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

