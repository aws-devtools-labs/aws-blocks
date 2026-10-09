import 'identifiers.dart';
import 'model.dart';

/// Tags the generator maps to concrete runtime types; any other tag on a
/// direct result falls back to `UnknownTransferable`. The switches gate on this set.
const knownTransferableTags = {
  'realtime/channel',
  'file-bucket/download',
  'file-bucket/upload',
  'oidc/client',
};

/// A type after the builder has resolved `$ref`s, deduplicated structurally
/// identical shapes, and assigned a Dart name to everything that needs one.
sealed class ResolvedType {
  const ResolvedType();
}

class PrimitiveType extends ResolvedType {
  final String dartType;
  final Constraints? constraints;
  const PrimitiveType(this.dartType, {this.constraints});
}

class NullableType extends ResolvedType {
  final ResolvedType inner;
  const NullableType(this.inner);
}

class ListType extends ResolvedType {
  final ResolvedType items;
  final Constraints? constraints;
  const ListType(this.items, {this.constraints});
}

class RecordType extends ResolvedType {
  /// Mutable: collision resolution rewrites this in place when two distinct
  /// shapes claim the same name.
  String name;
  final List<RecordField> fields;

  final ResolvedType? additionalProperties;
  RecordType({
    required this.name,
    required this.fields,
    this.additionalProperties,
  });
}

class RecordField {
  final String name;
  final ResolvedType type;
  final bool isRequired;
  const RecordField({
    required this.name,
    required this.type,
    required this.isRequired,
  });
}

class EnumType extends ResolvedType {
  /// Mutable: rewritten in place by collision resolution.
  String name;
  final List<String> values;
  EnumType({required this.name, required this.values});
}

class SealedClassType extends ResolvedType {
  /// Mutable: rewritten in place by collision resolution.
  String name;
  final String discriminant;
  final List<SealedVariant> variants;

  /// True when the discriminant is a boolean enum (true/false) rather than a
  /// string enum. Drives bool (vs String) emission in the generator.
  final bool discriminantIsBoolean;

  /// For a union embedded in a hybrid arm, the enclosing arm's own keys (its
  /// discriminant and properties). They share the arm's JSON object, so an
  /// open variant of this union doesn't collect them as extra keys.
  final Set<String> enclosingKeys;
  SealedClassType({
    required this.name,
    required this.discriminant,
    required this.variants,
    this.discriminantIsBoolean = false,
    this.enclosingKeys = const {},
  });
}

class SealedVariant {
  final String discriminantValue;

  /// Mutable: rewritten in place when the builder makes type names Dart
  /// identifiers.
  String className;
  final List<RecordField> fields;
  final SealedClassType? embeddedUnion;

  /// The value type of the variant's extra keys when its arm is an open record
  /// (`additionalProperties`), as on [RecordType]. Null for a closed arm.
  final ResolvedType? additionalProperties;
  SealedVariant({
    required this.discriminantValue,
    required this.className,
    required this.fields,
    this.embeddedUnion,
    this.additionalProperties,
  });
}

class TransferableType extends ResolvedType {
  final String blocksType;
  final List<ResolvedType> typeArgs;
  const TransferableType({required this.blocksType, this.typeArgs = const []});
}

class SchemaReference extends ResolvedType {
  /// Mutable: kept in sync when the type it points at is renamed.
  String name;
  SchemaReference(this.name);
}

class MapType extends ResolvedType {
  final ResolvedType valueType;
  const MapType(this.valueType);
}

class TupleType extends ResolvedType {
  final List<ResolvedType> items;
  const TupleType(this.items);
}

/// A resolved operation (method) in the codegen model.
class Operation {
  /// The generated Dart method name, without the namespace.
  final String name;

  /// The dotted name sent on the wire, e.g. `api.createTodo`.
  final String fullName;
  final List<OperationParam> params;
  final ResolvedType result;
  const Operation({
    required this.name,
    required this.fullName,
    required this.params,
    required this.result,
  });
}

class OperationParam {
  final String name;
  final ResolvedType type;
  final bool isRequired;
  const OperationParam({
    required this.name,
    required this.type,
    required this.isRequired,
  });
}

/// A namespace grouping operations.
class Namespace {
  final String name;
  final List<Operation> operations;
  const Namespace({required this.name, required this.operations});
}

/// The complete codegen model, ready for code generation.
class CodegenModel {
  final String title;
  final String version;

  /// Operations grouped by their RPC name's namespace, meaning everything
  /// before the final dot. Methods with no dot land in `_default`.
  final List<Namespace> namespaces;

