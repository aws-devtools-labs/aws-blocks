// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class GetEventResult {
  final String id;
  final String createdAt;
  final String date;
  final String time;
  final String url;
  final String email;

  const GetEventResult({
    required this.id,
    required this.createdAt,
    required this.date,
    required this.time,
    required this.url,
    required this.email,
  });

  factory GetEventResult.fromJson(Map<String, dynamic> json) {
    return GetEventResult(
      id: json['id'] as String,
      createdAt: json['createdAt'] as String,
      date: json['date'] as String,
      time: json['time'] as String,
      url: json['url'] as String,
      email: json['email'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'createdAt': createdAt,
      'date': date,
      'time': time,
      'url': url,
      'email': email,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetEventResult &&
          id == other.id &&
          createdAt == other.createdAt &&
          date == other.date &&
          time == other.time &&
          url == other.url &&
          email == other.email;

  @override
  int get hashCode => Object.hash(id, createdAt, date, time, url, email);

  @override
  String toString() => 'GetEventResult(id: $id, createdAt: $createdAt, date: $date, time: $time, url: $url, email: $email)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<GetEventResult> getEvent({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('api.getEvent', params);
    return GetEventResult.fromJson(result as Map<String, dynamic>);
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

