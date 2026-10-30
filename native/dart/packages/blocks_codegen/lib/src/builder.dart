import 'package:blocks_codegen/src/diagnostics.dart';
import 'model.dart';

const _packagesExtension = 'x-blocks-native-packages';
const _transferableKind = 'transferable';
const _catalogSchemaVersion = 1;
final _exportGrammar = RegExp(r'^[A-Za-z][A-Za-z0-9]*([-_.][A-Za-z0-9]+)*$');

/// A declared binding cannot replace one of these.
const knownTransferableTags = {
  'realtime/channel',
  'file-bucket/download',
  'file-bucket/upload',
  'oidc/client',
};

/// A `show` of one of these does not collide, it silently shadows, so the
/// generated client's body would bind the package's type and fail to compile.
const dartCoreTypeNames = {
  'ArgumentError',
  'Comparable',
  'DateTime',
  'Duration',
  'Enum',
  'Exception',
  'Function',
  'Future',
  'Iterable',
  'Iterator',
  'List',
  'Map',
  'MapEntry',
  'Never',
  'Null',
  'Object',
  'Pattern',
  'Record',
  'RegExp',
  'Set',
  'Stream',
  'String',
  'StringBuffer',
  'Symbol',
  'Type',
  'Uri',
  'bool',
  'double',
  'int',
  'num',
};

/// The generated client imports the runtime wholesale, so a bound export
/// resolving to one of these would be ambiguous.
const blocksRuntimeTypeNames = {
  'AuthProvider',
  'AuthorizeParamsResponse',
  'BlocksClient',
  'BlocksConfig',
  'BlocksRpcException',
  'BrowserLauncher',
  'FileDownloadHandle',
  'FileUploadHandle',
  'InMemorySessionStore',
  'InMemoryTokenStore',
  'OidcAuthState',
  'OidcCallbackException',
  'OidcCancelledException',
  'OidcClient',
  'OidcException',
  'OidcExchangeException',
  'OidcLoading',
  'OidcSignedIn',
  'OidcSignedOut',
  'OidcUnknownProviderException',
  'OidcUser',
  'PersistentSessionStore',
  'ProviderConfig',
  'RealtimeChannel',
  'SessionStore',
  'StatePayload',
  'TokenStore',
  'UnknownTransferable',
  'WebSocketPool',
};

class TransferableBinding {
  const TransferableBinding({
    required this.typeName,
    required this.packageName,
    required this.library,
    required this.genericArity,
  });

  final String typeName;

  final String packageName;

  final String library;

  final int genericArity;