  /// Every named type to emit, from spec schemas plus synthesized inline ones,
  /// keyed by its final Dart name. Every type name (and variant class name)
  /// is a usable Dart identifier: the builder camel-cases a spec name with
  /// other characters, makes a leading `_` public and escapes one that would
  /// shadow a name the generated library uses (see `_assignDartTypeNames`).
  ///
  /// A schema that isn't a model, an enum or a union (an alias such as
  /// `UserId: string`, or a nullable object) has no declaration, and is
  /// keyed by its schema name, or, when a type's Dart name is that name, by
  /// its JSON pointer `#/components/schemas/<name>`. Every [SchemaReference]
  /// names a key of this map, except a `$ref` to a schema the spec doesn't
  /// define.
  final Map<String, ResolvedType> types;

  final List<Server> servers;

  /// Non-fatal diagnostics emitted during the build (e.g. auto-disambiguated
  /// naming collisions). Callers (CLI / build_runner) surface these to the user.
  final List<String> warnings;

  const CodegenModel({
    required this.title,
    required this.version,
    required this.namespaces,
    required this.types,
    this.servers = const [],
    this.warnings = const [],
  });
}

/// Thrown when two structurally distinct inline types resolve to the same
/// generated Dart identifier and `autoDisambiguate` is not enabled.
class NamingConflictException implements Exception {
  /// A multi-line report naming each conflicting type and where it came from.
  final String message;

  NamingConflictException(this.message);
  @override
  String toString() => 'NamingConflictException: $message';
}

/// Records where a named type was synthesized, for collision detection.
class _TypeOrigin {
  final ResolvedType type;
  final String fingerprint; // structural identity
  final String canonicalKey; // stable, order-independent sort/identity key
  final String source; // human-readable source description
  _TypeOrigin(this.type, this.fingerprint, this.canonicalKey, this.source);

  String get name => switch (type) {
    RecordType(name: final n) => n,
    EnumType(name: final n) => n,
    SealedClassType(name: final n) => n,
    _ => '',
  };
}

/// Builds a [CodegenModel] from an [RpcModel].
///
/// Reusable: calling [build] resets internal state, so the same instance
/// can safely process multiple specs sequentially.
class CodegenModelBuilder {
  /// When true, inline-type name collisions that survive qualification are a
  /// hard error. By default (false) they are auto-disambiguated with a
  /// deterministic suffix and surfaced as a build warning.
  final bool failOnCollision;

  CodegenModelBuilder({this.failOnCollision = false});

  static const _reserved = {
    'RealtimeChannel',
    'FileUploadHandle',
    'FileDownloadHandle',
    'OidcClient',
    'BlocksClient',
    'UnknownTransferable',
  };
  final Map<String, ResolvedType> _types = {};
  // What Pass 1 resolved each spec schema to, keyed by the schema's name.
  // Unlike [_types], later passes never overwrite or drop an entry.
  final Map<String, ResolvedType> _schemaTypes = {};
  // Every named type synthesized during a build, in creation order.
  final List<_TypeOrigin> _origins = [];
  // SchemaReferences produced by structural dedup, keyed by their target
  // object, so that the target's final Dart name reaches them.
  final Map<ResolvedType, List<SchemaReference>> _dedupRefs = Map.identity();
  // Every `$ref` SchemaReference the build creates, with the name of the
  // schema it points at, so that the schema's final Dart name reaches it.
  final List<(SchemaReference, String)> _refs = [];
  // Non-fatal diagnostics produced during the build.
  final List<String> _warnings = [];
  int _anonCounter = 0;

