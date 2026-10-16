// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

enum ShipmentDestinationGeoAccuracySource {
  gps,
  cell
;

  String toJson() => name;
  static ShipmentDestinationGeoAccuracySource fromJson(String json) => values.byName(json);
}


class ShipmentDestinationGeoAccuracy {
  final num meters;
  final ShipmentDestinationGeoAccuracySource source;

  const ShipmentDestinationGeoAccuracy({
    required this.meters,
    required this.source,
  });

  factory ShipmentDestinationGeoAccuracy.fromJson(Map<String, dynamic> json) {
    return ShipmentDestinationGeoAccuracy(
      meters: json['meters'] as num,
      source: ShipmentDestinationGeoAccuracySource.fromJson(json['source'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'meters': meters,
      'source': source.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShipmentDestinationGeoAccuracy &&
          meters == other.meters &&
          source == other.source;

  @override
  int get hashCode => Object.hash(meters, source);

  @override
  String toString() => 'ShipmentDestinationGeoAccuracy(meters: $meters, source: $source)';
}


class ShipmentDestinationGeo {
  final num lat;
  final num lng;
  final ShipmentDestinationGeoAccuracy? accuracy;

  const ShipmentDestinationGeo({
    required this.lat,
    required this.lng,
    this.accuracy,
  });

  factory ShipmentDestinationGeo.fromJson(Map<String, dynamic> json) {
    return ShipmentDestinationGeo(
      lat: json['lat'] as num,
      lng: json['lng'] as num,
      accuracy: json['accuracy'] != null ? ShipmentDestinationGeoAccuracy.fromJson(json['accuracy'] as Map<String, dynamic>) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'lat': lat,
      'lng': lng,
      if (accuracy != null) 'accuracy': accuracy?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShipmentDestinationGeo &&
          lat == other.lat &&
          lng == other.lng &&
          accuracy == other.accuracy;

  @override
  int get hashCode => Object.hash(lat, lng, accuracy);

  @override
  String toString() => 'ShipmentDestinationGeo(lat: $lat, lng: $lng, accuracy: $accuracy)';
}


class ShipmentDestination {
  final String city;
  final ShipmentDestinationGeo geo;

  const ShipmentDestination({
    required this.city,
    required this.geo,
  });

  factory ShipmentDestination.fromJson(Map<String, dynamic> json) {
    return ShipmentDestination(
      city: json['city'] as String,
      geo: ShipmentDestinationGeo.fromJson(json['geo'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'city': city,
      'geo': geo.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShipmentDestination &&
          city == other.city &&
          geo == other.geo;

  @override
  int get hashCode => Object.hash(city, geo);

  @override
  String toString() => 'ShipmentDestination(city: $city, geo: $geo)';
}


class ShipmentInsurance {
  final String provider;
  final num? amount;

  const ShipmentInsurance({
    required this.provider,
    this.amount,
  });

  factory ShipmentInsurance.fromJson(Map<String, dynamic> json) {
    return ShipmentInsurance(
      provider: json['provider'] as String,
      amount: json['amount'] as num?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'provider': provider,
      if (amount != null) 'amount': amount,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShipmentInsurance &&
          provider == other.provider &&
          amount == other.amount;

  @override
  int get hashCode => Object.hash(provider, amount);

  @override
  String toString() => 'ShipmentInsurance(provider: $provider, amount: $amount)';
}


class ShipmentSignature {
  final String signedBy;
  final String signedAt;

  const ShipmentSignature({
    required this.signedBy,
    required this.signedAt,
  });

  factory ShipmentSignature.fromJson(Map<String, dynamic> json) {
    return ShipmentSignature(
      signedBy: json['signedBy'] as String,
      signedAt: json['signedAt'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'signedBy': signedBy,
      'signedAt': signedAt,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShipmentSignature &&
          signedBy == other.signedBy &&
          signedAt == other.signedAt;

  @override
  int get hashCode => Object.hash(signedBy, signedAt);

  @override
  String toString() => 'ShipmentSignature(signedBy: $signedBy, signedAt: $signedAt)';
}


class ShipmentParcels {
  final String sku;
  final num weightKg;

  const ShipmentParcels({
    required this.sku,
    required this.weightKg,
  });

  factory ShipmentParcels.fromJson(Map<String, dynamic> json) {
    return ShipmentParcels(
      sku: json['sku'] as String,
      weightKg: json['weightKg'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'sku': sku,
      'weightKg': weightKg,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShipmentParcels &&
          sku == other.sku &&
          weightKg == other.weightKg;

  @override
  int get hashCode => Object.hash(sku, weightKg);

  @override
  String toString() => 'ShipmentParcels(sku: $sku, weightKg: $weightKg)';
}


class ShipmentCustoms {
  final String code;
  final num value;

  const ShipmentCustoms({
    required this.code,
    required this.value,
  });

  factory ShipmentCustoms.fromJson(Map<String, dynamic> json) {
    return ShipmentCustoms(
      code: json['code'] as String,
      value: json['value'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'code': code,
      'value': value,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShipmentCustoms &&
          code == other.code &&
          value == other.value;

  @override
  int get hashCode => Object.hash(code, value);

  @override
  String toString() => 'ShipmentCustoms(code: $code, value: $value)';
}


class ValueResult {
  final int value;

  const ValueResult({
    required this.value,
  });

  factory ValueResult.fromJson(Map<String, dynamic> json) {
    return ValueResult(
      value: (json['value'] as num).toInt(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'value': value,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ValueResult &&
          value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'ValueResult(value: $value)';
}


class ReceiptMeta {
  final String value;

  const ReceiptMeta({
    required this.value,
  });

  factory ReceiptMeta.fromJson(Map<String, dynamic> json) {
    return ReceiptMeta(
      value: json['value'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'value': value,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ReceiptMeta &&
          value == other.value;

  @override
  int get hashCode => value.hashCode;

  @override
  String toString() => 'ReceiptMeta(value: $value)';
}


// --- API Namespaces ---

class Shipment {
  final String id;
  final ShipmentDestination destination;
  final ShipmentInsurance? insurance;
  final ShipmentSignature? signature;
  final List<ShipmentParcels> parcels;
  final Map<String, ShipmentCustoms>? customs;

  const Shipment({
    required this.id,
    required this.destination,
    this.insurance,
    required this.signature,
    required this.parcels,
    this.customs,
  });

  factory Shipment.fromJson(Map<String, dynamic> json) {
    return Shipment(
      id: json['id'] as String,
      destination: ShipmentDestination.fromJson(json['destination'] as Map<String, dynamic>),
      insurance: json['insurance'] != null ? ShipmentInsurance.fromJson(json['insurance'] as Map<String, dynamic>) : null,
      signature: json['signature'] != null ? ShipmentSignature.fromJson(json['signature'] as Map<String, dynamic>) : null,
      parcels: (json['parcels'] as List<dynamic>).map((e) => ShipmentParcels.fromJson(e as Map<String, dynamic>)).toList(),
      customs: (json['customs'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, ShipmentCustoms.fromJson(v as Map<String, dynamic>))),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'destination': destination.toJson(),
      if (insurance != null) 'insurance': insurance?.toJson(),
      'signature': signature?.toJson(),
      'parcels': parcels.map((e) => e.toJson()).toList(),
      if (customs != null) 'customs': customs?.map((k, v) => MapEntry(k, v.toJson())),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Shipment &&
          id == other.id &&
          destination == other.destination &&
          insurance == other.insurance &&
          signature == other.signature &&
          blocksDeepEquals(parcels, other.parcels) &&
          blocksDeepEquals(customs, other.customs);

  @override
  int get hashCode => Object.hash(id, destination, insurance, signature, blocksDeepHash(parcels), blocksDeepHash(customs));

  @override
  String toString() => 'Shipment(id: $id, destination: $destination, insurance: $insurance, signature: $signature, parcels: $parcels, customs: $customs)';
}


class Invoice {
  final String id;
  final ValueResult meta;

  const Invoice({
    required this.id,
    required this.meta,
  });

  factory Invoice.fromJson(Map<String, dynamic> json) {
    return Invoice(
      id: json['id'] as String,
      meta: ValueResult.fromJson(json['meta'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'meta': meta.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Invoice &&
          id == other.id &&
          meta == other.meta;

  @override
  int get hashCode => Object.hash(id, meta);

  @override
  String toString() => 'Invoice(id: $id, meta: $meta)';
}


class Receipt {
  final String id;
  final ReceiptMeta meta;

  const Receipt({
    required this.id,
    required this.meta,
  });

  factory Receipt.fromJson(Map<String, dynamic> json) {
    return Receipt(
      id: json['id'] as String,
      meta: ReceiptMeta.fromJson(json['meta'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'meta': meta.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Receipt &&
          id == other.id &&
          meta == other.meta;

  @override
  int get hashCode => Object.hash(id, meta);

  @override
  String toString() => 'Receipt(id: $id, meta: $meta)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Shipment> getShipment({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('api.getShipment', params);
    return Shipment.fromJson(result as Map<String, dynamic>);
  }

  Future<Shipment> saveShipment({required Shipment shipment}) async {
    final params = <dynamic>[
      shipment.toJson(),
    ];
    final result = await _client.call('api.saveShipment', params);
    return Shipment.fromJson(result as Map<String, dynamic>);
  }

  Future<Invoice> getInvoice() async {
    final result = await _client.call('api.getInvoice', const <dynamic>[]);
    return Invoice.fromJson(result as Map<String, dynamic>);
  }

  Future<Receipt> getReceipt() async {
    final result = await _client.call('api.getReceipt', const <dynamic>[]);
    return Receipt.fromJson(result as Map<String, dynamic>);
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

