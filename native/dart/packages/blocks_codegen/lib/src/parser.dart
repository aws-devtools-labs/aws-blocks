import 'dart:convert';

import 'model.dart';

/// Parses an OpenRPC JSON spec into an [RpcModel].
class OpenRpcParser {
  const OpenRpcParser();

  RpcModel parse(String jsonString) {
    final dynamic decoded;
    try {
      decoded = jsonDecode(jsonString);
    } on FormatException catch (e) {
      throw FormatException('Invalid JSON in spec: ${e.message}');
    }
    final spec = decoded as Map<String, dynamic>;
    final info = spec['info'] as Map<String, dynamic>?;
    if (info == null) {
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
            "Missing 'params' array in method '${m['name']}' at index ${entry.key}");
      }
      return _parseMethod(m, schemas);
    }).toList();
    final servers = (spec['servers'] as List<dynamic>?)?.map((s) {
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
    );
  }

  Map<String, TypeRef> _parseSchemas(Map<String, dynamic> spec) {
    final components = spec['components'] as Map<String, dynamic>?;
    if (components == null) return {};
    final schemas = components['schemas'] as Map<String, dynamic>?;
    if (schemas == null) return {};
    return schemas.map((name, schema) =>
        MapEntry(name, _parseTypeRef(schema as Map<String, dynamic>)));
  }

  RpcMethod _parseMethod(
      Map<String, dynamic> method, Map<String, TypeRef> schemas) {
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
      final typeArgs = (schema[typeArgsKey] as List<dynamic>?)
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
      final oneOf =
          (schema['oneOf'] as List<dynamic>).cast<Map<String, dynamic>>();
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
          (schema['enum'] as List<dynamic>).map((v) => v.toString()).toList());
    }

    // Array (check before primitives since arrays have a 'type')
    if (type == 'array') {
      // Tuple: prefixItems defines positional types
      if (schema.containsKey('prefixItems')) {
        final prefixItems = (schema['prefixItems'] as List<dynamic>)
            .map((item) => _parseTypeRef(item as Map<String, dynamic>))
            .toList();
        if (prefixItems.length == 1) return prefixItems.first;
        return TupleRef(prefixItems);
      }
      // Regular array (or array-form items as tuple)
      final items = schema['items'];
      if (items == null)
        return ArrayRef(PrimitiveRef('dynamic'),
            constraints: _parseConstraints(schema));
      if (items is List<dynamic>) {
        final tupleItems = items
            .map((item) => _parseTypeRef(item as Map<String, dynamic>))
            .toList();
        if (tupleItems.length == 1) return tupleItems.first;
        return TupleRef(tupleItems);
      }
      final itemsMap = items as Map<String, dynamic>;
      if (itemsMap.isEmpty)
        return ArrayRef(PrimitiveRef('dynamic'),
            constraints: _parseConstraints(schema));
      return ArrayRef(_parseTypeRef(itemsMap),
          constraints: _parseConstraints(schema));
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

    // Object
    if (type == 'object' && schema.containsKey('properties')) {
      final props = (schema['properties'] as Map<String, dynamic>);
      // Detect spread params garbage (numeric keys + "length")
      if (props.containsKey('length') &&
          props.keys.any((k) => RegExp(r'^\d+$').hasMatch(k))) {
        return const PrimitiveRef('dynamic');
      }
      final parsedProps = props
          .map((k, v) => MapEntry(k, _parseTypeRef(v as Map<String, dynamic>)));
      final required =
          (schema['required'] as List<dynamic>?)?.cast<String>().toSet() ?? {};
      TypeRef? additionalProps;
      if (schema.containsKey('additionalProperties')) {
        final ap = schema['additionalProperties'];
        if (ap is bool && ap) {
          additionalProps = const PrimitiveRef('dynamic');
        } else if (ap is Map<String, dynamic>) {
          additionalProps = _parseTypeRef(ap);
        }
      }
      return InlineObjectRef(
          properties: parsedProps,
          required: required,
          additionalProperties: additionalProps);
    }

    // Primitives
    return PrimitiveRef(_mapPrimitive(type),
        constraints: _parseConstraints(schema));
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
        nonNull.every((v) => v['type'] == 'object' && v.containsKey('properties'))) {
      final discriminant = _findDiscriminant(nonNull);
      if (discriminant != null) {
        final variants = nonNull.map((v) {
          final props = (v['properties'] as Map<String, dynamic>)
              .map((k, val) => MapEntry(k, _parseTypeRef(val as Map<String, dynamic>)));
          final required = (v['required'] as List<dynamic>?)
                  ?.cast<String>()
                  .toSet() ??
              {};
          final discValue =
              ((v['properties'] as Map<String, dynamic>)[discriminant]
                  as Map<String, dynamic>)['enum'][0] as String;
          // Remove discriminant from properties
          final filteredProps = Map<String, TypeRef>.from(props)
            ..remove(discriminant);
          final filteredRequired = Set<String>.from(required)
            ..remove(discriminant);

          // Check for nested oneOf (hybrid arm: properties + embedded union)
          DiscriminatedUnionRef? embeddedUnion;
          if (v.containsKey('oneOf')) {
            final nestedOneOf =
                (v['oneOf'] as List<dynamic>).cast<Map<String, dynamic>>();
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
          );
        }).toList();
        final union = DiscriminatedUnionRef(discriminant: discriminant, variants: variants);
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
    final firstProps =
        (variants.first['properties'] as Map<String, dynamic>).keys.toList();
    for (final field in firstProps) {
      final allMatch = variants.every((v) {
        final props = v['properties'] as Map<String, dynamic>;
        if (!props.containsKey(field)) return false;
        final p = props[field] as Map<String, dynamic>;
        return p['type'] == 'string' &&
            p.containsKey('enum') &&
            (p['enum'] as List).length == 1;
      });
      if (allMatch) return field;
    }
    return null;
  }

  Constraints? _parseConstraints(Map<String, dynamic> schema) {
    final c = Constraints(
      minLength: schema['minLength'] as int?,
      maxLength: schema['maxLength'] as int?,
      pattern: schema['pattern'] as String?,
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