  /// Resolves [rpc] into a model the generator can emit.
  ///
  /// Throws a [NamingConflictException] when [failOnCollision] is set and two
  /// distinct inline types still claim the same Dart name.
  CodegenModel build(RpcModel rpc) {
    _types.clear();
    _schemaTypes.clear();
    _origins.clear();
    _dedupRefs.clear();
    _refs.clear();
    _warnings.clear();
    _anonCounter = 0;
    // Pass 1: Resolve all named schemas (skip reserved names from blocks_runtime)
    for (final entry in rpc.schemas.entries) {
      if (_reserved.contains(entry.key)) continue;
      _types[entry.key] = _schemaTypes[entry.key] = _resolveType(
        entry.value,
        entry.key,
        false,
        'schema:${entry.key}',
      );
    }

    // Pass 2: Resolve methods and group by namespace
    final namespaceMap = <String, List<Operation>>{};
    // Formatted after Pass 3 so type-arg names reflect any collision rename.
    final unboundResults = <(String, TransferableType)>[];
    for (final method in rpc.methods) {
      final parts = method.name.split('.');
      final ns = parts.length > 1
          ? parts.sublist(0, parts.length - 1).join('.')
          : '_default';
      final opName = parts.last;
      // Inline param object types are named by their full source path —
      // namespace + method + param — so they don't collide across operations
      // (the namespace segment is required: two namespaces can share a method
      // name like `create`). A `$ref` param keeps its named-schema identity.
      final nsPrefix = ns == '_default'
          ? ''
          : ns.split('.').map(_capitalize).join();

      final params = method.params.map((p) {
        return OperationParam(
          name: p.name,
          type: _resolveType(
            p.schema,
            '$nsPrefix${_capitalize(opName)}${_capitalize(p.name)}',
            false,
            '${method.name}#param:${p.name}',
          ),
          isRequired: p.isRequired,
        );
      }).toList();

      // Honor an explicitly declared result name (OpenRPC `result.name`) as the
      // result type's identity; fall back to the synthesized `{Method}Result`
      // when the spec omits it. Result naming is intentionally NOT qualified —
      // the emitter's declared result names are already method-qualified.
      final resultHint = method.resultName ?? '${_capitalize(opName)}Result';
      final resultType = _resolveType(
        method.result,
        resultHint,
        method.resultName != null,
        '${method.name}#result',
      );

      // Bare transferable only: a nullable/list/record-wrapped one is a
      // different ResolvedType and skipped, matching the generator's fallback.
      if (resultType is TransferableType &&
          !knownTransferableTags.contains(resultType.blocksType)) {
        unboundResults.add((method.name, resultType));
      }

      namespaceMap
          .putIfAbsent(ns, () => [])
          .add(
            Operation(
              name: opName,
              fullName: method.name,
              params: params,
              result: resultType,
            ),
          );
    }

    // Pass 3: detect (and resolve) display-name collisions among structurally
    // distinct types before generation.
    _resolveNamingCollisions();

    // Pass 4: make every type name a Dart identifier, and give every
    // reference its target's final name.
    _assignDartTypeNames();

    for (final (operation, transferable) in unboundResults) {
      _warnings.add(_formatUnboundTransferable(operation, transferable));
    }

    final namespaces = namespaceMap.entries
        .map((e) => Namespace(name: e.key, operations: e.value))
        .toList();

    return CodegenModel(
      title: rpc.title,
      version: rpc.version,
      namespaces: namespaces,
      types: _types,
      servers: rpc.servers,
      warnings: List.of(_warnings),
    );
  }

  ResolvedType _resolveType(
    TypeRef ref, [
    String? hint,
    bool isDeclaredName = false,
    String? path,
  ]) {
    return switch (ref) {
      PrimitiveRef(dartType: final dt, constraints: final c) => PrimitiveType(
        dt,
        constraints: c,
      ),
      NullableRef(inner: final inner) => NullableType(
        _resolveType(inner, hint, isDeclaredName, path),
      ),
      ArrayRef(items: final items, constraints: final c) => ListType(
        _resolveType(items, hint, isDeclaredName, path),
        constraints: c,
      ),
      SchemaRefRef(name: final name) =>
        _reserved.contains(name)
            ? const PrimitiveType('dynamic')
            : _schemaRef(name),
      UnionLiteralRef(values: final values) => _resolveEnum(values, hint, path),
      InlineObjectRef() => _resolveInlineObject(
        ref,
        hint,
        isDeclaredName,
        path,
      ),
      DiscriminatedUnionRef() => _resolveDiscriminatedUnion(ref, hint, path),
      TransferableRef(blocksType: final kt, typeArgs: final args) =>
        TransferableType(
          blocksType: kt,
          typeArgs: args
              .map((a) => _resolveTypeArgWithDedup(a, hint, path))
              .toList(),
        ),
      MapRef(valueType: final vt) => MapType(
        _resolveType(vt, hint, false, path),
      ),
      TupleRef(items: final items) => TupleType(
        items.map((i) => _resolveType(i, hint, false, path)).toList(),
      ),
    };
  }

  /// Resolves a transferable type arg, deduplicating against named schemas.
  ResolvedType _resolveTypeArgWithDedup(
    TypeRef ref,
    String? hint, [
    String? path,
  ]) {
    if (ref is InlineObjectRef) {
      // Resolve fields first, then check for structural match
      final tempName = hint != null ? '${hint}Message' : '_Anon$_anonCounter';
      final childPath = path == null ? null : '$path>message';
      final fields = ref.properties.entries.map((e) {
        return RecordField(
          name: e.key,
          type: _resolveType(
            e.value,
            '$tempName${_capitalize(e.key)}',
            false,
            childPath == null ? null : '$childPath.${e.key}',
          ),
          isRequired: ref.required.contains(e.key),
        );
      }).toList();
      final key = _structuralKeyOfRecord(
        RecordType(name: tempName, fields: fields, additionalProperties: null),
      );
      for (final entry in _types.entries) {
        if (entry.value is RecordType &&
            _structuralKeyOfRecord(entry.value as RecordType) == key) {
          return _dedupRef(entry.value);
        }
      }
    }
    return _resolveType(
      ref,
      hint != null ? '${hint}Message' : null,
      false,
      path == null ? null : '$path>message',
    );
  }

