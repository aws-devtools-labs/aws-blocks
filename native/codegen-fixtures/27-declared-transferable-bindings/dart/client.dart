// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:example_iot_native/example_iot_native.dart' show DeviceHandle, DeviceLink;
import 'package:example_sensor_native/example_sensor_native.dart' show SensorStream;
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;
export 'package:blocks_runtime/blocks_runtime.dart' show UnknownTransferable;

// --- Models ---

class DeviceLabel {
  final String name;

  DeviceLabel({
    required this.name,
  }) {
    if (!(name.length >= 1)) throw ArgumentError('name must be at least 1 characters');
  }

  factory DeviceLabel.fromJson(Map<String, dynamic> json) {
    return DeviceLabel(
      name: json['name'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DeviceLabel &&
          name == other.name;

  @override
  int get hashCode => name.hashCode;

  @override
  String toString() => 'DeviceLabel(name: $name)';
}


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

  Future<DeviceHandle> getDeviceHandle({required String deviceId}) async {
    final params = <dynamic>[
      deviceId,
    ];
    final result = await _client.call('api.getDeviceHandle', params);
    return DeviceHandle.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag: 'example-iot/device-handle'));
  }

  Future<DeviceLink<ConnectDeviceResultMessage>> connectDevice({required String deviceId}) async {
    final params = <dynamic>[
      deviceId,
    ];
    final result = await _client.call('api.connectDevice', params);
    return DeviceLink<ConnectDeviceResultMessage>.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag: 'example-iot/device-link'), (json) => ConnectDeviceResultMessage.fromJson(json));
  }

  Future<DeviceHandle> findDeviceHandle({required String serialNumber}) async {
    final params = <dynamic>[
      serialNumber,
    ];
    final result = await _client.call('api.findDeviceHandle', params);
    return DeviceHandle.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag: 'example-iot/device-handle'));
  }

  Future<SensorStream> openSensorStream({required String sensorId}) async {
    final params = <dynamic>[
      sensorId,
    ];
    final result = await _client.call('api.openSensorStream', params);
    return SensorStream.fromBlocksDescriptor(validateTransferableDescriptor(result, expectedTag: 'example-sensor/stream'));
  }

  Future<UnknownTransferable> openGatewayLink({required String gatewayId}) async {
    final params = <dynamic>[
      gatewayId,
    ];
    final result = await _client.call('api.openGatewayLink', params);
    return UnknownTransferable.fromJson(result, expectedTag: 'example-gateway/link');
  }

  Future<UnknownTransferable> getFirmwareSession({required String deviceId}) async {
    final params = <dynamic>[
      deviceId,
    ];
    final result = await _client.call('api.getFirmwareSession', params);
    return UnknownTransferable.fromJson(result, expectedTag: 'example-iot/firmware-session');
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

