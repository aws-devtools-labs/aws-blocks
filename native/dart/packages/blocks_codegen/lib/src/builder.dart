import 'model.dart';

/// Resolved type system — output of the builder stage.

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
  String name;
  final List<RecordField> fields;
  final ResolvedType? additionalProperties;
  RecordType(
      {required this.name, required this.fields, this.additionalProperties});
}

class RecordField {
  final String name;
  final ResolvedType type;
  final bool isRequired;
  const RecordField(
      {required this.name, required this.type, required this.isRequired});
}

class EnumType extends ResolvedType {
  String name;
  final List<String> values;
  EnumType({required this.name, required this.values});
}

class SealedClassType extends ResolvedType {
  String name;
  final String discriminant;
  final List<SealedVariant> variants;
  SealedClassType({
    required this.name,
    required this.discriminant,
    required this.variants,
  });
}

class SealedVariant {
  final String discriminantValue;
  final String className;
  final List<RecordField> fields;
  final SealedClassType? embeddedUnion;
  const SealedVariant({
    required this.discriminantValue,
    required this.className,
    required this.fields,
    this.embeddedUnion,
  });
}

class TransferableType extends ResolvedType {
  final String blocksType;
  final List<ResolvedType> typeArgs;
  const TransferableType({required this.blocksType, this.typeArgs = const []});
}

class SchemaReference extends ResolvedType {
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
  final String name;
  final String fullName; // dotted name for RPC call
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
  const OperationParam(
      {required this.name, required this.type, required this.isRequired});
}

/// A namespace grouping operations.
class Namespace {
  final String name;
  final List<Operation> operations;
  const Namespace({required this.name, required this.operations});
}

