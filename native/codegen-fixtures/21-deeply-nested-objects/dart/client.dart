// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class GetOrganizationResultAddressContact {
  final String email;

  const GetOrganizationResultAddressContact({
    required this.email,
  });

  factory GetOrganizationResultAddressContact.fromJson(Map<String, dynamic> json) {
    return GetOrganizationResultAddressContact(
      email: json['email'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'email': email,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetOrganizationResultAddressContact &&
          email == other.email;

  @override
  int get hashCode => email.hashCode;

  @override
  String toString() => 'GetOrganizationResultAddressContact(email: $email)';
}


class GetOrganizationResultAddress {
  final String street;
  final String city;
  final GetOrganizationResultAddressContact contact;

  const GetOrganizationResultAddress({
    required this.street,
    required this.city,
    required this.contact,
  });

  factory GetOrganizationResultAddress.fromJson(Map<String, dynamic> json) {
    return GetOrganizationResultAddress(
      street: json['street'] as String,
      city: json['city'] as String,
      contact: GetOrganizationResultAddressContact.fromJson(json['contact'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'street': street,
      'city': city,
      'contact': contact.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetOrganizationResultAddress &&
          street == other.street &&
          city == other.city &&
          contact == other.contact;

  @override
  int get hashCode => Object.hash(street, city, contact);

  @override
  String toString() => 'GetOrganizationResultAddress(street: $street, city: $city, contact: $contact)';
}


class GetOrganizationResultOwnerContact {
  final String email;
  final String phone;

  const GetOrganizationResultOwnerContact({
    required this.email,
    required this.phone,
  });

  factory GetOrganizationResultOwnerContact.fromJson(Map<String, dynamic> json) {
    return GetOrganizationResultOwnerContact(
      email: json['email'] as String,
      phone: json['phone'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'email': email,
      'phone': phone,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetOrganizationResultOwnerContact &&
          email == other.email &&
          phone == other.phone;

  @override
  int get hashCode => Object.hash(email, phone);

  @override
  String toString() => 'GetOrganizationResultOwnerContact(email: $email, phone: $phone)';
}


class GetOrganizationResultOwner {
  final String name;
  final GetOrganizationResultOwnerContact contact;

  const GetOrganizationResultOwner({
    required this.name,
    required this.contact,
  });

  factory GetOrganizationResultOwner.fromJson(Map<String, dynamic> json) {
    return GetOrganizationResultOwner(
      name: json['name'] as String,
      contact: GetOrganizationResultOwnerContact.fromJson(json['contact'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'contact': contact.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetOrganizationResultOwner &&
          name == other.name &&
          contact == other.contact;

  @override
  int get hashCode => Object.hash(name, contact);

  @override
  String toString() => 'GetOrganizationResultOwner(name: $name, contact: $contact)';
}


class ApiCreateOrganizationInputAddress {
  final String street;
  final String city;
  final String countryCode;

  const ApiCreateOrganizationInputAddress({
    required this.street,
    required this.city,
    required this.countryCode,
  });

  factory ApiCreateOrganizationInputAddress.fromJson(Map<String, dynamic> json) {
    return ApiCreateOrganizationInputAddress(
      street: json['street'] as String,
      city: json['city'] as String,
      countryCode: json['countryCode'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'street': street,
      'city': city,
      'countryCode': countryCode,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiCreateOrganizationInputAddress &&
          street == other.street &&
          city == other.city &&
          countryCode == other.countryCode;

  @override
  int get hashCode => Object.hash(street, city, countryCode);

  @override
  String toString() => 'ApiCreateOrganizationInputAddress(street: $street, city: $city, countryCode: $countryCode)';
}


class ApiCreateOrganizationInputOwner {
  final String name;
  final String email;

  const ApiCreateOrganizationInputOwner({
    required this.name,
    required this.email,
  });

  factory ApiCreateOrganizationInputOwner.fromJson(Map<String, dynamic> json) {
    return ApiCreateOrganizationInputOwner(
      name: json['name'] as String,
      email: json['email'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'email': email,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiCreateOrganizationInputOwner &&
          name == other.name &&
          email == other.email;

  @override
  int get hashCode => Object.hash(name, email);

  @override
  String toString() => 'ApiCreateOrganizationInputOwner(name: $name, email: $email)';
}


class ApiUpdateOrganizationInputAddress {
  final String street;
  final String city;
  final String zip;

  const ApiUpdateOrganizationInputAddress({
    required this.street,
    required this.city,
    required this.zip,
  });

  factory ApiUpdateOrganizationInputAddress.fromJson(Map<String, dynamic> json) {
    return ApiUpdateOrganizationInputAddress(
      street: json['street'] as String,
      city: json['city'] as String,
      zip: json['zip'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'street': street,
      'city': city,
      'zip': zip,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiUpdateOrganizationInputAddress &&
          street == other.street &&
          city == other.city &&
          zip == other.zip;

  @override
  int get hashCode => Object.hash(street, city, zip);

  @override
  String toString() => 'ApiUpdateOrganizationInputAddress(street: $street, city: $city, zip: $zip)';
}


class ApiUpdateOrganizationInputOwner {
  final String name;
  final GetOrganizationResultOwnerContact contact;

  const ApiUpdateOrganizationInputOwner({
    required this.name,
    required this.contact,
  });

  factory ApiUpdateOrganizationInputOwner.fromJson(Map<String, dynamic> json) {
    return ApiUpdateOrganizationInputOwner(
      name: json['name'] as String,
      contact: GetOrganizationResultOwnerContact.fromJson(json['contact'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'contact': contact.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiUpdateOrganizationInputOwner &&
          name == other.name &&
          contact == other.contact;

  @override
  int get hashCode => Object.hash(name, contact);

  @override
  String toString() => 'ApiUpdateOrganizationInputOwner(name: $name, contact: $contact)';
}


// --- API Namespaces ---

class GetOrganizationResult {
  final String id;
  final String name;
  final GetOrganizationResultAddress address;
  final GetOrganizationResultOwner owner;

  const GetOrganizationResult({
    required this.id,
    required this.name,
    required this.address,
    required this.owner,
  });

  factory GetOrganizationResult.fromJson(Map<String, dynamic> json) {
    return GetOrganizationResult(
      id: json['id'] as String,
      name: json['name'] as String,
      address: GetOrganizationResultAddress.fromJson(json['address'] as Map<String, dynamic>),
      owner: GetOrganizationResultOwner.fromJson(json['owner'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'address': address.toJson(),
      'owner': owner.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetOrganizationResult &&
          id == other.id &&
          name == other.name &&
          address == other.address &&
          owner == other.owner;

  @override
  int get hashCode => Object.hash(id, name, address, owner);

  @override
  String toString() => 'GetOrganizationResult(id: $id, name: $name, address: $address, owner: $owner)';
}


class ApiCreateOrganizationInput {
  final String name;
  final ApiCreateOrganizationInputAddress address;
  final ApiCreateOrganizationInputOwner owner;

  const ApiCreateOrganizationInput({
    required this.name,
    required this.address,
    required this.owner,
  });

  factory ApiCreateOrganizationInput.fromJson(Map<String, dynamic> json) {
    return ApiCreateOrganizationInput(
      name: json['name'] as String,
      address: ApiCreateOrganizationInputAddress.fromJson(json['address'] as Map<String, dynamic>),
      owner: ApiCreateOrganizationInputOwner.fromJson(json['owner'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'address': address.toJson(),
      'owner': owner.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiCreateOrganizationInput &&
          name == other.name &&
          address == other.address &&
          owner == other.owner;

  @override
  int get hashCode => Object.hash(name, address, owner);

  @override
  String toString() => 'ApiCreateOrganizationInput(name: $name, address: $address, owner: $owner)';
}


class CreateOrganizationResult {
  final String id;

  const CreateOrganizationResult({
    required this.id,
  });

  factory CreateOrganizationResult.fromJson(Map<String, dynamic> json) {
    return CreateOrganizationResult(
      id: json['id'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CreateOrganizationResult &&
          id == other.id;

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'CreateOrganizationResult(id: $id)';
}


class ApiUpdateOrganizationInput {
  final String id;
  final String? name;
  final ApiUpdateOrganizationInputAddress? address;
  final ApiUpdateOrganizationInputOwner? owner;

  const ApiUpdateOrganizationInput({
    required this.id,
    this.name,
    this.address,
    this.owner,
  });

  factory ApiUpdateOrganizationInput.fromJson(Map<String, dynamic> json) {
    return ApiUpdateOrganizationInput(
      id: json['id'] as String,
      name: json['name'] as String?,
      address: json['address'] != null ? ApiUpdateOrganizationInputAddress.fromJson(json['address'] as Map<String, dynamic>) : null,
      owner: json['owner'] != null ? ApiUpdateOrganizationInputOwner.fromJson(json['owner'] as Map<String, dynamic>) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      if (name != null) 'name': name,
      if (address != null) 'address': address?.toJson(),
      if (owner != null) 'owner': owner?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiUpdateOrganizationInput &&
          id == other.id &&
          name == other.name &&
          address == other.address &&
          owner == other.owner;

  @override
  int get hashCode => Object.hash(id, name, address, owner);

  @override
  String toString() => 'ApiUpdateOrganizationInput(id: $id, name: $name, address: $address, owner: $owner)';
}


class UpdateOrganizationResult {
  final bool ok;

  const UpdateOrganizationResult({
    required this.ok,
  });

  factory UpdateOrganizationResult.fromJson(Map<String, dynamic> json) {
    return UpdateOrganizationResult(
      ok: json['ok'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'ok': ok,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UpdateOrganizationResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'UpdateOrganizationResult(ok: $ok)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<GetOrganizationResult> getOrganization({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('api.getOrganization', params);
    return GetOrganizationResult.fromJson(result as Map<String, dynamic>);
  }

  Future<CreateOrganizationResult> createOrganization({required ApiCreateOrganizationInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.createOrganization', params);
    return CreateOrganizationResult.fromJson(result as Map<String, dynamic>);
  }

  Future<UpdateOrganizationResult> updateOrganization({required ApiUpdateOrganizationInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.updateOrganization', params);
    return UpdateOrganizationResult.fromJson(result as Map<String, dynamic>);
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

