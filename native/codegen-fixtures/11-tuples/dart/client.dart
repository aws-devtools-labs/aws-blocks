// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class QueryRangeResultWhere {
  final (String, String) between;

  const QueryRangeResultWhere({
    required this.between,
  });

  factory QueryRangeResultWhere.fromJson(Map<String, dynamic> json) {
    return QueryRangeResultWhere(
      between: ((json['between'] as List<dynamic>)[0] as String, (json['between'] as List<dynamic>)[1] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'between': [between.$1, between.$2],
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is QueryRangeResultWhere &&
          between == other.between;

  @override
  int get hashCode => between.hashCode;

  @override
  String toString() => 'QueryRangeResultWhere(between: $between)';
}


// --- API Namespaces ---

class QueryRangeResult {
  final QueryRangeResultWhere where;
  final List<(String, int)> pairs;

  const QueryRangeResult({
    required this.where,
    required this.pairs,
  });

  factory QueryRangeResult.fromJson(Map<String, dynamic> json) {
    return QueryRangeResult(
      where: QueryRangeResultWhere.fromJson(json['where'] as Map<String, dynamic>),
      pairs: (json['pairs'] as List<dynamic>).map((e) => ((e as List<dynamic>)[0] as String, ((e as List<dynamic>)[1] as num).toInt())).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'where': where.toJson(),
      'pairs': pairs.map((e) => [e.$1, e.$2]).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is QueryRangeResult &&
          where == other.where &&
          blocksDeepEquals(pairs, other.pairs);

  @override
  int get hashCode => Object.hash(where, blocksDeepHash(pairs));

  @override
  String toString() => 'QueryRangeResult(where: $where, pairs: $pairs)';
}


class GetShortTuplesResult {
  final List<num> one;
  final (String, int?) short;

  GetShortTuplesResult({
    required this.one,
    required this.short,
  }) {
    if (!(one.length >= 1)) throw ArgumentError('one must have at least 1 items');
    if (!(one.length <= 1)) throw ArgumentError('one must have at most 1 items');
  }

  factory GetShortTuplesResult.fromJson(Map<String, dynamic> json) {
    return GetShortTuplesResult(
      one: (json['one'] as List<dynamic>).cast<num>(),
      short: ((json['short'] as List<dynamic>)[0] as String, ((json['short'] as List<dynamic>).length > 1 ? (json['short'] as List<dynamic>)[1] : null) as int?),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'one': one,
      'short': [short.$1, short.$2],
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetShortTuplesResult &&
          blocksDeepEquals(one, other.one) &&
          short == other.short;

  @override
  int get hashCode => Object.hash(blocksDeepHash(one), short);

  @override
  String toString() => 'GetShortTuplesResult(one: $one, short: $short)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<(num, num, String)> getCoords() async {
    final result = await _client.call('api.getCoords', const <dynamic>[]);
    return ((result as List<dynamic>)[0] as num, (result as List<dynamic>)[1] as num, (result as List<dynamic>)[2] as String);
  }

  Future<(String, int)> getPair() async {
    final result = await _client.call('api.getPair', const <dynamic>[]);
    return ((result as List<dynamic>)[0] as String, ((result as List<dynamic>)[1] as num).toInt());
  }

  Future<QueryRangeResult> queryRange({required (num, num) range, (String, int?)? cursor}) async {
    final params = <dynamic>[
      [range.$1, range.$2],
      if (cursor != null) [cursor.$1, cursor.$2],
    ];
    final result = await _client.call('api.queryRange', params);
    return QueryRangeResult.fromJson(result as Map<String, dynamic>);
  }

  Future<GetShortTuplesResult> getShortTuples({required List<String> one}) async {
    final params = <dynamic>[
      one,
    ];
    final result = await _client.call('api.getShortTuples', params);
    return GetShortTuplesResult.fromJson(result as Map<String, dynamic>);
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