  /// Structural key including field types for full deduplication.
  String _structuralKeyOfRecord(RecordType record) {
    final sorted = record.fields.toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    final parts = sorted.map(
      (f) => '${f.name}:${_typeKey(f.type)}${f.isRequired ? '!' : ''}',
    );
    return 'obj{${parts.join(',')}}${_extrasKey(record.additionalProperties)}';
  }

  /// The structural-key suffix of an open record's extra keys, so an open
  /// record never merges with a closed one (or one with other extras). Empty
  /// for a closed record, which keeps every closed key unchanged.
  String _extrasKey(ResolvedType? additionalProperties) =>
      additionalProperties == null
      ? ''
      : '+extra:${_typeKey(additionalProperties)}';

  String _typeKey(ResolvedType t) => switch (t) {
    PrimitiveType(dartType: final dt) => dt,
    NullableType(inner: final i) => '${_typeKey(i)}?',
    ListType(items: final i) => 'List<${_typeKey(i)}>',
    MapType(valueType: final v) => 'Map<${_typeKey(v)}>',
    SchemaReference(name: final n) => 'ref:$n',
    RecordType() => _structuralKeyOfRecord(t),
    EnumType(name: final n) => 'ref:$n',
    SealedClassType() => _structuralKeyOfSealed(t),
    TransferableType(blocksType: final kt) => 'xfer:$kt',
    TupleType(items: final items) => '(${items.map(_typeKey).join(',')})',
  };

  /// Structural key for sealed classes based on discriminant + variant shapes.
  String _structuralKeyOfSealed(SealedClassType sealed) {
    final sortedVariants = sealed.variants.toList()
      ..sort((a, b) => a.discriminantValue.compareTo(b.discriminantValue));
    final parts = sortedVariants.map((v) {
      final fieldKeys = v.fields.toList()
        ..sort((a, b) => a.name.compareTo(b.name));
      final fk = fieldKeys
          .map((f) => '${f.name}:${_typeKey(f.type)}${f.isRequired ? '!' : ''}')
          .join(',');
      return '${v.discriminantValue}{$fk}${_extrasKey(v.additionalProperties)}';
    });
    // The enclosing keys matter only to an open variant, which excludes them.
    final enclosing =
        sealed.enclosingKeys.isNotEmpty &&
            sealed.variants.any((v) => v.additionalProperties != null)
        ? '<${(sealed.enclosingKeys.toList()..sort()).join(',')}>'
        : '';
    return 'sealed[${sealed.discriminant}${sealed.discriminantIsBoolean ? ':bool' : ''}]$enclosing{${parts.join('|')}}';
  }

  ResolvedType _resolveEnum(List<String> values, String? hint, [String? path]) {
    final name = hint ?? '_Enum${_anonCounter++}';
    final enumType = EnumType(name: name, values: values);
    _types[name] = enumType;
    _recordOrigin(enumType, path);
    return enumType;
  }

  ResolvedType _resolveInlineObject(
    InlineObjectRef ref,
    String? hint, [
    bool isDeclaredName = false,
    String? path,
  ]) {
    final name = hint ?? '_Anon${_anonCounter++}';
    final fields = ref.properties.entries.map((e) {
      return RecordField(
        name: e.key,
        type: _resolveType(
          e.value,
          '$name${_capitalize(e.key)}',
          false,
          path == null ? null : '$path>${e.key}',
        ),
        isRequired: ref.required.contains(e.key),
      );
    }).toList();
    final additionalProps = ref.additionalProperties != null
        ? _resolveType(
            ref.additionalProperties!,
            '${name}Extra',
            false,
            path == null ? null : '$path>additionalProperties',
          )
        : null;
    final record = RecordType(
      name: name,
      fields: fields,
      additionalProperties: additionalProps,
    );

    // Structural dedup: reuse existing type with same shape (only when no additionalProperties)
    if (additionalProps == null) {
      final key = _structuralKeyOfRecord(record);
      for (final entry in _types.entries) {
        if (entry.value is RecordType &&
            _structuralKeyOfRecord(entry.value as RecordType) == key) {
          return _dedupRef(entry.value);
        }
      }
    }

    // An explicitly declared name (e.g. OpenRPC `result.name`) is authoritative —
    // use it as-is and do not substitute a generic shape-based name.
    final genericName = isDeclaredName ? null : _genericNameForShape(fields);
    final finalName =
        (additionalProps == null &&
            genericName != null &&
            !_types.containsKey(genericName))
        ? genericName
        : name;
    final finalRecord = finalName == name
        ? record
        : RecordType(
            name: finalName,
            fields: fields,
            additionalProperties: additionalProps,
          );

    _types[finalName] = finalRecord;
    _recordOrigin(finalRecord, path);
    return finalRecord;
  }

