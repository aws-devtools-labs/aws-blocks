import 'dart:convert';

import 'package:blocks_codegen/src/diagnostics.dart';
import 'model.dart';

const _packagesExtension = 'x-blocks-native-packages';
const _bindingsExtension = 'x-blocks-native-bindings';
const _catalogSchemaVersion = 1;
const _transferableKind = 'transferable';
const _transferableAbiV1 = 'blocks-transferable-v1';
const _maxGenericArity = 1;

final _pubPackageName = RegExp(r'^[a-z_][a-z0-9_]*$');

const _runtimePackage = 'blocks_runtime';

/// Every segment must start with `[a-z_]`, so no segment can be `..` and the
/// value can neither traverse out of the package nor close the string literal
/// of the emitted import.
final _entryLibraryPath = RegExp(
  r'^(?!lib/)[a-z_][a-z0-9_.]*(/[a-z_][a-z0-9_.]*)*\.dart$',
);

/// Parses an OpenRPC JSON spec into an [RpcModel].
class OpenRpcParser {
  const OpenRpcParser();

  /// Parses [jsonString] as an OpenRPC document.
  ///
  /// Throws a [FormatException] if the JSON is malformed, the `info` or
  /// `methods` sections are missing or the wrong shape, or a present
  /// `x-blocks-native-*` catalog is malformed.
  RpcModel parse(String jsonString) {
    final dynamic decoded;
    try {
      decoded = jsonDecode(jsonString);
    } on FormatException catch (e) {
      throw FormatException('Invalid JSON in spec: ${e.message}');
    }
    final spec = decoded as Map<String, dynamic>;
    final info = spec['info'];
    if (info is! Map<String, dynamic>) {
      throw const FormatException("Expected 'info' object in spec root");
    }
    final methodsList = spec['methods'];
    if (methodsList is! List) {
      throw const FormatException("Expected 'methods' array in spec root");
    }
    final schemas = _parseSchemas(spec);
    final methods = methodsList.asMap().entries.map((entry) {
      final m = entry.value as Map<String, dynamic>;
      if (m['name'] == null) {
        throw FormatException("Missing 'name' in method at index ${entry.key}");
      }
      if (m['params'] is! List) {
        throw FormatException(
          "Missing 'params' array in method '${m['name']}' at index ${entry.key}",
        );
      }
      return _parseMethod(m, schemas);
    }).toList();
    final servers =
        (spec['servers'] as List<dynamic>?)?.map((s) {
          final server = s as Map<String, dynamic>;
          return Server(
            name: server['name'] as String,
            url: server['url'] as String,
          );
        }).toList() ??
        [];
    return RpcModel(
      title: info['title'] as String,
      version: info['version'] as String,
      methods: methods,
      schemas: schemas,
      servers: servers,
      nativePackages: _parseNativePackages(spec),
      nativeBindings: _parseNativeBindings(spec),
    );
  }

  Map<String, DartNativePackage?> _parseNativePackages(
    Map<String, dynamic> spec,
  ) {
    final catalog = _catalog(spec, _packagesExtension);
    if (catalog == null) return const {};
    final packages = catalog['packages'];
    if (packages is! Map<String, dynamic>) {
      throw const FormatException(
        "Expected '$_packagesExtension.packages' to be an object",
      );
    }
    return packages.map((identity, entry) {
      final path =
          '$_packagesExtension.packages.${escapeForDiagnostic(identity)}';
      if (entry is! Map<String, dynamic>) {
        throw FormatException("Expected '$path' to be an object");
      }
      final platforms = entry['platforms'];
      if (platforms is! Map<String, dynamic>) {
        throw FormatException("Expected '$path.platforms' to be an object");
      }
      final dart = platforms['dart'];
      if (dart == null) return MapEntry(identity, null);
      if (dart is! Map<String, dynamic>) {
        throw FormatException(
          "Expected '$path.platforms.dart' to be an object",
        );
      }
      final package = dart['package'];
      if (package is! Map<String, dynamic>) {
        throw FormatException(
          "Expected '$path.platforms.dart.package' to be an object",
        );
      }
      final name = _requiredMatch(
        package,
        'name',
        '$path.platforms.dart.package',
        _pubPackageName,
        'a pub package name',
      );
      if (name == _runtimePackage) {
        throw FormatException(
          "Expected '$path.platforms.dart.package.name' to name a package "
          "other than '$_runtimePackage', which every generated client "
          'already imports',
        );
      }
      return MapEntry(
        identity,
        DartNativePackage(
          name: name,
          library: _requiredMatch(
            package,
            'library',
            '$path.platforms.dart.package',
            _entryLibraryPath,
            'a .dart path inside lib/, without the leading "lib/"',
          ),
        ),
      );
    });
  }