  String get importUri => 'package:$packageName/$library';
}

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
  SealedClassType({
    required this.name,
    required this.discriminant,
    required this.variants,
    this.discriminantIsBoolean = false,
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

  final TransferableBinding? binding;

  const TransferableType({
    required this.blocksType,
    this.typeArgs = const [],
    this.binding,
  });
}

bool transferableIsUnbound(TransferableType type) =>
    type.binding == null && !knownTransferableTags.contains(type.blocksType);

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
  /// keyed by its final Dart name.
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

  final Set<String> optedOutPackages;

  CodegenModelBuilder({
    this.failOnCollision = false,
    this.optedOutPackages = const {},
  });

  static const _reserved = {
    'RealtimeChannel',
    'FileUploadHandle',
    'FileDownloadHandle',
    'OidcClient',
    'BlocksClient',
    'UnknownTransferable',
  };
  final Map<String, TransferableBinding> _bindings = {};
  final Map<String, ResolvedType> _types = {};
  // Every named type synthesized during a build, in creation order.
  final List<_TypeOrigin> _origins = [];
  // SchemaReferences produced by structural dedup, keyed by their target object,
  // so a rename of the target can be propagated to all references.
  final Map<ResolvedType, List<SchemaReference>> _dedupRefs = {};

  // Keyed by the spec schema name the `$ref` names, not the Dart name.
  final Map<String, List<SchemaReference>> _schemaRefs = {};
  // Non-fatal diagnostics produced during the build.
  final List<String> _warnings = [];
  int _anonCounter = 0;

  /// Resolves [rpc] into a model the generator can emit.
  ///
  /// Throws a [NamingConflictException] when [failOnCollision] is set and two
  /// distinct inline types still claim the same Dart name, and a
  /// [FormatException] when a declared native binding cannot be applied.
  CodegenModel build(RpcModel rpc) {
    _types.clear();
    _origins.clear();
    _dedupRefs.clear();
    _schemaRefs.clear();
    _warnings.clear();
    _bindings.clear();
    _anonCounter = 0;
    _warnUnmatchedOptOuts(rpc);
    _resolveBindings(rpc);
    // Pass 1: Resolve all named schemas (skip reserved names from blocks_runtime)
    for (final entry in rpc.schemas.entries) {
      if (_reserved.contains(entry.key)) continue;
      _types[entry.key] = _resolveType(
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
    final boundDirectResults = <(String, int)>[];
    final nonHydratableChannels = <(String, TransferableType)>[];
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
      // Decodability is settled after Pass 3, which can rename the payload a
      // type-arg `$ref` resolves to, so deciding here would bind the result to
      // a model the generator no longer sees.
      if (resultType is TransferableType) {
        _checkBindingArity(method.name, resultType);
        boundDirectResults.add((ns, namespaceMap[ns]?.length ?? 0));
      }

      // A bound `realtime/channel` whose message type cannot be hydrated by the
      // `Map`-only runtime is declared `RealtimeChannel<T>` but returned raw.
      // Unwrap a nullable result first: `RealtimeChannel<T>?` emits the same raw
      // body as the direct form, so it must be diagnosed too. Direct-result
      // scope only (no field or nested scan).
      final channelType = resultType is NullableType
          ? resultType.inner
          : resultType;
      if (channelType is TransferableType &&
          channelType.blocksType == 'realtime/channel' &&
          !_channelMessageHydratable(channelType.typeArgs)) {
        nonHydratableChannels.add((method.name, channelType));
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

    for (final (ns, index) in boundDirectResults) {
      final operations = namespaceMap[ns];
      if (operations == null || index >= operations.length) continue;
      final operation = operations[index];
      final result = operation.result;
      if (result is! TransferableType) continue;
      final settled = _withDecodableBinding(result);
      if (!identical(settled, result)) {
        operations[index] = Operation(
          name: operation.name,
          fullName: operation.fullName,
          params: operation.params,
          result: settled,
        );
      }
      if (transferableIsUnbound(settled)) {
        unboundResults.add((operation.fullName, settled));
      }
    }

    for (final (operation, transferable) in unboundResults) {
      _warnings.add(_formatUnboundTransferable(operation, transferable));
    }

    for (final (operation, transferable) in nonHydratableChannels) {
      _warnings.add(_formatNonHydratableChannel(operation, transferable));
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
            : _trackedSchemaRef(name),
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
          // An oidc/client's type argument names its providers, which the
          // generated client doesn't use yet.
          typeArgs: kt == 'oidc/client'
              ? const []
              : args
                    .map((a) => _resolveTypeArgWithDedup(a, hint, path))
                    .toList(),
          binding: _bindings[kt],
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
          final dedupRef = SchemaReference(entry.key);
          _dedupRefs.putIfAbsent(entry.value, () => []).add(dedupRef);
          return dedupRef;
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
    return 'sealed[${sealed.discriminant}${sealed.discriminantIsBoolean ? ':bool' : ''}]{${parts.join('|')}}';
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
          final dedupRef = SchemaReference(entry.key);
          _dedupRefs.putIfAbsent(entry.value, () => []).add(dedupRef);
          return dedupRef;
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
        );
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
      name: name,
      discriminant: ref.discriminant,
      variants: variants,
      discriminantIsBoolean: ref.discriminantIsBoolean,
    );

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
    final safeTag = escapeForDiagnostic(transferable.blocksType);
    return 'AWSBLOCKS-NATIVE-001: ${escapeForDiagnostic(operation)} returns unbound transferable '
        "'$safeTag' on dart; generated UnknownTransferable "
        'with $typeArgClause.';
  }

  /// Whether a bound `realtime/channel` message type-arg can be hydrated by the
  /// generated client. Delegates to the shared [channelMessageHydratable] so
  /// this diagnostic and the generator's channel deserializer decide "raw vs
  /// hydrated" from one place and cannot drift.
  bool _channelMessageHydratable(List<ResolvedType> typeArgs) =>
      channelMessageHydratable(typeArgs, _types);

  /// A readable Dart-type label for a channel message type, for diagnostics.
  String _messageTypeLabel(ResolvedType t) => switch (t) {
    PrimitiveType(dartType: final dt) => dt,
    NullableType(inner: final i) => '${_messageTypeLabel(i)}?',
    ListType(items: final i) => 'List<${_messageTypeLabel(i)}>',
    MapType(valueType: final v) => 'Map<String, ${_messageTypeLabel(v)}>',
    RecordType(name: final n) => n,
    EnumType(name: final n) => n,
    SealedClassType(name: final n) => n,
    SchemaReference(name: final n) => n,
    TransferableType(blocksType: final kt) => kt,
    TupleType(items: final items) =>
      '(${items.map(_messageTypeLabel).join(', ')})',
  };

  /// Builds the `AWSBLOCKS-NATIVE-002` diagnostic: a bound `realtime/channel`
  /// whose message type the `Map`-only runtime cannot decode, so the value is
  /// returned un-hydrated. Names the operation and the message type only.
  String _formatNonHydratableChannel(
    String operation,
    TransferableType transferable,
  ) {
    final messageLabel = transferable.typeArgs.isEmpty
        ? 'dynamic'
        : _messageTypeLabel(transferable.typeArgs.first);
    return 'AWSBLOCKS-NATIVE-002: ${escapeForDiagnostic(operation)} returns realtime/channel with a '
        "non-hydratable message type '$messageLabel' on dart; the value is "
        'returned un-hydrated (not supported yet).';
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
        _followSchemaRefs(reps[i], newName);
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

  SchemaReference _trackedSchemaRef(String name) {
    final ref = SchemaReference(name);
    _schemaRefs.putIfAbsent(name, () => []).add(ref);
    return ref;
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

  void _followSchemaRefs(_TypeOrigin origin, String newName) {
    const prefix = 'schema:';
    if (!origin.canonicalKey.startsWith(prefix)) return;
    final specName = origin.canonicalKey.substring(prefix.length);
    for (final ref in _schemaRefs[specName] ?? const <SchemaReference>[]) {
      ref.name = newName;
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

  /// Because opt-outs are build configuration, an identity absent from the
  /// package catalog produces a warning instead of an error. Platform
  /// availability does not affect this check.
  void _warnUnmatchedOptOuts(RpcModel rpc) {
    for (final identity in optedOutPackages.toList()..sort()) {
      if (rpc.nativePackages.containsKey(identity)) continue;
      _warnings.add(
        'AWSBLOCKS-NATIVE-006: opted-out package '
        "'${escapeForDiagnostic(identity)}' is not declared by "
        '$_packagesExtension; nothing was opted out for it on dart.',
      );
    }
  }

  void _resolveBindings(RpcModel rpc) {
    final referenced = <String>{};
    final claimed = <String, ({String package, String export})>{};
    for (final binding in rpc.nativeBindings) {
      if (!rpc.nativePackages.containsKey(binding.package)) {
        throw FormatException(
          "Binding for tag '${escapeForDiagnostic(binding.tag)}' names package "
          "'${escapeForDiagnostic(binding.package)}', which "
          '$_packagesExtension does not declare',
        );
      }
      referenced.add(binding.package);
      if (binding.kind != _transferableKind) {
        _warnings.add(
          "AWSBLOCKS-NATIVE-004: binding '${escapeForDiagnostic(binding.id)}' "
          "declares kind '${escapeForDiagnostic(binding.kind)}', which schema "
          '$_catalogSchemaVersion does not define; ignored on dart.',
        );
        continue;
      }
      if (knownTransferableTags.contains(binding.tag)) continue;
      if (optedOutPackages.contains(binding.package)) continue;
      final package = rpc.nativePackages[binding.package];
      if (package == null) continue;
      final typeName = _exportTypeName(binding.export);
      _checkTypeNameUnclaimed(binding, typeName, claimed);
      claimed[typeName] = (package: binding.package, export: binding.export);
      _bindings[binding.tag] = TransferableBinding(
        typeName: typeName,
        packageName: package.name,
        library: package.library,
        genericArity: binding.genericArity,
      );
    }
    for (final identity in rpc.nativePackages.keys) {
      if (!referenced.contains(identity)) {
        _warnings.add(
          'AWSBLOCKS-NATIVE-003: no binding references native package '
          "'${escapeForDiagnostic(identity)}'; it is not imported on dart.",
        );
      }
    }
  }

  /// Two tags may share one export, but two exports cannot share a type name.
  void _checkTypeNameUnclaimed(
    NativeBinding binding,
    String typeName,
    Map<String, ({String package, String export})> claimed,
  ) {
    final String? occupant;
    if (dartCoreTypeNames.contains(typeName)) {
      occupant = 'dart:core or dart:async';
    } else if (blocksRuntimeTypeNames.contains(typeName)) {
      occupant = 'package:blocks_runtime/blocks_runtime.dart';
    } else if (claimed[typeName] case final prior?
        when prior != (package: binding.package, export: binding.export)) {
      occupant =
          "export '${escapeForDiagnostic(prior.export)}' in package "
          "'${escapeForDiagnostic(prior.package)}'";
    } else {
      occupant = null;
    }
    if (occupant != null) {
      throw FormatException(
        "Binding for tag '${escapeForDiagnostic(binding.tag)}' exports "
        "'${escapeForDiagnostic(binding.export)}' from package "
        "'${escapeForDiagnostic(binding.package)}', but $occupant already "
        'declares $typeName',
      );
    }
  }

  String _exportTypeName(String export) {
    if (!_exportGrammar.hasMatch(export)) {
      throw FormatException(
        "Binding export '${escapeForDiagnostic(export)}' does not name a "
        'public Dart type',
      );
    }
    return export.split(RegExp(r'[-_.]+')).map(_capitalize).join();
  }

  void _checkBindingArity(String operation, TransferableType type) {
    final binding = type.binding;
    if (binding == null) return;
    if (type.typeArgs.length != binding.genericArity) {
      throw FormatException(
        '${escapeForDiagnostic(operation)} declares ${type.typeArgs.length} x-blocks-type-args for '
        "tag '${escapeForDiagnostic(type.blocksType)}', but its binding "
        'declares generic arity ${binding.genericArity}',
      );
    }
  }

  /// Dropping the binding routes the result to the `UnknownTransferable`
  /// fallback and `AWSBLOCKS-NATIVE-001`, since the v1 ABI has no decoder-less
  /// arity-one call.
  TransferableType _withDecodableBinding(TransferableType type) {
    final binding = type.binding;
    if (binding == null || binding.genericArity == 0) return type;
    if (channelMessageHydratable(type.typeArgs, _types)) return type;
    return TransferableType(
      blocksType: type.blocksType,
      typeArgs: type.typeArgs,
    );
  }

  String _capitalize(String s) =>
      s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
}

/// Whether a generic transferable's message type-arg can be hydrated by the
/// `Map`-only runtime. An object (record or sealed class, including via `$ref`
/// and the nullable `T?` form) hydrates via `fromJson`, a `Map` per-value, and
/// `dynamic`/`dynamic?`/absent gets an identity decoder.
bool channelMessageHydratable(
  List<ResolvedType> typeArgs,
  Map<String, ResolvedType> allTypes,
) {
  if (typeArgs.isEmpty) return true;
  final arg = typeArgs[0] is NullableType
      ? (typeArgs[0] as NullableType).inner
      : typeArgs[0];
  final resolved = arg is SchemaReference ? allTypes[arg.name] : arg;
  return resolved is RecordType ||
      resolved is SealedClassType ||
      resolved is MapType ||
      (resolved is PrimitiveType && resolved.dartType == 'dynamic');
}