  /// Returns a generic name for common simple shapes, or null to keep the hint name.
  String? _genericNameForShape(List<RecordField> fields) {
    if (fields.length != 1) return null;
    final f = fields[0];
    if (!f.isRequired) return null;
    return switch (f.name) {
      'success'
          when f.type is PrimitiveType &&
              (f.type as PrimitiveType).dartType == 'bool' =>
        'SuccessResult',
      'items' when f.type is ListType => 'ItemsResult',
      'value' => 'ValueResult',
      'url'
          when f.type is PrimitiveType &&
              (f.type as PrimitiveType).dartType == 'String' =>
        'UrlResult',
      'count'
          when f.type is PrimitiveType &&
              (f.type as PrimitiveType).dartType == 'int' =>
        'CountResult',
      _ => null,
    };
  }

  ResolvedType _resolveDiscriminatedUnion(
    DiscriminatedUnionRef ref,
    String? hint, [
    String? path,
    Set<String> enclosingKeys = const {},
  ]) {
    final name = hint ?? '_Union${_anonCounter++}';

    // Group variants by discriminant value
    final groups = <String, List<UnionVariant>>{};
    for (final v in ref.variants) {
      groups.putIfAbsent(v.discriminantValue, () => []).add(v);
    }

    final variants = groups.entries.map((entry) {
      final discValue = entry.key;
      final group = entry.value;
      // String discriminants keep the established `<Value><SealedName>` scheme
      // (e.g. `EmailGetNotificationResult`). A boolean discriminant has no
      // descriptive value, so name the arm after the field + value
      // (e.g. `IsUpdatedTrue`/`IsUpdatedFalse`), mirroring the Kotlin output.
      final className = ref.discriminantIsBoolean
          ? '${_capitalize(ref.discriminant)}${_capitalize(discValue)}'
          : '${_capitalize(discValue)}${_inferSuffix(name)}';
      final variantPath = path == null ? null : '$path>$discValue';

      final List<RecordField> fields;
      if (group.length == 1) {
        final v = group.first;
        fields = v.properties.entries.map((e) {
          return RecordField(
            name: e.key,
            type: _resolveType(
              e.value,
              '$className${_capitalize(e.key)}',
              false,
              variantPath == null ? null : '$variantPath.${e.key}',
            ),
            isRequired: v.required.contains(e.key),
          );
        }).toList();
      } else {
        // Merge: collect all fields, required only if present and required in ALL variants
        final allFieldNames = <String>{};
        for (final v in group) {
          allFieldNames.addAll(v.properties.keys);
        }
        fields = allFieldNames.map((fieldName) {
          // Use the first variant that has this field for the type
          final sourceVariant = group.firstWhere(
            (v) => v.properties.containsKey(fieldName),
          );
          final isRequired = group.every(
            (v) =>
                v.properties.containsKey(fieldName) &&
                v.required.contains(fieldName),
          );
          return RecordField(
            name: fieldName,
            type: _resolveType(
              sourceVariant.properties[fieldName]!,
              '$className${_capitalize(fieldName)}',
              false,
              variantPath == null ? null : '$variantPath.$fieldName',
            ),
            isRequired: isRequired,
          );
        }).toList();
      }

      // Resolve embedded union if present
      SealedClassType? embeddedUnion;
      if (group.length == 1 && group.first.embeddedUnion != null) {
        final nestedName =
            '$className${_capitalize(group.first.embeddedUnion!.discriminant)}';
        final resolved = _resolveDiscriminatedUnion(
          group.first.embeddedUnion!,
          nestedName,
          variantPath,
          {...enclosingKeys, ref.discriminant, for (final f in fields) f.name},
        );
        embeddedUnion = resolved is SealedClassType ? resolved : null;
      }

      // An open arm (`additionalProperties`) keeps its extra keys, typed like
      // an open record's (see [_resolveInlineObject]). Merged arms take the
      // first open one's value type.
      final extras = group
          .map((v) => v.additionalProperties)
          .firstWhere((ap) => ap != null, orElse: () => null);
      final additionalProps = extras == null
          ? null
          : _resolveType(
              extras,
              '${className}Extra',
              false,
              variantPath == null ? null : '$variantPath>additionalProperties',
            );

      return SealedVariant(
        discriminantValue: discValue,
        className: className,
        fields: fields,
        embeddedUnion: embeddedUnion,
        additionalProperties: additionalProps,
      );
    }).toList();

    final sealed = SealedClassType(
      name: name,
      discriminant: ref.discriminant,
      variants: variants,
      discriminantIsBoolean: ref.discriminantIsBoolean,
      enclosingKeys: enclosingKeys,
    );

    // Structural dedup: reuse an existing sealed class with the same shape
    // (ported from #682 — recursive structural + sealed-class dedup).
    final sealedKey = _structuralKeyOfSealed(sealed);
    for (final entry in _types.entries) {
      if (entry.value is SealedClassType &&
          _structuralKeyOfSealed(entry.value as SealedClassType) == sealedKey) {
        return _dedupRef(entry.value);
      }
    }

    _types[name] = sealed;
    _recordOrigin(sealed, path);
    return sealed;
  }