  List<NativeBinding> _parseNativeBindings(Map<String, dynamic> spec) {
    final catalog = _catalog(spec, _bindingsExtension);
    if (catalog == null) return const [];
    final bindings = catalog['bindings'];
    if (bindings is! List) {
      throw const FormatException(
        "Expected '$_bindingsExtension.bindings' to be an array",
      );
    }
    final byTag = <String, int>{};
    return bindings.asMap().entries.map((entry) {
      final path = '$_bindingsExtension.bindings[${entry.key}]';
      final binding = entry.value;
      if (binding is! Map<String, dynamic>) {
        throw FormatException("Expected '$path' to be an object");
      }
      final tag = _requiredField(binding, 'tag', path);
      final duplicate = byTag[tag];
      if (duplicate != null) {
        throw FormatException(
          "Duplicate binding for tag '${escapeForDiagnostic(tag)}' at "
          "'$path' and "
          "'$_bindingsExtension.bindings[$duplicate]'",
        );
      }
      byTag[tag] = entry.key;
      final arity = binding['genericArity'];
      if (arity is! int || arity < 0 || arity > _maxGenericArity) {
        throw FormatException(
          "Expected '$path.genericArity' to be 0 or $_maxGenericArity",
        );
      }
      final abi = _requiredField(binding, 'abi', path);
      final kind = _requiredField(binding, 'kind', path);
      if (kind == _transferableKind && abi != _transferableAbiV1) {
        throw FormatException(
          "Unsupported '$path.abi': '${escapeForDiagnostic(abi)}' "
          "(expected '$_transferableAbiV1')",
        );
      }
      return NativeBinding(
        kind: kind,
        tag: tag,
        package: _requiredField(binding, 'package', path),
        export: _requiredField(binding, 'export', path),
        abi: abi,
        genericArity: arity,
      );
    }).toList();
  }

  Map<String, dynamic>? _catalog(Map<String, dynamic> spec, String key) {
    final catalog = spec[key];
    if (catalog == null) return null;
    if (catalog is! Map<String, dynamic>) {
      throw FormatException("Expected '$key' to be an object");
    }
    final schemaVersion = catalog['schemaVersion'];
    if (schemaVersion != _catalogSchemaVersion) {
      throw FormatException(
        "Unsupported '$key.schemaVersion': "
        '${escapeForDiagnostic('$schemaVersion')} '
        '(expected $_catalogSchemaVersion)',
      );
    }
    return catalog;
  }

  String _requiredMatch(
    Map<String, dynamic> owner,
    String field,
    String path,
    RegExp pattern,
    String shape,
  ) {
    final value = _requiredField(owner, field, path);
    if (!pattern.hasMatch(value)) {
      throw FormatException(
        "Expected '$path.$field' to be $shape, got "
        "'${escapeForDiagnostic(value)}'",
      );
    }
    return value;
  }

  String _requiredField(Map<String, dynamic> owner, String field, String path) {
    final value = owner[field];
    if (value is! String || value.isEmpty) {
      throw FormatException("Expected '$path.$field' to be a non-empty string");
    }
    return value;
  }

  Map<String, TypeRef> _parseSchemas(Map<String, dynamic> spec) {
    final components = spec['components'] as Map<String, dynamic>?;
    if (components == null) return {};
    final schemas = components['schemas'] as Map<String, dynamic>?;
    if (schemas == null) return {};
    return schemas.map(
      (name, schema) =>
          MapEntry(name, _parseTypeRef(schema as Map<String, dynamic>)),
    );
  }

