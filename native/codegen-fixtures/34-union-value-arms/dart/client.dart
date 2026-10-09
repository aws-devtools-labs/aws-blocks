// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class Point {
  final num x;
  final num y;

  const Point({
    required this.x,
    required this.y,
  });

  factory Point.fromJson(Map<String, dynamic> json) {
    return Point(
      x: json['x'] as num,
      y: json['y'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'x': x,
      'y': y,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Point &&
          x == other.x &&
          y == other.y;

  @override
  int get hashCode => Object.hash(x, y);

  @override
  String toString() => 'Point(x: $x, y: $y)';
}


// --- API Namespaces ---

class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<dynamic> echoPrimitive({required dynamic value}) async {
    final params = <dynamic>[
      value,
    ];
    final result = await _client.call('api.echoPrimitive', params);
    return result as dynamic;
  }

  Future<dynamic> echoCollection({required dynamic value}) async {
    final params = <dynamic>[
      value,
    ];
    final result = await _client.call('api.echoCollection', params);
    return result as dynamic;
  }

  Future<dynamic> echoShape({required dynamic value}) async {
    final params = <dynamic>[
      value,
    ];
    final result = await _client.call('api.echoShape', params);
    return result as dynamic;
  }

  Future<dynamic> echoLiteral({required dynamic value}) async {
    final params = <dynamic>[
      value,
    ];
    final result = await _client.call('api.echoLiteral', params);
    return result as dynamic;
  }

  Future<dynamic> echoTagged({required dynamic value}) async {
    final params = <dynamic>[
      value,
    ];
    final result = await _client.call('api.echoTagged', params);
    return result as dynamic;
  }

  Future<dynamic> echoMoment({required dynamic value}) async {
    final params = <dynamic>[
      value,
    ];
    final result = await _client.call('api.echoMoment', params);
    return result as dynamic;
  }

  Future<dynamic> getFile() async {
    final result = await _client.call('api.getFile', const <dynamic>[]);
    return result as dynamic;
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