  /// A `$ref` to the schema named [name], tracked so that the final Dart
  /// name of the schema's type reaches it (see [_assignDartTypeNames]).
  SchemaReference _schemaRef(String name) {
    final ref = SchemaReference(name);
    _refs.add((ref, name));
    return ref;
  }

  /// A reference to [target], an existing type of the same shape that a new
  /// one merges into, tracked so that [target]'s final Dart name reaches it
  /// (see [_assignDartTypeNames]).
  SchemaReference _dedupRef(ResolvedType target) {
    final ref = SchemaReference(_displayName(target));
    _dedupRefs.putIfAbsent(target, () => []).add(ref);
    return ref;
  }

  /// Makes the name of every generated type a usable Dart identifier,
  /// renames it everywhere — the type itself, each variant class, every
  /// reference to it, and its key in the type table — and gives every
  /// reference its target's final name.
  ///
  /// A type is named after a schema, or after the field, operation,
  /// parameter or discriminant value it was inlined in, so its name can hold
  /// characters Dart can't (`my-doc`, `HeadersContent-type`), start with `_`
  /// (a library-private class, which no caller can name), or be a type the
  /// library already uses (`String`, `Map`, `Blocks`), which it would shadow
  /// or duplicate. Each name goes through `dartIdentifiers`, as the
  /// generator's member names do: it is camel-cased (`myDoc`,
  /// `HeadersContentType`), each leading `_` becomes `$` (`$Doc`), and a
  /// reserved name gets a trailing `$` (`String$`). A name that is already a
  /// usable identifier is unchanged, and two names that would land on one
  /// identifier get distinct ones. Names are keyed by the name, not the
  /// object, since two objects of one name are emitted as one class.
  ///
  /// This is the one place a reference gets its name, so every earlier
  /// rename reaches it too: a schema with one generic-shaped field takes a
  /// generic name (`ValueResult`, see [_genericNameForShape]), and Pass 3
  /// suffixes colliding types (`MakeResult2`). A `$ref` follows the type its
  /// schema resolved to in Pass 1, and a structural-dedup reference the type
  /// it merged into. The type table is rebuilt in its current order, under
  /// each declared type's final name, plus each alias schema (one that isn't
  /// a model, an enum or a union) under its schema name, or its JSON pointer
  /// when a type's name is that name (a nullable object schema `Box` is
  /// `Box?`, and its class is `Box`). An alias's own key is never printed:
  /// the generator emits nothing for it and types a `$ref` to it as the type
  /// it stands for.
  void _assignDartTypeNames() {
    final declared = Set<ResolvedType>.identity()
      ..addAll(
        [for (final o in _origins) o.type, ..._types.values].where(_isDeclared),
      );
    final names = <String>{
      for (final type in declared)
        ...switch (type) {
          SealedClassType(name: final n, variants: final variants) => [
            n,
            for (final v in variants) v.className,
          ],
          _ => [_displayName(type)],
        },
    };
    final ids = dartIdentifiers(names, reserved: generatedTopLevelNames);
    String id(String name) => ids[name] ?? name;
    for (final type in declared) {
      switch (type) {
        case RecordType():
          type.name = id(type.name);
        case EnumType():
          type.name = id(type.name);
        case SealedClassType():
          type.name = id(type.name);
          for (final v in type.variants) {
            v.className = id(v.className);
          }
        default:
          break;
      }
    }

    final typeNames = {for (final type in declared) _displayName(type)};
    String aliasKey(String schema) =>
        typeNames.contains(schema) ? '#/components/schemas/$schema' : schema;

    final table = <String, ResolvedType>{};
    // The declared types an alias schema holds directly (`Box?`'s `Box`),
    // placed with the alias, since no other table entry may hold them.
    void placeHeld(ResolvedType type) {
      switch (type) {
        case RecordType() || EnumType() || SealedClassType():
          table.putIfAbsent(_displayName(type), () => type);
        case NullableType(inner: final i) || ListType(items: final i):
          placeHeld(i);
        case MapType(valueType: final v):
          placeHeld(v);
        case TupleType(items: final items):
          items.forEach(placeHeld);
        case TransferableType(typeArgs: final args):
          args.forEach(placeHeld);
        case PrimitiveType() || SchemaReference():
          break;
      }
    }

    void placeAlias(String schema, ResolvedType type) {
      table.putIfAbsent(aliasKey(schema), () => type);
      placeHeld(type);
    }

    for (final MapEntry(:key, :value) in _types.entries) {
      if (_isDeclared(value)) {
        table[_displayName(value)] = value;
      } else if (identical(_schemaTypes[key], value)) {
        placeAlias(key, value);
      }
    }
    // Aliases a later type of the same name displaced from [_types], and
    // types an alias displaced, keep their place in the table.
    for (final MapEntry(:key, :value) in _schemaTypes.entries) {
      if (!_isDeclared(value)) placeAlias(key, value);
    }
    for (final type in declared) {
      table.putIfAbsent(_displayName(type), () => type);
    }
    _types
      ..clear()
      ..addAll(table);

    for (final (ref, schema) in _refs) {
      ref.name = switch (_schemaTypes[schema]) {
        final t? when _isDeclared(t) => _displayName(t),
        _? => aliasKey(schema),
        null => schema,
      };
    }
    for (final MapEntry(key: target, value: refs) in _dedupRefs.entries) {
      for (final ref in refs) {
        ref.name = _displayName(target);
      }
    }
  }

