// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class IsUpdatedFalseNextStep {
  final String name;
  final String destination;

  const IsUpdatedFalseNextStep({
    required this.name,
    required this.destination,
  });

  factory IsUpdatedFalseNextStep.fromJson(Map<String, dynamic> json) {
    return IsUpdatedFalseNextStep(
      name: json['name'] as String,
      destination: json['destination'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'destination': destination,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is IsUpdatedFalseNextStep &&
          name == other.name &&
          destination == other.destination;

  @override
  int get hashCode => Object.hash(name, destination);

  @override
  String toString() => 'IsUpdatedFalseNextStep(name: $name, destination: $destination)';
}


// --- API Namespaces ---

sealed class UpdateAttributesResult {
  const UpdateAttributesResult();
  Map<String, dynamic> toJson();
  static UpdateAttributesResult fromJson(Map<String, dynamic> json) {
    switch (json['isUpdated'] as bool) {
      case true: return IsUpdatedTrue.fromJson(json);
      case false: return IsUpdatedFalse.fromJson(json);
    }
  }
}

class IsUpdatedTrue extends UpdateAttributesResult {

  const IsUpdatedTrue();

  factory IsUpdatedTrue.fromJson(Map<String, dynamic> json) {
    return IsUpdatedTrue(
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'isUpdated': true,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is IsUpdatedTrue;

  @override
  int get hashCode => runtimeType.hashCode;

  @override
  String toString() => 'IsUpdatedTrue()';
}

class IsUpdatedFalse extends UpdateAttributesResult {
  final IsUpdatedFalseNextStep nextStep;

  const IsUpdatedFalse({
    required this.nextStep,
  });

  factory IsUpdatedFalse.fromJson(Map<String, dynamic> json) {
    return IsUpdatedFalse(
      nextStep: IsUpdatedFalseNextStep.fromJson(json['nextStep'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'isUpdated': false,
      'nextStep': nextStep.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is IsUpdatedFalse &&
          nextStep == other.nextStep;

  @override
  int get hashCode => nextStep.hashCode;

  @override
  String toString() => 'IsUpdatedFalse(nextStep: $nextStep)';
}



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

  Future<Map<String, UpdateAttributesResult?>> updateAttributes({required Map<String, String> attributes}) async {
    final params = <String, dynamic>{
      'attributes': attributes,
    };
    final result = await _client.call('api.updateAttributes', params);
    return (result as Map<String, dynamic>).map((k, v) => MapEntry(k, v == null ? null : UpdateAttributesResult.fromJson(v as Map<String, dynamic>)));
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