/// The complete codegen model — ready for code generation.
class CodegenModel {
  final String title;
  final String version;
  final List<Namespace> namespaces;
  final Map<String, ResolvedType> types; // named types (from schemas + inline)
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
    'BlocksClient'
  };
  final Map<String, ResolvedType> _types = {};
  // Every named type synthesized during a build, in creation order.
  final List<_TypeOrigin> _origins = [];
  // SchemaReferences produced by structural dedup, keyed by their target object,
  // so a rename of the target can be propagated to all references.
  final Map<ResolvedType, List<SchemaReference>> _dedupRefs = {};
  // Non-fatal diagnostics produced during the build.
  final List<String> _warnings = [];
  int _anonCounter = 0;

  CodegenModel build(RpcModel rpc) {
    _types.clear();
    _origins.clear();
    _dedupRefs.clear();
    _warnings.clear();
    _anonCounter = 0;
    // Pass 1: Resolve all named schemas (skip reserved names from blocks_runtime)
    for (final entry in rpc.schemas.entries) {
      if (_reserved.contains(entry.key)) continue;
      _types[entry.key] =
          _resolveType(entry.value, entry.key, false, 'schema:${entry.key}');
    }

    // Pass 2: Resolve methods and group by namespace
    final namespaceMap = <String, List<Operation>>{};
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
      final nsPrefix =
          ns == '_default' ? '' : ns.split('.').map(_capitalize).join();

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

      namespaceMap.putIfAbsent(ns, () => []).add(Operation(
            name: opName,
            fullName: method.name,
            params: params,
            result: resultType,
          ));
    }

    // Pass 3: detect (and resolve) display-name collisions among structurally
    // distinct types before generation.
    _resolveNamingCollisions();

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

  ResolvedType _resolveType(TypeRef ref,
      [String? hint, bool isDeclaredName = false, String? path]) {
    return switch (ref) {
      PrimitiveRef(dartType: final dt, constraints: final c) =>
        PrimitiveType(dt, constraints: c),
      NullableRef(inner: final inner) =>
        NullableType(_resolveType(inner, hint, isDeclaredName, path)),
      ArrayRef(items: final items, constraints: final c) => ListType(
          _resolveType(items, hint, isDeclaredName, path),
          constraints: c),
      SchemaRefRef(name: final name) => _reserved.contains(name)
          ? const PrimitiveType('dynamic')
          : SchemaReference(name),
      UnionLiteralRef(values: final values) => _resolveEnum(values, hint, path),
      InlineObjectRef() =>
        _resolveInlineObject(ref, hint, isDeclaredName, path),
      DiscriminatedUnionRef() => _resolveDiscriminatedUnion(ref, hint, path),
      TransferableRef(blocksType: final kt, typeArgs: final args) =>
        TransferableType(
            blocksType: kt,
            typeArgs: args
                .map((a) => _resolveTypeArgWithDedup(a, hint, path))
                .toList()),
      MapRef(valueType: final vt) =>
        MapType(_resolveType(vt, hint, false, path)),
      TupleRef(items: final items) => TupleType(
          items.map((i) => _resolveType(i, hint, false, path)).toList()),
    };
  }

  /// Resolves a transferable type arg, deduplicating against named schemas.
  ResolvedType _resolveTypeArgWithDedup(TypeRef ref, String? hint,
      [String? path]) {
    if (ref is InlineObjectRef) {
      // Resolve fields first, then check for structural match
      final tempName = hint != null ? '${hint}Message' : '_Anon${_anonCounter}';
      final childPath = path == null ? null : '$path>message';
      final fields = ref.properties.entries.map((e) {
        return RecordField(
          name: e.key,
          type: _resolveType(e.value, '$tempName${_capitalize(e.key)}', false,
              childPath == null ? null : '$childPath.${e.key}'),
          isRequired: ref.required.contains(e.key),
        );
      }).toList();
      final key = _structuralKeyOfRecord(RecordType(
          name: tempName, fields: fields, additionalProperties: null));
      for (final entry in _types.entries) {
        if (entry.value is RecordType &&
            _structuralKeyOfRecord(entry.value as RecordType) == key) {
          final dedupRef = SchemaReference(entry.key);
          _dedupRefs.putIfAbsent(entry.value, () => []).add(dedupRef);
          return dedupRef;
        }
      }
    }
    return _resolveType(ref, hint != null ? '${hint}Message' : null, false,
        path == null ? null : '$path>message');
  }

  /// Structural key including field types for full deduplication.
  String _structuralKeyOfRecord(RecordType record) {
    final sorted = record.fields.toList()
      ..sort((a, b) => a.name.compareTo(b.name));
    final parts = sorted
        .map((f) => '${f.name}:${_typeKey(f.type)}${f.isRequired ? '!' : ''}');
    return 'obj{${parts.join(',')}}';
  }

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
      return '${v.discriminantValue}{$fk}';
    });
    return 'sealed[${sealed.discriminant}]{${parts.join('|')}}';
  }

  ResolvedType _resolveEnum(List<String> values, String? hint, [String? path]) {
    final name = hint ?? '_Enum${_anonCounter++}';
    final enumType = EnumType(name: name, values: values);
    _types[name] = enumType;
    _recordOrigin(enumType, path);
    return enumType;
  }

  ResolvedType _resolveInlineObject(InlineObjectRef ref, String? hint,
      [bool isDeclaredName = false, String? path]) {
    final name = hint ?? '_Anon${_anonCounter++}';
    final fields = ref.properties.entries.map((e) {
      return RecordField(
        name: e.key,
        type: _resolveType(e.value, '$name${_capitalize(e.key)}', false,
            path == null ? null : '$path>${e.key}'),
        isRequired: ref.required.contains(e.key),
      );
    }).toList();
    final additionalProps = ref.additionalProperties != null
        ? _resolveType(ref.additionalProperties!, '${name}Extra', false,
            path == null ? null : '$path>additionalProperties')
        : null;
    final record = RecordType(
        name: name, fields: fields, additionalProperties: additionalProps);

    // Structural dedup: reuse existing type with same shape (only when no additionalProperties)
    if (additionalProps == null) {
      final key = _structuralKeyOfRecord(record);
      for (final entry in _types.entries) {
        if (entry.value is RecordType &&
            _structuralKeyOfRecord(entry.value as RecordType) == key) {
          final dedupRef = SchemaReference(entry.key);
          _dedupRefs.putIfAbsent(entry.value, () => []).add(dedupRef);
          return dedupRef;
        }
      }
    }

    // An explicitly declared name (e.g. OpenRPC `result.name`) is authoritative —
    // use it as-is and do not substitute a generic shape-based name.
    final genericName = isDeclaredName ? null : _genericNameForShape(fields);
    final finalName = (additionalProps == null &&
            genericName != null &&
            !_types.containsKey(genericName))
        ? genericName
        : name;
    final finalRecord = finalName == name
        ? record
        : RecordType(
            name: finalName,
            fields: fields,
            additionalProperties: additionalProps);

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
      DiscriminatedUnionRef ref, String? hint,
      [String? path]) {
    final name = hint ?? '_Union${_anonCounter++}';

    // Group variants by discriminant value
    final groups = <String, List<UnionVariant>>{};
    for (final v in ref.variants) {
      groups.putIfAbsent(v.discriminantValue, () => []).add(v);
    }

    final variants = groups.entries.map((entry) {
      final discValue = entry.key;
      final group = entry.value;
      final className = '${_capitalize(discValue)}${_inferSuffix(name)}';
      final variantPath = path == null ? null : '$path>$discValue';

      final List<RecordField> fields;
      if (group.length == 1) {
        final v = group.first;
        fields = v.properties.entries.map((e) {
          return RecordField(
            name: e.key,
            type: _resolveType(e.value, '$className${_capitalize(e.key)}',
                false, variantPath == null ? null : '$variantPath.${e.key}'),
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
          final sourceVariant =
              group.firstWhere((v) => v.properties.containsKey(fieldName));
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
                variantPath == null ? null : '$variantPath.$fieldName'),
            isRequired: isRequired,
          );
        }).toList();
      }

      // Resolve embedded union if present
      SealedClassType? embeddedUnion;
      if (group.length == 1 && group.first.embeddedUnion != null) {
        final nestedName =
            '${className}${_capitalize(group.first.embeddedUnion!.discriminant)}';
        final resolved = _resolveDiscriminatedUnion(
            group.first.embeddedUnion!, nestedName, variantPath);
        embeddedUnion = resolved is SealedClassType ? resolved : null;
      }

      return SealedVariant(
        discriminantValue: discValue,
        className: className,
        fields: fields,
        embeddedUnion: embeddedUnion,
      );
    }).toList();

    final sealed = SealedClassType(
        name: name, discriminant: ref.discriminant, variants: variants);

    // Structural dedup: reuse an existing sealed class with the same shape
    // (ported from #682 — recursive structural + sealed-class dedup).
    final sealedKey = _structuralKeyOfSealed(sealed);
    for (final entry in _types.entries) {
      if (entry.value is SealedClassType &&
          _structuralKeyOfSealed(entry.value as SealedClassType) == sealedKey) {
        final dedupRef = SchemaReference(entry.key);
        _dedupRefs.putIfAbsent(entry.value, () => []).add(dedupRef);
        return dedupRef;
      }
    }

    _types[name] = sealed;
    _recordOrigin(sealed, path);
    return sealed;
  }

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
    _origins
        .add(_TypeOrigin(type, _fingerprint(type), key, _describeSource(key)));
  }

  String _displayName(ResolvedType type) => switch (type) {
        RecordType(name: final n) => n,
        EnumType(name: final n) => n,
        SealedClassType(name: final n) => n,
        _ => '',
      };

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
    // Propagate to any dedup references that pointed at this object.
    for (final ref in _dedupRefs[type] ?? const <SchemaReference>[]) {
      ref.name = newName;
    }
  }

  String _formatConflicts(Map<String, List<_TypeOrigin>> conflicts) {
    final buf = StringBuffer();
    buf.writeln(
        'Inline type naming conflict${conflicts.length > 1 ? 's' : ''} detected. '
        'Distinct types generate the same Dart identifier:');
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
      buf.writeln('  Naming conflict: types from $list $verb `${entry.key}`. '
          'Rename one of these in your spec to disambiguate.');
    }
    return buf.toString().trimRight();
  }

  /// Builds the warning emitted when a collision is auto-disambiguated (default
  /// behavior). Names every source and the suffixed identifier it received.
  String _formatWarning(
      String base, List<_TypeOrigin> reps, List<String> assigned) {
    final mapping = [
      for (var i = 0; i < reps.length; i++)
        '${reps[i].source} -> ${assigned[i]}'
    ].join(', ');
    return 'Naming conflict: ${reps.length} structurally distinct types generate '
        '`$base`. Auto-disambiguated to: $mapping. '
        'Rename one of these in your spec to avoid a generated suffix '
        '(or pass --fail-on-collision to make this an error).';
  }

  String _capitalize(String s) =>
      s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
}