  bool _isDeclared(ResolvedType type) =>
      type is RecordType || type is EnumType || type is SealedClassType;

  String _inferSuffix(String baseName) {
    // If the base name ends with "Input", use "Input" as suffix for variants
    if (baseName.endsWith('Input')) return 'Input';
    return baseName;
  }

  /// Records the origin of a freshly-synthesized named type for collision
  /// detection. Dedup-merged types are never recorded here (they return a
  /// [SchemaReference] before reaching this point).
  void _recordOrigin(ResolvedType type, String? path) {
    final key = path ?? _displayName(type);
    _origins.add(
      _TypeOrigin(type, _fingerprint(type), key, _describeSource(key)),
    );
  }

  String _displayName(ResolvedType type) => switch (type) {
    RecordType(name: final n) => n,
    EnumType(name: final n) => n,
    SealedClassType(name: final n) => n,
    _ => '',
  };

  /// Generated model name for a type argument, or '' if it produces no model
  /// (e.g. a primitive). Includes [SchemaReference], unlike [_displayName].
  String _transferableTypeArgModelName(ResolvedType type) => switch (type) {
    RecordType(name: final n) => n,
    EnumType(name: final n) => n,
    SealedClassType(name: final n) => n,
    SchemaReference(name: final n) => n,
    _ => '',
  };

  /// Builds the `AWSBLOCKS-NATIVE-001` diagnostic: names the operation, tag,
  /// platform, and generated type-arg models — never descriptor values.
  String _formatUnboundTransferable(
    String operation,
    TransferableType transferable,
  ) {
    final models = transferable.typeArgs
        .map(_transferableTypeArgModelName)
        .where((n) => n.isNotEmpty)
        .toList();
    final String typeArgClause;
    if (models.isEmpty) {
      typeArgClause = 'no generated type-argument models';
    } else if (models.length == 1) {
      typeArgClause = 'type argument ${models.first}';
    } else {
      typeArgClause = 'type arguments ${models.join(', ')}';
    }
    // Keep the diagnostic on one line if a tag contains a newline or CR.
    final safeTag = transferable.blocksType
        .replaceAll('\n', r'\n')
        .replaceAll('\r', r'\r');
    return 'AWSBLOCKS-NATIVE-001: $operation returns unbound transferable '
        "'$safeTag' on dart; generated UnknownTransferable "
        'with $typeArgClause.';
  }

  /// Structural identity of a named type. Two types with the same display name
  /// but different fingerprints are a genuine conflict; identical fingerprints
  /// are the (already-merged) dedup case and must not be flagged.
  String _fingerprint(ResolvedType type) => switch (type) {
    RecordType() => _structuralKeyOfRecord(type),
    EnumType(values: final v) => 'enum{${(v.toList()..sort()).join(',')}}',
    SealedClassType() => _structuralKeyOfSealed(type),
    _ => _typeKey(type),
  };