  RpcMethod _parseMethod(
    Map<String, dynamic> method,
    Map<String, TypeRef> schemas,
  ) {
    final params = (method['params'] as List<dynamic>).map((p) {
      final param = p as Map<String, dynamic>;
      return RpcParam(
        name: param['name'] as String,
        isRequired: param['required'] as bool? ?? false,
        schema: _parseTypeRef(param['schema'] as Map<String, dynamic>),
      );
    }).toList();

    final result = method['result'] as Map<String, dynamic>;
    final resultSchema = result['schema'] as Map<String, dynamic>;

    return RpcMethod(
      name: method['name'] as String,
      params: params,
      result: _parseTypeRef(resultSchema),
      resultName: result['name'] as String?,
    );
  }

  TypeRef _parseTypeRef(Map<String, dynamic> schema) {
    // Check for transferable
    if (schema.containsKey('x-blocks-transferable')) {
      final transferableKey = 'x-blocks-transferable';
      final typeArgsKey = 'x-blocks-type-args';
      final typeArgs =
          (schema[typeArgsKey] as List<dynamic>?)
              ?.map((a) => _parseTypeRef(a as Map<String, dynamic>))
              .toList() ??
          [];
      return TransferableRef(
        blocksType: schema[transferableKey] as String,
        typeArgs: typeArgs,
      );
    }

    // Check for $ref
    if (schema.containsKey(r'$ref')) {
      final ref = schema[r'$ref'] as String;
      final name = ref.split('/').last;
      return SchemaRefRef(name);
    }

    // Check for oneOf (nullable or discriminated union)
    if (schema.containsKey('oneOf')) {
      final oneOf = (schema['oneOf'] as List<dynamic>)
          .cast<Map<String, dynamic>>();
      return _parseOneOf(oneOf);
    }

    final type = schema['type'] as String?;

    // Check for enum. Only a *string* enum becomes a Dart enum
    // (`UnionLiteralRef`). An `enum` constraint on a non-string primitive —
    // most commonly a boolean discriminator arm like
    // `{"type":"boolean","enum":[true]}` — is just a value restriction on that
    // primitive, NOT a distinct type. Turning it into a Dart enum would emit
    // `enum Foo { true }` / `enum Foo { false }`, and `true`/`false` are
    // reserved words that don't compile. Fall through to the primitive mapping
    // instead (a plain `bool`), matching the Swift and Kotlin generators which
    // both ignore the enum constraint on non-string primitives.
    if (schema.containsKey('enum') && (type == null || type == 'string')) {
      return UnionLiteralRef(
        (schema['enum'] as List<dynamic>).map((v) => v.toString()).toList(),
      );
    }

    // Array (check before primitives since arrays have a 'type')
    if (type == 'array') {
      // Tuple: prefixItems defines positional types
      if (schema.containsKey('prefixItems')) {
        final prefixItems = (schema['prefixItems'] as List<dynamic>)
            .map((item) => _parseTypeRef(item as Map<String, dynamic>))
            .toList();
        // One element (`[string]`) is the array `["x"]`: a one-element list,
        // as in Swift, never the element itself.
        if (prefixItems.length == 1) {
          return ArrayRef(
            prefixItems.first,
            constraints: _parseConstraints(schema),
          );
        }
        return TupleRef(prefixItems);
      }
      // Regular array (or array-form items as tuple)
      final items = schema['items'];
      if (items == null) {
        return ArrayRef(
          PrimitiveRef('dynamic'),
          constraints: _parseConstraints(schema),
        );
      }
      if (items is List<dynamic>) {
        final tupleItems = items
            .map((item) => _parseTypeRef(item as Map<String, dynamic>))
            .toList();
        if (tupleItems.length == 1) {
          return ArrayRef(
            tupleItems.first,
            constraints: _parseConstraints(schema),
          );
        }
        return TupleRef(tupleItems);
      }
      final itemsMap = items as Map<String, dynamic>;
      if (itemsMap.isEmpty) {
        return ArrayRef(
          PrimitiveRef('dynamic'),
          constraints: _parseConstraints(schema),
        );
      }
      return ArrayRef(
        _parseTypeRef(itemsMap),
        constraints: _parseConstraints(schema),
      );
    }

    // Object with additionalProperties (Map<String, T>)
    if (type == 'object' && schema.containsKey('additionalProperties')) {
      final props = schema['properties'] as Map<String, dynamic>?;
      if (props == null || props.isEmpty) {
        final addProps = schema['additionalProperties'];
        final valueType = addProps is Map<String, dynamic>
            ? _parseTypeRef(addProps)
            : const PrimitiveRef('dynamic');
        return MapRef(valueType);
      }
    }

    // Object. One with no properties (`properties: {}`) holds any fields, as
    // `{type: object}` does: it falls through to `dynamic` below.
    if (type == 'object' &&
        (schema['properties'] as Map<String, dynamic>?)?.isNotEmpty == true) {
      final props = (schema['properties'] as Map<String, dynamic>);
      // Detect spread params garbage (numeric keys + "length")
      if (props.containsKey('length') &&
          props.keys.any((k) => RegExp(r'^\d+$').hasMatch(k))) {
        return const PrimitiveRef('dynamic');
      }
      final parsedProps = props.map(
        (k, v) => MapEntry(k, _parseTypeRef(v as Map<String, dynamic>)),
      );
      final required =
          (schema['required'] as List<dynamic>?)?.cast<String>().toSet() ?? {};
      return InlineObjectRef(
        properties: parsedProps,
        required: required,
        additionalProperties: _parseAdditionalProperties(schema),
      );
    }

    // Primitives
    return PrimitiveRef(
      _mapPrimitive(type),
      constraints: _parseConstraints(schema),
    );
  }

