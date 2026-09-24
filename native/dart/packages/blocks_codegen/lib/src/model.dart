/// Intermediate representation produced by the parser.
/// TypeRef is a sealed class representing unresolved type references from the spec.
library;

/// Validation keywords carried across from a JSON Schema node, in the shapes
/// JSON Schema uses. A field is null when the spec did not set that keyword.
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
  const Constraints({
    this.format,
    this.minLength,
    this.maxLength,
    this.pattern,
    this.minimum,
    this.maximum,
    this.exclusiveMinimum,
    this.exclusiveMaximum,
    this.multipleOf,
    this.minItems,
    this.maxItems,
  });
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

/// A type reference straight from the spec, before names are assigned and
/// `$ref`s are resolved. Switch over the subclasses exhaustively.
sealed class TypeRef {
  const TypeRef();
}

class PrimitiveRef extends TypeRef {
  /// The Dart type name: `String`, `int`, `num`, `bool`, `void` or `dynamic`.
  final String dartType;

  final Constraints? constraints;

  const PrimitiveRef(this.dartType, {this.constraints});
}

/// An object declared inline rather than under `components/schemas`. The
/// builder synthesizes a record type and a name for it.
class InlineObjectRef extends TypeRef {
  /// In spec order, which fixes generated field order.
  final Map<String, TypeRef> properties;

  final Set<String> required;

  final TypeRef? additionalProperties;

  /// [required] should only name keys that also appear in [properties].
  const InlineObjectRef({
    required this.properties,
    required this.required,
    this.additionalProperties,
  });
}

/// A homogeneous list. Becomes `List<T>`.
class ArrayRef extends TypeRef {
  /// A spec `items` that is absent or empty becomes `dynamic`.
  final TypeRef items;

  final Constraints? constraints;

  const ArrayRef(this.items, {this.constraints});
}

/// A fixed-length positional tuple, from `prefixItems` or an array-form
/// `items`. Becomes a Dart record.
class TupleRef extends TypeRef {
  /// Single-element tuples are unwrapped by the parser and never reach here.
  final List<TypeRef> items;

  const TupleRef(this.items);
}

/// An object with only `additionalProperties`. Becomes `Map<String, V>`.
class MapRef extends TypeRef {
  final TypeRef valueType;

  const MapRef(this.valueType);
}

/// Marks [inner] as optional. Comes from a `oneOf` with a `{"type":"null"}`
/// member.
class NullableRef extends TypeRef {
  final TypeRef inner;

  const NullableRef(this.inner);
}

/// A `$ref` pointing at a named schema, resolved later by the builder.
class SchemaRefRef extends TypeRef {
  /// The schema's key under `components/schemas`: the `$ref` basename, not the
  /// whole JSON pointer.
  final String name;

  const SchemaRefRef(this.name);
}

/// An `enum` on a string schema, or on one with no declared type. Becomes a
/// Dart enum. An `enum` on any other primitive stays that primitive, since a
/// Dart enum cannot have members named `true` or `false`.
class UnionLiteralRef extends TypeRef {
  /// In spec order, which fixes the generated enum's member order.
  final List<String> values;

  const UnionLiteralRef(this.values);
}

/// A `oneOf` whose arms are objects sharing a single-value enum field. Becomes
/// a sealed class with one subclass per arm.
class DiscriminatedUnionRef extends TypeRef {
  final String discriminant;

  final List<UnionVariant> variants;

  /// True when the discriminant is a boolean-enum (`{"type":"boolean",
  /// "enum":[true|false]}`) rather than the usual string enum. Drives bool
  /// (vs String) discriminant handling in the generator.
  final bool discriminantIsBoolean;

  /// [variants] must be non-empty and share [discriminant].
  const DiscriminatedUnionRef({
    required this.discriminant,
    required this.variants,
    this.discriminantIsBoolean = false,
  });
}

class UnionVariant {
  /// The discriminant literal that selects this arm, as a string even when the
  /// discriminant is a boolean.
  final String discriminantValue;

  /// This arm's properties, excluding the discriminant itself.
  final Map<String, TypeRef> properties;

  /// Required property names, excluding the discriminant itself.
  final Set<String> required;

  /// A nested union carried alongside [properties], for hybrid arms that mix
  /// their own fields with a further `oneOf`.
  final DiscriminatedUnionRef? embeddedUnion;

  const UnionVariant({
    required this.discriminantValue,
    required this.properties,
    required this.required,
    this.embeddedUnion,
  });
}

/// A handle to a runtime capability (a realtime channel, a file transfer) that
/// crosses the wire by reference and maps to a blocks_runtime type.
class TransferableRef extends TypeRef {
  /// The `x-blocks-transferable` tag, e.g. `realtime/channel` or
  /// `file-bucket/download`.
  final String blocksType;

  final List<TypeRef> typeArgs;

  const TransferableRef({required this.blocksType, this.typeArgs = const []});
}

/// A parameter in an RPC method.
class RpcParam {
  final String name;
  final bool isRequired;
  final TypeRef schema;
  const RpcParam({
    required this.name,
    required this.isRequired,
    required this.schema,
  });
}

/// An RPC method from the spec.
class RpcMethod {
  /// Dotted wire name, e.g. `api.createTodo`. Everything before the final dot
  /// becomes the namespace.
  final String name;
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

  /// Spec `components/schemas` entries, what [SchemaRefRef] resolves to.
  final Map<String, TypeRef> schemas;

  final List<Server> servers;
  const RpcModel({
    required this.title,
    required this.version,
    required this.methods,
    required this.schemas,
    this.servers = const [],
  });
}