  /// Renders a canonical source key into a human-readable description.
  /// Key forms: `schema:Name`, `method#param:p>seg>seg`, `method#result>seg`.
  String _describeSource(String key) {
    if (key.startsWith('schema:')) return 'schema "${key.substring(7)}"';
    final hashIdx = key.indexOf('#');
    if (hashIdx < 0) return key;
    final method = key.substring(0, hashIdx);
    final segs = key.substring(hashIdx + 1).split('>');
    final root = segs.first;
    final nested = segs.length > 1 ? ': ${segs.sublist(1).join('.')}' : '';
    if (root.startsWith('param:')) {
      return '$method (param "${root.substring(6)}"$nested)';
    }
    if (root == 'result') return '$method (result$nested)';
    return key;
  }

  /// Detects display-name collisions among structurally distinct types.
  /// Fails fast by default; with [autoDisambiguate] appends a deterministic,
  /// order-independent suffix instead.
  void _resolveNamingCollisions() {
    final byName = <String, List<_TypeOrigin>>{};
    for (final o in _origins) {
      byName.putIfAbsent(o.name, () => []).add(o);
    }

    // For each name, keep one representative per distinct fingerprint (the one
    // with the smallest canonical key, so selection is order-independent).
    final conflicts = <String, List<_TypeOrigin>>{};
    for (final entry in byName.entries) {
      final distinct = <String, _TypeOrigin>{};
      for (final o in entry.value) {
        final existing = distinct[o.fingerprint];
        if (existing == null ||
            o.canonicalKey.compareTo(existing.canonicalKey) < 0) {
          distinct[o.fingerprint] = o;
        }
      }
      if (distinct.length > 1) {
        conflicts[entry.key] = distinct.values.toList()
          ..sort((a, b) => a.canonicalKey.compareTo(b.canonicalKey));
      }
    }

    if (conflicts.isEmpty) return;

    if (failOnCollision) {
      throw NamingConflictException(_formatConflicts(conflicts));
    }

    // Default: deterministically auto-disambiguate and warn loudly. The
    // representative with the smallest canonical key keeps the base name; the
    // rest get `2`, `3`, … suffixes (order-independent).
    for (final entry in conflicts.entries) {
      final reps = entry.value; // already sorted by canonical key
      final assigned = <String>[entry.key];
      for (var i = 1; i < reps.length; i++) {
        final newName = '${entry.key}${i + 1}';
        _renameType(reps[i].type, newName);
        assigned.add(newName);
      }
      _warnings.add(_formatWarning(entry.key, reps, assigned));
    }

    // Rebuild the type table so every distinct type is present under its final
    // name (resolution may have clobbered colliding entries during Pass 2).
    final rebuilt = <String, ResolvedType>{};
    for (final o in _origins) {
      rebuilt[_displayName(o.type)] = o.type;
    }
    _types
      ..clear()
      ..addAll(rebuilt);
  }

  /// Renames [type] in place. Its references follow in Pass 4
  /// ([_assignDartTypeNames]), the one place a reference gets its name.
  void _renameType(ResolvedType type, String newName) {
    switch (type) {
      case RecordType():
        type.name = newName;
      case EnumType():
        type.name = newName;
      case SealedClassType():
        type.name = newName;
      default:
        return;
    }
  }

  String _formatConflicts(Map<String, List<_TypeOrigin>> conflicts) {
    final buf = StringBuffer();
    buf.writeln(
      'Inline type naming conflict${conflicts.length > 1 ? 's' : ''} detected. '
      'Distinct types generate the same Dart identifier:',
    );
    for (final entry in conflicts.entries) {
      final sources = entry.value.map((o) => o.source).toList();
      final String list;
      if (sources.length == 2) {
        list = '${sources[0]} and ${sources[1]}';
      } else {
        list =
            '${sources.sublist(0, sources.length - 1).join(', ')}, and ${sources.last}';
      }
      final verb = sources.length == 2 ? 'both generate' : 'all generate';
      buf.writeln(
        '  Naming conflict: types from $list $verb `${entry.key}`. '
        'Rename one of these in your spec to disambiguate.',
      );
    }
    return buf.toString().trimRight();
  }

  /// Builds the warning emitted when a collision is auto-disambiguated (default
  /// behavior). Names every source and the suffixed identifier it received.
  String _formatWarning(
    String base,
    List<_TypeOrigin> reps,
    List<String> assigned,
  ) {
    final mapping = [
      for (var i = 0; i < reps.length; i++)
        '${reps[i].source} -> ${assigned[i]}',
    ].join(', ');
    return 'Naming conflict: ${reps.length} structurally distinct types generate '
        '`$base`. Auto-disambiguated to: $mapping. '
        'Rename one of these in your spec to avoid a generated suffix '
        '(or pass --fail-on-collision to make this an error).';
  }

  String _capitalize(String s) =>
      s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
}