  /// The value type of an object schema's extra keys (an open record, TS
  /// `T & Record<string, V>`): `true` admits any value (`dynamic`), a schema
  /// types them, and `false` or no `additionalProperties` closes the object.
  TypeRef? _parseAdditionalProperties(Map<String, dynamic> schema) {
    final ap = schema['additionalProperties'];
    if (ap is bool && ap) return const PrimitiveRef('dynamic');
    if (ap is Map<String, dynamic>) return _parseTypeRef(ap);
    return null;
  }

  TypeRef _parseOneOf(List<Map<String, dynamic>> oneOf) {
    // A `{"type":"null"}` member (e.g. from TS `Partial<Record<K, V>>`) does
    // not participate in discrimination and must not become a sealed-class
    // variant. Strip such members out, and if any were present mark the
    // resolved union nullable. The remaining (non-null) arms drive the
    // nullable/discriminated-union detection below.
    final hasNullMember = oneOf.any((s) => s['type'] == 'null');
    final nonNull = oneOf.where((s) => s['type'] != 'null').toList();

    // Nullable of a single member: [T, {type: "null"}] → T?
    if (hasNullMember && nonNull.length == 1) {
      return NullableRef(_parseTypeRef(nonNull.first));
    }

    // Check discriminated union: all objects with a shared single-value enum field
    if (nonNull.isNotEmpty &&
        nonNull.every(
          (v) => v['type'] == 'object' && v.containsKey('properties'),
        )) {
      final discriminant = _findDiscriminant(nonNull);
      if (discriminant != null) {
        // A boolean-enum discriminant (`{"type":"boolean","enum":[true|false]}`)
        // is handled distinctly from the usual string enum: its JSON value is a
        // real bool, not a quoted string.
        final discriminantIsBoolean = nonNull.every((v) {
          final p =
              (v['properties'] as Map<String, dynamic>)[discriminant]
                  as Map<String, dynamic>;
          return p['type'] == 'boolean';
        });
        final variants = nonNull.map((v) {
          final props = (v['properties'] as Map<String, dynamic>).map(
            (k, val) => MapEntry(k, _parseTypeRef(val as Map<String, dynamic>)),
          );
          final required =
              (v['required'] as List<dynamic>?)?.cast<String>().toSet() ?? {};
          // `.toString()` yields the literal value for both string ("create")
          // and boolean (true/false) discriminants; `as String` would throw on
          // a bool.
          final discValue =
              ((v['properties'] as Map<String, dynamic>)[discriminant]
                      as Map<String, dynamic>)['enum'][0]
                  .toString();
          // Remove discriminant from properties
          final filteredProps = Map<String, TypeRef>.from(props)
            ..remove(discriminant);
          final filteredRequired = Set<String>.from(required)
            ..remove(discriminant);

          // Check for nested oneOf (hybrid arm: properties + embedded union)
          DiscriminatedUnionRef? embeddedUnion;
          if (v.containsKey('oneOf')) {
            final nestedOneOf = (v['oneOf'] as List<dynamic>)
                .cast<Map<String, dynamic>>();
            final parsed = _parseOneOf(nestedOneOf);
            if (parsed is DiscriminatedUnionRef) {
              embeddedUnion = parsed;
            }
          }

          return UnionVariant(
            discriminantValue: discValue,
            properties: filteredProps,
            required: filteredRequired,
            embeddedUnion: embeddedUnion,
            additionalProperties: _parseAdditionalProperties(v),
          );
        }).toList();
        final union = DiscriminatedUnionRef(
          discriminant: discriminant,
          variants: variants,
          discriminantIsBoolean: discriminantIsBoolean,
        );
        return hasNullMember ? NullableRef(union) : union;
      }
    }

    // Fallback: treat as nullable of first non-null
    if (nonNull.length == 1) {
      return NullableRef(_parseTypeRef(nonNull.first));
    }
    return const PrimitiveRef('dynamic');
  }

