/// Intermediate representation produced by the parser.
/// TypeRef is a sealed class representing unresolved type references from the spec.

class Constraints {
  final String? format;
  final int? minLength;
  final int? maxLength;
  final String? pattern;
  final num? minimum;
  final num? maximum;
  final num? exclusiveMinimum;
  final num? exclusiveMaximum;
  final num? multipleOf;
  final int? minItems;
  final int? maxItems;
  const Constraints(
      {this.format,
      this.minLength,
      this.maxLength,
      this.pattern,
      this.minimum,
      this.maximum,
      this.exclusiveMinimum,
      this.exclusiveMaximum,
      this.multipleOf,
      this.minItems,
      this.maxItems});
  bool get isEmpty =>
      format == null &&
      minLength == null &&
      maxLength == null &&
      pattern == null &&
      minimum == null &&
      maximum == null &&
      exclusiveMinimum == null &&
      exclusiveMaximum == null &&
      multipleOf == null &&
      minItems == null &&
      maxItems == null;
}

sealed class TypeRef {
  const TypeRef();
}

class PrimitiveRef extends TypeRef {
  final String dartType; // String, int, num, bool, dynamic
  final Constraints? constraints;
  const PrimitiveRef(this.dartType, {this.constraints});
}

class InlineObjectRef extends TypeRef {
  final Map<String, TypeRef> properties;
  final Set<String> required;
  final TypeRef? additionalProperties;
  const InlineObjectRef(
      {required this.properties,
      required this.required,
      this.additionalProperties});
}

class ArrayRef extends TypeRef {
  final TypeRef items;
  final Constraints? constraints;
  const ArrayRef(this.items, {this.constraints});
}

class TupleRef extends TypeRef {
  final List<TypeRef> items;
  const TupleRef(this.items);
}

class MapRef extends TypeRef {
  final TypeRef valueType;
  const MapRef(this.valueType);
}

class NullableRef extends TypeRef {
  final TypeRef inner;
  const NullableRef(this.inner);
}

class SchemaRefRef extends TypeRef {
  final String name;
  const SchemaRefRef(this.name);
}

class UnionLiteralRef extends TypeRef {
  final List<String> values;
  const UnionLiteralRef(this.values);
}

class DiscriminatedUnionRef extends TypeRef {
  final String discriminant;
  final List<UnionVariant> variants;
  const DiscriminatedUnionRef(
      {required this.discriminant, required this.variants});
}

class UnionVariant {
  final String discriminantValue;
  final Map<String, TypeRef> properties;
  final Set<String> required;
  final DiscriminatedUnionRef? embeddedUnion;
  const UnionVariant({
    required this.discriminantValue,
    required this.properties,
    required this.required,
    this.embeddedUnion,
  });
}

class TransferableRef extends TypeRef {
  final String blocksType; // e.g. "realtime/channel", "file-bucket/download"
  final List<TypeRef> typeArgs;
  const TransferableRef({required this.blocksType, this.typeArgs = const []});
}

/// A parameter in an RPC method.
class RpcParam {
  final String name;
  final bool isRequired;
  final TypeRef schema;
  const RpcParam(
      {required this.name, required this.isRequired, required this.schema});
}

/// An RPC method from the spec.
class RpcMethod {
  final String name; // dotted name e.g. "api.createTodo"
  final List<RpcParam> params;
  final TypeRef result;

  /// The explicitly declared name of the result content descriptor, if any
  /// (OpenRPC `result.name`). When present this is authoritative for the
  /// generated result type's identity; null when the spec omits it.
  final String? resultName;

  const RpcMethod({
    required this.name,
    required this.params,
    required this.result,
    this.resultName,
  });
}

/// A server entry from the spec.
class Server {
  final String name;
  final String url;
  const Server({required this.name, required this.url});
}

/// The complete parsed model from an OpenRPC spec.
class RpcModel {
  final String title;
  final String version;
  final List<RpcMethod> methods;
  final Map<String, TypeRef> schemas; // components/schemas
  final List<Server> servers;
  const RpcModel({
    required this.title,
    required this.version,
    required this.methods,
    required this.schemas,
    this.servers = const [],
  });
}
