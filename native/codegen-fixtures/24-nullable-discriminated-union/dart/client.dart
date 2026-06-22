// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

sealed class GetNotificationResult {
  const GetNotificationResult();
  Map<String, dynamic> toJson();
  static GetNotificationResult fromJson(Map<String, dynamic> json) {
    switch (json['type'] as String) {
      case 'email': return EmailGetNotificationResult.fromJson(json);
      case 'sms': return SmsGetNotificationResult.fromJson(json);
      default: throw ArgumentError('Unknown type: ${json['type']}');
    }
  }
}

class EmailGetNotificationResult extends GetNotificationResult {
  final String subject;
  final String body;

  const EmailGetNotificationResult({
    required this.subject,
    required this.body,
  });

  factory EmailGetNotificationResult.fromJson(Map<String, dynamic> json) {
    return EmailGetNotificationResult(
      subject: json['subject'] as String,
      body: json['body'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'type': 'email',
      'subject': subject,
      'body': body,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is EmailGetNotificationResult &&
          subject == other.subject &&
          body == other.body;

  @override
  int get hashCode => Object.hash(subject, body);

  @override
  String toString() => 'EmailGetNotificationResult(subject: $subject, body: $body)';
}

class SmsGetNotificationResult extends GetNotificationResult {
  final String message;

  const SmsGetNotificationResult({
    required this.message,
  });

  factory SmsGetNotificationResult.fromJson(Map<String, dynamic> json) {
    return SmsGetNotificationResult(
      message: json['message'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'type': 'sms',
      'message': message,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SmsGetNotificationResult &&
          message == other.message;

  @override
  int get hashCode => message.hashCode;

  @override
  String toString() => 'SmsGetNotificationResult(message: $message)';
}



class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Map<String, dynamic>> updateAttributes({required Map<String, String> attributes}) async {
    final params = <String, dynamic>{
      'attributes': attributes,
    };
    final result = await _client.call('api.updateAttributes', params);
    return (result as Map<String, dynamic>).map((k, v) => MapEntry(k, v as dynamic));
  }

  Future<GetNotificationResult?> getNotification({required String id}) async {
    final params = <String, dynamic>{
      'id': id,
    };
    final result = await _client.call('api.getNotification', params);
    return result == null ? null : GetNotificationResult.fromJson(result as Map<String, dynamic>);
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