  String? _findDiscriminant(List<Map<String, dynamic>> variants) {
    final firstProps = (variants.first['properties'] as Map<String, dynamic>)
        .keys
        .toList();
    // A discriminant is a required-shaped single-value enum field shared by
    // every arm. String discriminants are the classic case; a boolean-enum
    // field (`{"type":"boolean","enum":[true|false]}`) also discriminates.
    bool isDiscriminantField(String field, String type) {
      return variants.every((v) {
        final props = v['properties'] as Map<String, dynamic>;
        if (!props.containsKey(field)) return false;
        final p = props[field] as Map<String, dynamic>;
        return p['type'] == type &&
            p.containsKey('enum') &&
            (p['enum'] as List).length == 1;
      });
    }

    // Prefer a string discriminant (preserves existing selection), then fall
    // back to a boolean one.
    for (final field in firstProps) {
      if (isDiscriminantField(field, 'string')) return field;
    }
    for (final field in firstProps) {
      if (isDiscriminantField(field, 'boolean')) return field;
    }
    return null;
  }

  /// The generator emits [pattern] into a `RegExp`, so an invalid one analyzes
  /// without error and throws on the customer's first call, where the spec is
  /// gone.
  String? _validRegExp(String? pattern) {
    if (pattern == null) return null;
    try {
      RegExp(pattern);
    } on FormatException catch (e) {
      throw FormatException(
        "Expected 'pattern' to be a regular expression Dart can compile, got "
        "'${escapeForDiagnostic(pattern)}': ${e.message}",
      );
    }
    return pattern;
  }

  Constraints? _parseConstraints(Map<String, dynamic> schema) {
    final c = Constraints(
      minLength: schema['minLength'] as int?,
      maxLength: schema['maxLength'] as int?,
      pattern: _validRegExp(schema['pattern'] as String?),
      minimum: schema['minimum'] as num?,
      maximum: schema['maximum'] as num?,
      exclusiveMinimum: schema['exclusiveMinimum'] as num?,
      exclusiveMaximum: schema['exclusiveMaximum'] as num?,
      multipleOf: schema['multipleOf'] as num?,
      minItems: schema['minItems'] as int?,
      maxItems: schema['maxItems'] as int?,
    );
    return c.isEmpty ? null : c;
  }

  String _mapPrimitive(String? type) {
    return switch (type) {
      'string' => 'String',
      'integer' => 'int',
      'number' => 'num',
      'boolean' => 'bool',
      'null' => 'void',
      _ => 'dynamic',
    };
  }
}
