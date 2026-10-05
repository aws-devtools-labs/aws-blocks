// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;
export 'package:blocks_runtime/blocks_runtime.dart' show UnknownTransferable;

// --- Models ---

class ConnectDeviceResultMessage {
  final num temperature;
  final num humidity;

  const ConnectDeviceResultMessage({
    required this.temperature,
    required this.humidity,
  });

  factory ConnectDeviceResultMessage.fromJson(Map<String, dynamic> json) {
    return ConnectDeviceResultMessage(
      temperature: json['temperature'] as num,
      humidity: json['humidity'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'temperature': temperature,
      'humidity': humidity,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ConnectDeviceResultMessage &&
          temperature == other.temperature &&
          humidity == other.humidity;

  @override
  int get hashCode => Object.hash(temperature, humidity);

  @override
  String toString() => 'ConnectDeviceResultMessage(temperature: $temperature, humidity: $humidity)';
}


// --- API Namespaces ---

class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<UnknownTransferable> getDeviceHandle({required String deviceId}) async {
    final params = <String, dynamic>{
      'deviceId': deviceId,
    };
    final result = await _client.call('api.getDeviceHandle', params);
    return UnknownTransferable.fromJson(result, expectedTag: 'example-iot/device-handle');
  }

  Future<UnknownTransferable> connectDevice({required String deviceId}) async {
    final params = <String, dynamic>{
      'deviceId': deviceId,
    };
    final result = await _client.call('api.connectDevice', params);
    return UnknownTransferable.fromJson(result, expectedTag: 'example-iot/device-link');
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

