import 'builder.dart';
import 'model.dart';

/// Generates Dart source code from a [CodegenModel].
class DartCodeGenerator {
  const DartCodeGenerator();

  String generate(CodegenModel model) {
    final buf = StringBuffer();
    buf.writeln('// GENERATED CODE — DO NOT MODIFY BY HAND');
    buf.writeln('// Generator: blocks-codegen');
    buf.writeln('// Source: ${model.title} v${model.version}');
    buf.writeln('// ignore_for_file: constant_identifier_names');
    buf.writeln();
    buf.writeln("import 'package:blocks_runtime/blocks_runtime.dart';");
    buf.writeln(
        "export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;");

    // Export transferable types for consumer convenience
    final hasTransferables = model.types.values
            .any((t) => t is TransferableType) ||
        model.namespaces.any(
            (ns) => ns.operations.any((op) => op.result is TransferableType));
    if (hasTransferables) {
      buf.writeln(
          "export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;");
    }

    final hasOidc = model.types.values.any(
            (t) => t is TransferableType && t.blocksType == 'oidc/client') ||
        model.namespaces.any((ns) => ns.operations.any((op) =>
            op.result is TransferableType &&
            (op.result as TransferableType).blocksType == 'oidc/client'));
    if (hasOidc) {
      buf.writeln(
          "export 'package:blocks_runtime/blocks_runtime.dart' show OidcClient, OidcAuthState, OidcSignedIn, OidcSignedOut, OidcLoading, OidcUser, TokenStore, InMemoryTokenStore, AuthProvider, BrowserLauncher, ProviderConfig;");
    }
    buf.writeln();

    // Collect all types to emit
    final emittedTypes = <String>{};

    // Classify types: schema-defined or multi-use → shared; single-use → namespace-scoped
    final typeUsage =
        <String, Set<String>>{}; // type name → set of namespace names using it
    for (final ns in model.namespaces) {
      for (final op in ns.operations) {
        for (final ref in _collectTypeRefs(op.result)) {
          typeUsage.putIfAbsent(ref, () => {}).add(ns.name);
        }
        for (final p in op.params) {
          for (final ref in _collectTypeRefs(p.type)) {
            typeUsage.putIfAbsent(ref, () => {}).add(ns.name);
          }
        }
      }
    }

    // Schema-defined types are always shared
    final schemaTypes = model.types.keys.where((name) {
      // Types from schemas (resolved in pass 1) — heuristic: not ending in Result/Input pattern
      // Actually just check if used by multiple namespaces or is a named schema
      final usage = typeUsage[name];
      return usage == null || usage.length > 1;
    }).toSet();

    // Emit shared models first
    buf.writeln('// --- Models ---');
    buf.writeln();
    for (final entry in model.types.entries) {
      if (emittedTypes.contains(entry.key)) continue;
      if (!schemaTypes.contains(entry.key) && typeUsage.containsKey(entry.key))
        continue;
      final code = _emitType(entry.value, model.types, emittedTypes);
      if (code.isNotEmpty) {
        buf.writeln(code);
        buf.writeln();
      }
    }

    // Emit namespace API classes with their single-use types grouped nearby
    buf.writeln('// --- API Namespaces ---');
    buf.writeln();
    for (final ns in model.namespaces) {
      // Emit single-use types for this namespace first
      final nsTypes = model.types.entries
          .where((e) =>
              !emittedTypes.contains(e.key) &&
              typeUsage[e.key]?.length == 1 &&
              typeUsage[e.key]?.first == ns.name)
          .toList();
      for (final entry in nsTypes) {
        final code = _emitType(entry.value, model.types, emittedTypes);
        if (code.isNotEmpty) {
          buf.writeln(code);
          buf.writeln();
        }
      }
      buf.writeln(_emitNamespace(ns, model.types));
      buf.writeln();
    }

    // Emit Servers class if servers are defined
    if (model.servers.isNotEmpty) {
      buf.writeln(_emitServers(model.servers));
      buf.writeln();
    }

    // Emit Blocks facade
    buf.writeln(_emitBlocksFacade(model.namespaces, model.servers));

    return buf.toString();
  }

  String _emitType(ResolvedType type, Map<String, ResolvedType> allTypes,
      Set<String> emitted) {
    return switch (type) {
      RecordType() => _emitRecord(type, allTypes, emitted),
      EnumType() => _emitEnum(type, emitted),
      SealedClassType() => _emitSealedClass(type, allTypes, emitted),
      _ => '',
    };
  }

  String _emitRecord(RecordType record, Map<String, ResolvedType> allTypes,
      Set<String> emitted) {
    if (emitted.contains(record.name)) return '';
    emitted.add(record.name);
    final buf = StringBuffer();
    final hasAdditional = record.additionalProperties != null;
    final additionalValueType = hasAdditional
        ? _dartTypeStr(record.additionalProperties!, allTypes)
        : null;

    // Collect validation checks for constrained fields
    final validations = <String>[];
    for (final f in record.fields) {
      final constraints = _getConstraints(f.type);
      if (constraints == null) continue;
      final ident = _escapeIdentifier(f.name);
      final stmts = _buildValidations(ident, constraints, !f.isRequired);
      validations.addAll(stmts);
    }
    final hasValidations = validations.isNotEmpty;

    buf.writeln('class ${record.name} {');
    // Fields
    for (final f in record.fields) {
      final typeStr = _dartTypeStr(f.type, allTypes);
      final nullable = !f.isRequired && !typeStr.endsWith('?');
      final ident = _escapeIdentifier(f.name);
      buf.writeln('  final $typeStr${nullable ? '?' : ''} $ident;');
    }
    if (hasAdditional) {
      buf.writeln(
          '  final Map<String, $additionalValueType> additionalProperties;');
    }
    buf.writeln();

    // Constructor (drop const if we have validations)
    buf.writeln('  ${hasValidations ? '' : 'const '}${record.name}({');
    for (final f in record.fields) {
      final ident = _escapeIdentifier(f.name);
      buf.writeln('    ${f.isRequired ? 'required ' : ''}this.$ident,');
    }
    if (hasAdditional) {
      buf.writeln('    this.additionalProperties = const {},');
    }
    if (hasValidations) {
      buf.writeln('  }) {');
      for (final v in validations) {
        buf.writeln('    $v');
      }
      buf.writeln('  }');
    } else {
      buf.writeln('  });');
    }
    buf.writeln();

    // fromJson
    buf.writeln(
        '  factory ${record.name}.fromJson(Map<String, dynamic> json) {');
    if (hasAdditional) {
      final knownKeys = record.fields.map((f) => "'${f.name}'").join(', ');
      buf.writeln('    const knownKeys = {$knownKeys};');
    }
    buf.writeln('    return ${record.name}(');
    for (final f in record.fields) {
      final ident = _escapeIdentifier(f.name);
      buf.writeln(
          "      $ident: ${_fromJsonExpr("json['${f.name}']", f.type, allTypes, !f.isRequired)},");
    }
    if (hasAdditional) {
      final castExpr = additionalValueType == 'dynamic'
          ? 'e.value'
          : 'e.value as $additionalValueType';
      buf.writeln('      additionalProperties: Map.fromEntries(');
      buf.writeln(
          '        json.entries.where((e) => !knownKeys.contains(e.key))');
      buf.writeln('            .map((e) => MapEntry(e.key, $castExpr)),');
      buf.writeln('      ),');
    }
    buf.writeln('    );');
    buf.writeln('  }');
    buf.writeln();

    // toJson
    buf.writeln('  Map<String, dynamic> toJson() {');
    buf.writeln('    return {');
    for (final f in record.fields) {
      final ident = _escapeIdentifier(f.name);
      final expr = _toJsonExpr(ident, f.type, allTypes, !f.isRequired);
      if (f.isRequired) {
        buf.writeln("      '${f.name}': $expr,");
      } else {
        buf.writeln("      if ($ident != null) '${f.name}': $expr,");
      }
    }
    if (hasAdditional) {
      buf.writeln('      ...additionalProperties,');
    }
    buf.writeln('    };');
    buf.writeln('  }');

    // == / hashCode / toString
    final allFields = [
      for (final f in record.fields) _escapeIdentifier(f.name),
      if (hasAdditional) 'additionalProperties',
    ];
    _emitEquality(buf, record.name, allFields);

    buf.writeln('}');
    return buf.toString();
  }

  String _emitEnum(EnumType enumType, Set<String> emitted) {
    if (emitted.contains(enumType.name)) return '';
    emitted.add(enumType.name);
    final buf = StringBuffer();
    final sanitized = enumType.values.map(_sanitizeEnumValue).toList();
    final needsMap = enumType.values.any((v) => v != _sanitizeEnumValue(v));
    buf.writeln('enum ${enumType.name} {');
    buf.writeln(sanitized.map((v) => '  $v').join(',\n'));
    buf.writeln(';');
    buf.writeln();
    if (needsMap) {
      buf.writeln('  static const _jsonMap = <String, ${enumType.name}>{');
      for (var i = 0; i < enumType.values.length; i++) {
        buf.writeln("    '${enumType.values[i]}': ${sanitized[i]},");
      }
      buf.writeln('  };');
      buf.writeln('  static const _toJsonMap = <${enumType.name}, String>{');
      for (var i = 0; i < enumType.values.length; i++) {
        buf.writeln("    ${sanitized[i]}: '${enumType.values[i]}',");
      }
      buf.writeln('  };');
      buf.writeln('  String toJson() => _toJsonMap[this]!;');
      buf.writeln(
          '  static ${enumType.name} fromJson(String json) => _jsonMap[json]!;');
    } else {
      buf.writeln('  String toJson() => name;');
      buf.writeln(
          '  static ${enumType.name} fromJson(String json) => values.byName(json);');
    }
    buf.writeln('}');
    return buf.toString();
  }

  String _sanitizeEnumValue(String value) {
    // Convert kebab-case, snake_case, or other non-identifier chars to camelCase
    if (RegExp(r'^[a-zA-Z_][a-zA-Z0-9_]*$').hasMatch(value)) return value;
    final parts = value.split(RegExp(r'[-_.\s]+'));
    final result = parts.first +
        parts
            .skip(1)
            .map((p) => p.isEmpty ? '' : p[0].toUpperCase() + p.substring(1))
            .join();
    // Ensure it starts with a letter
    if (result.isEmpty || !RegExp(r'^[a-zA-Z_]').hasMatch(result))
      return '_$result';
    return result;
  }

  String _emitSealedClass(SealedClassType sealed,
      Map<String, ResolvedType> allTypes, Set<String> emitted) {
    if (emitted.contains(sealed.name)) return '';
    emitted.add(sealed.name);
    final buf = StringBuffer();

    // Base sealed class
    buf.writeln('sealed class ${sealed.name} {');
    buf.writeln('  const ${sealed.name}();');
    buf.writeln('  Map<String, dynamic> toJson();');
    buf.writeln('  static ${sealed.name} fromJson(Map<String, dynamic> json) {');
    if (sealed.discriminantIsBoolean) {
      // Boolean discriminant: switch on the real bool; case labels and the
      // serialized value are unquoted true/false literals. true/false are
      // exhaustive for a bool, so no (unreachable) default clause is emitted.
      buf.writeln("    switch (json['${sealed.discriminant}'] as bool) {");
      for (final v in sealed.variants) {
        buf.writeln("      case ${v.discriminantValue}: return ${v.className}.fromJson(json);");
      }
      buf.writeln('    }');
    } else {
      buf.writeln("    switch (json['${sealed.discriminant}'] as String) {");
      for (final v in sealed.variants) {
        buf.writeln("      case '${v.discriminantValue}': return ${v.className}.fromJson(json);");
      }
      buf.writeln("      default: throw ArgumentError('Unknown ${sealed.discriminant}: \${json['${sealed.discriminant}']}');");
      buf.writeln('    }');
    }
    buf.writeln('  }');
    buf.writeln('}');
    buf.writeln();

    // Variant subclasses
    for (final v in sealed.variants) {
      // Emit embedded union sealed class if present
      if (v.embeddedUnion != null) {
        buf.writeln(_emitSealedClass(v.embeddedUnion!, allTypes, emitted));
        buf.writeln();
      }

      buf.writeln('class ${v.className} extends ${sealed.name} {');
      for (final f in v.fields) {
        final typeStr = _dartTypeStr(f.type, allTypes);
        final nullable = !f.isRequired && !typeStr.endsWith('?');
        final ident = _escapeIdentifier(f.name);
        buf.writeln('  final $typeStr${nullable ? '?' : ''} $ident;');
      }
      if (v.embeddedUnion != null) {
        buf.writeln(
            '  final ${v.embeddedUnion!.name} ${v.embeddedUnion!.discriminant};');
      }
      buf.writeln();

      if (v.fields.isEmpty && v.embeddedUnion == null) {
        buf.writeln('  const ${v.className}();');
      } else {
        buf.writeln('  const ${v.className}({');
        for (final f in v.fields) {
          final ident = _escapeIdentifier(f.name);
          buf.writeln('    ${f.isRequired ? 'required ' : ''}this.$ident,');
        }
        if (v.embeddedUnion != null) {
          buf.writeln('    required this.${v.embeddedUnion!.discriminant},');
        }
        buf.writeln('  });');
      }
      buf.writeln();

      // fromJson
      buf.writeln(
          '  factory ${v.className}.fromJson(Map<String, dynamic> json) {');
      buf.writeln('    return ${v.className}(');
      for (final f in v.fields) {
        final ident = _escapeIdentifier(f.name);
        buf.writeln(
            "      $ident: ${_fromJsonExpr("json['${f.name}']", f.type, allTypes, !f.isRequired)},");
      }
      if (v.embeddedUnion != null) {
        buf.writeln(
            "      ${v.embeddedUnion!.discriminant}: ${v.embeddedUnion!.name}.fromJson(json),");
      }
      buf.writeln('    );');
      buf.writeln('  }');
      buf.writeln();

      // toJson
      buf.writeln('  @override');
      buf.writeln('  Map<String, dynamic> toJson() {');
      buf.writeln('    return {');
      if (sealed.discriminantIsBoolean) {
        buf.writeln("      '${sealed.discriminant}': ${v.discriminantValue},");
      } else {
        buf.writeln("      '${sealed.discriminant}': '${v.discriminantValue}',");
      }
      for (final f in v.fields) {
        final ident = _escapeIdentifier(f.name);
        final expr = _toJsonExpr(ident, f.type, allTypes, !f.isRequired);
        if (f.isRequired) {
          buf.writeln("      '${f.name}': $expr,");
        } else {
          buf.writeln("      if ($ident != null) '${f.name}': $expr,");
        }
      }
      if (v.embeddedUnion != null) {
        buf.writeln("      ...${v.embeddedUnion!.discriminant}.toJson(),");
      }
      buf.writeln('    };');
      buf.writeln('  }');

      // == / hashCode / toString
      final variantFields = [
        for (final f in v.fields) _escapeIdentifier(f.name),
        if (v.embeddedUnion != null) v.embeddedUnion!.discriminant,
      ];
      _emitEquality(buf, v.className, variantFields);

      buf.writeln('}');
      buf.writeln();
    }
    return buf.toString();
  }

  String _emitNamespace(Namespace ns, Map<String, ResolvedType> allTypes) {
    final className = '${_capitalize(ns.name)}Api';
    final buf = StringBuffer();
    buf.writeln('class $className {');
    buf.writeln('  final BlocksClient _client;');
    buf.writeln('  $className(this._client);');

    for (final op in ns.operations) {
      buf.writeln();
      final returnType = _dartTypeStr(op.result, allTypes);
      final isVoid = returnType == 'void';
      final asyncReturn = isVoid ? 'Future<void>' : 'Future<$returnType>';
      final methodName = _escapeIdentifier(op.name);

      // Build parameter signature
      final paramParts = <String>[];
      for (final p in op.params) {
        final typeStr = _dartTypeStr(p.type, allTypes);
        final ident = _escapeIdentifier(p.name);
        if (p.isRequired) {
          paramParts.add('required $typeStr $ident');
        } else {
          final nullable = typeStr.endsWith('?') ? typeStr : '$typeStr?';
          paramParts.add('$nullable $ident');
        }
      }
      final paramSig = paramParts.isEmpty ? '' : '{${paramParts.join(', ')}}';

      buf.writeln('  $asyncReturn $methodName($paramSig) async {');

      // Build params map
      if (op.params.isNotEmpty) {
        buf.writeln('    final params = <String, dynamic>{');
        for (final p in op.params) {
          final ident = _escapeIdentifier(p.name);
          final valExpr = _paramToJsonExpr(ident, p.type, allTypes);
          if (p.isRequired) {
            buf.writeln("      '${p.name}': $valExpr,");
          } else {
            if (_needsTransform(p.type, allTypes)) {
              buf.writeln(
                  "      if ($ident != null) '${p.name}': $ident.toJson(),");
            } else {
              buf.writeln("      if ($ident != null) '${p.name}': $ident,");
            }
          }
        }
        buf.writeln('    };');
      }

      final paramsArg = op.params.isNotEmpty ? 'params' : '<String, dynamic>{}';

      if (isVoid) {
        buf.writeln("    await _client.call('${op.fullName}', $paramsArg);");
      } else {
        buf.writeln(
            "    final result = await _client.call('${op.fullName}', $paramsArg);");
        buf.writeln(
            '    return ${_deserializeExpr('result', op.result, allTypes)};');
      }
      buf.writeln('  }');
    }

    buf.writeln('}');
    return buf.toString();
  }

  String _emitServers(List<Server> servers) {
    final buf = StringBuffer();
    buf.writeln('// --- Servers ---');
    buf.writeln();
    buf.writeln('class Servers {');
    for (final server in servers) {
      final fieldName = _escapeIdentifier(server.name);
      buf.writeln("  static const String $fieldName = '${server.url}';");
    }
    buf.writeln('}');
    return buf.toString();
  }

  String _emitBlocksFacade(List<Namespace> namespaces, List<Server> servers) {
    final buf = StringBuffer();
    buf.writeln('// --- Blocks Client ---');
    buf.writeln();
    buf.writeln('class Blocks {');
    for (final ns in namespaces) {
      final ident = _escapeIdentifier(ns.name);
      buf.writeln('  late final ${_capitalize(ns.name)}Api $ident;');
    }
    buf.writeln();
    final hasDefault = servers.isNotEmpty;
    final defaultExpr =
        hasDefault ? 'Servers.${_escapeIdentifier(servers.first.name)}' : null;
    if (hasDefault) {
      buf.writeln('  Blocks({String? baseUrl, SessionStore? sessionStore}) {');
      buf.writeln(
          '    final client = BlocksClient(baseUrl: baseUrl ?? $defaultExpr, sessionStore: sessionStore);');
    } else {
      buf.writeln(
          '  Blocks({required String baseUrl, SessionStore? sessionStore}) {');
      buf.writeln(
          '    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);');
    }
    for (final ns in namespaces) {
      final ident = _escapeIdentifier(ns.name);
      buf.writeln('    $ident = ${_capitalize(ns.name)}Api(client);');
    }
    buf.writeln('  }');
    buf.writeln('}');
    return buf.toString();
  }

  // --- Constraint helpers ---

  Constraints? _getConstraints(ResolvedType type) {
    return switch (type) {
      PrimitiveType(constraints: final c) => c,
      ListType(constraints: final c) => c,
      NullableType(inner: final inner) => _getConstraints(inner),
      _ => null,
    };
  }

  List<String> _buildValidations(String ident, Constraints c, bool optional) {
    final stmts = <String>[];
    if (c.format != null) {
      switch (c.format) {
        case 'uri':
          final cond = optional
              ? "$ident == null || (Uri.tryParse($ident)?.hasScheme ?? false)"
              : "(Uri.tryParse($ident)?.hasScheme ?? false)";
          stmts.add(
              "if (!($cond)) throw ArgumentError('$ident must be a valid URI');");
        case 'email':
          final cond = optional
              ? "$ident == null || $ident.contains('@')"
              : "$ident.contains('@')";
          stmts.add(
              "if (!($cond)) throw ArgumentError('$ident must be a valid email');");
      }
    }
    if (c.minLength != null) {
      final cond = optional
          ? '$ident == null || $ident.length >= ${c.minLength}'
          : '$ident.length >= ${c.minLength}';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must be at least ${c.minLength} characters');");
    }
    if (c.maxLength != null) {
      final cond = optional
          ? '$ident == null || $ident.length <= ${c.maxLength}'
          : '$ident.length <= ${c.maxLength}';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must be at most ${c.maxLength} characters');");
    }
    if (c.pattern != null) {
      final cond = optional
          ? "$ident == null || RegExp(r'${c.pattern}').hasMatch($ident)"
          : "RegExp(r'${c.pattern}').hasMatch($ident)";
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must match pattern');");
    }
    if (c.minimum != null) {
      final cond = optional
          ? '$ident == null || $ident >= ${c.minimum}'
          : '$ident >= ${c.minimum}';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must be >= ${c.minimum}');");
    }
    if (c.maximum != null) {
      final cond = optional
          ? '$ident == null || $ident <= ${c.maximum}'
          : '$ident <= ${c.maximum}';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must be <= ${c.maximum}');");
    }
    if (c.exclusiveMinimum != null) {
      final cond = optional
          ? '$ident == null || $ident > ${c.exclusiveMinimum}'
          : '$ident > ${c.exclusiveMinimum}';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must be > ${c.exclusiveMinimum}');");
    }
    if (c.exclusiveMaximum != null) {
      final cond = optional
          ? '$ident == null || $ident < ${c.exclusiveMaximum}'
          : '$ident < ${c.exclusiveMaximum}';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must be < ${c.exclusiveMaximum}');");
    }
    if (c.multipleOf != null) {
      final cond = optional
          ? '$ident == null || $ident % ${c.multipleOf} == 0'
          : '$ident % ${c.multipleOf} == 0';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must be a multiple of ${c.multipleOf}');");
    }
    if (c.minItems != null) {
      final cond = optional
          ? '$ident == null || $ident.length >= ${c.minItems}'
          : '$ident.length >= ${c.minItems}';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must have at least ${c.minItems} items');");
    }
    if (c.maxItems != null) {
      final cond = optional
          ? '$ident == null || $ident.length <= ${c.maxItems}'
          : '$ident.length <= ${c.maxItems}';
      stmts.add(
          "if (!($cond)) throw ArgumentError('$ident must have at most ${c.maxItems} items');");
    }
    return stmts;
  }

  // --- Type string helpers ---

  String _dartTypeStr(ResolvedType type, Map<String, ResolvedType> allTypes) {
    return switch (type) {
      PrimitiveType(dartType: final dt) => dt,
      NullableType(inner: final inner) => '${_dartTypeStr(inner, allTypes)}?',
      ListType(items: final items) => 'List<${_dartTypeStr(items, allTypes)}>',
      MapType(valueType: final vt) =>
        'Map<String, ${_dartTypeStr(vt, allTypes)}>',
      RecordType(name: final name) => name,
      EnumType(name: final name) => name,
      SealedClassType(name: final name) => name,
      SchemaReference(name: final name) => name,
      TransferableType(blocksType: final kt, typeArgs: final args) =>
        _transferableDartType(kt, args, allTypes),
      TupleType(items: final items) =>
        '(${items.map((i) => _dartTypeStr(i, allTypes)).join(', ')})',
    };
  }

  String _transferableDartType(String blocksType, List<ResolvedType> typeArgs,
      Map<String, ResolvedType> allTypes) {
    return switch (blocksType) {
      'realtime/channel' =>
        'RealtimeChannel<${typeArgs.isNotEmpty ? _dartTypeStr(typeArgs[0], allTypes) : 'dynamic'}>',
      'file-bucket/download' => 'FileDownloadHandle',
      'file-bucket/upload' => 'FileUploadHandle',
      'oidc/client' => 'OidcClient',
      _ => 'dynamic',
    };
  }

  // --- fromJson expression helpers ---

  String _fromJsonExpr(String accessor, ResolvedType type,
      Map<String, ResolvedType> allTypes, bool optional) {
    return switch (type) {
      PrimitiveType(dartType: final dt) =>
        _primitiveFromJson(accessor, dt, optional),
      NullableType(inner: final inner) =>
        _nullableFromJson(accessor, inner, allTypes),
      ListType(items: final items) =>
        _listFromJson(accessor, items, allTypes, optional),
      MapType(valueType: final vt) =>
        _mapFromJson(accessor, vt, allTypes, optional),
      RecordType(name: final name) => optional
          ? '$accessor != null ? $name.fromJson($accessor as Map<String, dynamic>) : null'
          : '$name.fromJson($accessor as Map<String, dynamic>)',
      SchemaReference(name: final name) =>
        _schemaFromJson(accessor, name, allTypes, optional),
      EnumType(name: final name) => optional
          ? '$accessor != null ? $name.fromJson($accessor as String) : null'
          : '$name.fromJson($accessor as String)',
      SealedClassType(name: final name) => optional
          ? '$accessor != null ? $name.fromJson($accessor as Map<String, dynamic>) : null'
          : '$name.fromJson($accessor as Map<String, dynamic>)',
      TupleType(items: final items) => optional
          ? '$accessor != null ? ${_tupleFromJson(accessor, items, allTypes)} : null'
          : _tupleFromJson(accessor, items, allTypes),
      _ => accessor,
    };
  }

  String _primitiveFromJson(String accessor, String dartType, bool optional) {
    if (dartType == 'int') {
      return optional
          ? '($accessor as num?)?.toInt()'
          : '($accessor as num).toInt()';
    }
    return '$accessor as $dartType${optional ? '?' : ''}';
  }

  String _nullableFromJson(
      String accessor, ResolvedType inner, Map<String, ResolvedType> allTypes) {
    return switch (inner) {
      SchemaReference(name: final name) =>
        '$accessor != null ? ${_resolvedClassName(name, allTypes)}.fromJson($accessor as Map<String, dynamic>) : null',
      RecordType(name: final name) =>
        '$accessor != null ? $name.fromJson($accessor as Map<String, dynamic>) : null',
      PrimitiveType(dartType: final dt) => '$accessor as $dt?',
      EnumType(name: final name) =>
        '$accessor != null ? $name.fromJson($accessor as String) : null',
      _ => _fromJsonExpr(accessor, inner, allTypes, true),
    };
  }

  String _listFromJson(String accessor, ResolvedType items,
      Map<String, ResolvedType> allTypes, bool optional) {
    final itemExpr = switch (items) {
      RecordType(name: final name) =>
        '(e) => $name.fromJson(e as Map<String, dynamic>)',
      SchemaReference(name: final name) =>
        '(e) => ${_resolvedClassName(name, allTypes)}.fromJson(e as Map<String, dynamic>)',
      PrimitiveType(dartType: final dt) =>
        dt == 'int' ? '(e) => (e as num).toInt()' : null,
      _ => null,
    };
    if (itemExpr != null) {
      if (optional) {
        return '($accessor as List<dynamic>?)?.map($itemExpr).toList()';
      }
      return '($accessor as List<dynamic>).map($itemExpr).toList()';
    }
    final typeStr = _dartTypeStr(items, allTypes);
    if (optional) {
      return '($accessor as List<dynamic>?)?.cast<$typeStr>()';
    }
    return '($accessor as List<dynamic>).cast<$typeStr>()';
  }

  String _mapFromJson(String accessor, ResolvedType valueType,
      Map<String, ResolvedType> allTypes, bool optional) {
    final valTypeStr = _dartTypeStr(valueType, allTypes);
    if (optional) {
      return '($accessor as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, v as $valTypeStr))';
    }
    return '($accessor as Map<String, dynamic>).map((k, v) => MapEntry(k, v as $valTypeStr))';
  }

  String _schemaFromJson(String accessor, String name,
      Map<String, ResolvedType> allTypes, bool optional) {
    final resolved = allTypes[name];
    if (resolved is EnumType) {
      return optional
          ? '$accessor != null ? $name.fromJson($accessor as String) : null'
          : '$name.fromJson($accessor as String)';
    }
    if (optional) {
      return '$accessor != null ? $name.fromJson($accessor as Map<String, dynamic>) : null';
    }
    return '$name.fromJson($accessor as Map<String, dynamic>)';
  }

  String _resolvedClassName(String name, Map<String, ResolvedType> allTypes) {
    return name; // Schema names are used directly as class names
  }

  // --- toJson expression helpers ---

  String _toJsonExpr(String field, ResolvedType type,
      Map<String, ResolvedType> allTypes, bool optional) {
    return switch (type) {
      PrimitiveType() => field,
      NullableType(inner: final inner) =>
        _toJsonExpr(field, inner, allTypes, true),
      ListType(items: final items) =>
        _listToJson(field, items, allTypes, optional),
      MapType() => field,
      RecordType() => optional ? '$field?.toJson()' : '$field.toJson()',
      SchemaReference(name: final name) =>
        _schemaToJson(field, name, allTypes, optional),
      EnumType() => optional ? '$field?.toJson()' : '$field.toJson()',
      SealedClassType() => optional ? '$field?.toJson()' : '$field.toJson()',
      TupleType(items: final items) => _tupleToJson(field, items, allTypes),
      _ => field,
    };
  }

  String _listToJson(String field, ResolvedType items,
      Map<String, ResolvedType> allTypes, bool optional) {
    final needsMap = items is RecordType ||
        items is SchemaReference ||
        items is SealedClassType;
    if (needsMap) {
      return optional
          ? '$field?.map((e) => e.toJson()).toList()'
          : '$field.map((e) => e.toJson()).toList()';
    }
    return field;
  }

  String _schemaToJson(String field, String name,
      Map<String, ResolvedType> allTypes, bool optional) {
    final resolved = allTypes[name];
    if (resolved is PrimitiveType) return field;
    return optional ? '$field?.toJson()' : '$field.toJson()';
  }

  // --- Param serialization ---

  String _paramToJsonExpr(
      String name, ResolvedType type, Map<String, ResolvedType> allTypes) {
    return switch (type) {
      RecordType() => '$name.toJson()',
      SealedClassType() => '$name.toJson()',
      SchemaReference(name: final schemaName) =>
        _needsTransformForSchema(schemaName, allTypes)
            ? '$name.toJson()'
            : name,
      EnumType() => '$name.toJson()',
      TupleType(items: final items) => _tupleToJson(name, items, allTypes),
      _ => name,
    };
  }

  bool _needsTransform(ResolvedType type, Map<String, ResolvedType> allTypes) {
    return switch (type) {
      RecordType() => true,
      SealedClassType() => true,
      EnumType() => true,
      TupleType() => true,
      SchemaReference(name: final name) =>
        _needsTransformForSchema(name, allTypes),
      _ => false,
    };
  }

  bool _needsTransformForSchema(
      String name, Map<String, ResolvedType> allTypes) {
    final resolved = allTypes[name];
    return resolved is RecordType ||
        resolved is SealedClassType ||
        resolved is EnumType;
  }

  // --- Deserialization for return types ---

  String _deserializeExpr(
      String accessor, ResolvedType type, Map<String, ResolvedType> allTypes) {
    return switch (type) {
      PrimitiveType(dartType: final dt) => dt == 'int' ? '($accessor as num).toInt()' : '$accessor as $dt',
      NullableType(inner: final inner) => _deserializeNullable(accessor, inner, allTypes),
      ListType(items: final items) => _deserializeList(accessor, items, allTypes),
      MapType(valueType: final vt) => '($accessor as Map<String, dynamic>).map((k, v) => MapEntry(k, ${_mapValueFromJson('v', vt, allTypes)}))',
      RecordType(name: final name) => '$name.fromJson($accessor as Map<String, dynamic>)',
      SchemaReference(name: final name) => _deserializeSchema(accessor, name, allTypes),
      SealedClassType(name: final name) => '$name.fromJson($accessor as Map<String, dynamic>)',
      EnumType(name: final name) => '$name.fromJson($accessor as String)',
      TransferableType(blocksType: final kt, typeArgs: final args) =>
        _deserializeTransferable(accessor, kt, args, allTypes),
      TupleType(items: final items) =>
        _tupleFromJson(accessor, items, allTypes),
    };
  }

  String _deserializeNullable(
      String accessor, ResolvedType inner, Map<String, ResolvedType> allTypes) {
    return switch (inner) {
      PrimitiveType(dartType: final dt) => '$accessor as $dt?',
      RecordType(name: final name) =>
        '$accessor == null ? null : $name.fromJson($accessor as Map<String, dynamic>)',
      SchemaReference(name: final name) =>
        '$accessor == null ? null : $name.fromJson($accessor as Map<String, dynamic>)',
      SealedClassType(name: final name) =>
        '$accessor == null ? null : $name.fromJson($accessor as Map<String, dynamic>)',
      _ => '$accessor',
    };
  }

  /// Per-value deserialization for a `Map<String, V>` entry value `v` (dynamic).
  /// Primitive value types keep the plain `v as T` cast (byte-identical to the
  /// prior output); object-like value types (records, sealed classes) — and the
  /// nullable variants thereof — are decoded via their generated `fromJson`.
  String _mapValueFromJson(String v, ResolvedType valueType, Map<String, ResolvedType> allTypes) {
    switch (valueType) {
      case SealedClassType(name: final n):
        return '$n.fromJson($v as Map<String, dynamic>)';
      case RecordType(name: final n):
        return '$n.fromJson($v as Map<String, dynamic>)';
      case SchemaReference(name: final n):
        final resolved = allTypes[n];
        if (resolved is RecordType || resolved is SealedClassType) {
          return '$n.fromJson($v as Map<String, dynamic>)';
        }
        if (resolved is EnumType) {
          return '$n.fromJson($v as String)';
        }
        return '$v as $n';
      case NullableType(inner: final inner):
        final innerName = switch (inner) {
          SealedClassType(name: final n) => n,
          RecordType(name: final n) => n,
          SchemaReference(name: final n)
              when allTypes[n] is RecordType || allTypes[n] is SealedClassType =>
            n,
          _ => null,
        };
        if (innerName != null) {
          return '$v == null ? null : $innerName.fromJson($v as Map<String, dynamic>)';
        }
        return '$v as ${_dartTypeStr(valueType, allTypes)}';
      default:
        return '$v as ${_dartTypeStr(valueType, allTypes)}';
    }
  }

  String _deserializeList(String accessor, ResolvedType items, Map<String, ResolvedType> allTypes) {
    final itemExpr = switch (items) {
      RecordType(name: final name) =>
        '(e) => $name.fromJson(e as Map<String, dynamic>)',
      SchemaReference(name: final name) =>
        '(e) => $name.fromJson(e as Map<String, dynamic>)',
      _ => null,
    };
    if (itemExpr != null) {
      return '($accessor as List<dynamic>).map($itemExpr).toList()';
    }
    final typeStr = _dartTypeStr(items, allTypes);
    return '($accessor as List<dynamic>).cast<$typeStr>()';
  }

  String _deserializeSchema(
      String accessor, String name, Map<String, ResolvedType> allTypes) {
    final resolved = allTypes[name];
    if (resolved is EnumType) return '$name.fromJson($accessor as String)';
    return '$name.fromJson($accessor as Map<String, dynamic>)';
  }

  String _deserializeTransferable(String accessor, String blocksType,
      List<ResolvedType> typeArgs, Map<String, ResolvedType> allTypes) {
    final cast = '$accessor as Map<String, dynamic>';
    return switch (blocksType) {
      'realtime/channel' => () {
          if (typeArgs.isEmpty)
            return 'RealtimeChannel.fromJson($cast, (json) => json)';
          final argType = _dartTypeStr(typeArgs[0], allTypes);
          return 'RealtimeChannel.fromJson($cast, (json) => $argType.fromJson(json))';
        }(),
      'file-bucket/download' => 'FileDownloadHandle.fromJson($cast)',
      'file-bucket/upload' => 'FileUploadHandle.fromJson($cast)',
      'oidc/client' =>
        'OidcClient.fromJson($cast, baseUrl: _client.baseUrl, tokenStore: _client.tokenStore, sessionStore: _client.sessionStore)',
      _ => accessor,
    };
  }

  String _tupleFromJson(String expr, List<ResolvedType> items,
      Map<String, ResolvedType> allTypes) {
    final cast = '($expr as List<dynamic>)';
    final fields = items.asMap().entries.map((e) {
      return _fromJsonExpr('$cast[${e.key}]', e.value, allTypes, false);
    }).join(', ');
    return '($fields)';
  }

  String _tupleToJson(String expr, List<ResolvedType> items,
      Map<String, ResolvedType> allTypes) {
    final fields = items.asMap().entries.map((e) {
      return _toJsonExpr('$expr.\$${e.key + 1}', e.value, allTypes, false);
    }).join(', ');
    return '[$fields]';
  }

  /// Emits ==, hashCode, and toString overrides for a data class.
  void _emitEquality(StringBuffer buf, String className, List<String> fields) {
    // == operator
    buf.writeln();
    buf.writeln('  @override');
    buf.writeln('  bool operator ==(Object other) =>');
    buf.writeln('      identical(this, other) ||');
    if (fields.isEmpty) {
      buf.writeln('      other is $className;');
    } else {
      buf.write('      other is $className');
      for (final f in fields) {
        buf.writeln(' &&');
        buf.write('          $f == other.$f');
      }
      buf.writeln(';');
    }

    // hashCode
    buf.writeln();
    buf.writeln('  @override');
    if (fields.isEmpty) {
      buf.writeln('  int get hashCode => runtimeType.hashCode;');
    } else if (fields.length == 1) {
      buf.writeln('  int get hashCode => ${fields.first}.hashCode;');
    } else if (fields.length <= 20) {
      buf.writeln('  int get hashCode => Object.hash(${fields.join(', ')});');
    } else {
      buf.writeln(
          '  int get hashCode => Object.hashAll([${fields.join(', ')}]);');
    }

    // toString
    buf.writeln();
    buf.writeln('  @override');
    final props = fields.map((f) {
      // Reserved-word fields are escaped with a trailing '$' (e.g. `required$`).
      // A bare '$' in the string literal/interpolation is misparsed by Dart, so
      // such identifiers need a '$'-escaped label and brace interpolation.
      // Normal identifiers keep the terse `$field` form (no golden churn).
      if (f.contains(r'$')) {
        final label = f.replaceAll(r'$', r'\$');
        return '$label: \${$f}';
      }
      return '$f: \$$f';
    }).join(', ');
    buf.writeln("  String toString() => '$className($props)';");
  }

  static const _dartKeywords = {
    'abstract',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'covariant',
    'default',
    'deferred',
    'do',
    'dynamic',
    'else',
    'enum',
    'export',
    'extends',
    'extension',
    'external',
    'factory',
    'false',
    'final',
    'finally',
    'for',
    'Function',
    'get',
    'hide',
    'if',
    'implements',
    'import',
    'in',
    'interface',
    'is',
    'late',
    'library',
    'mixin',
    'new',
    'null',
    'on',
    'operator',
    'part',
    'required',
    'rethrow',
    'return',
    'sealed',
    'set',
    'show',
    'static',
    'super',
    'switch',
    'sync',
    'this',
    'throw',
    'true',
    'try',
    'typedef',
    'var',
    'void',
    'while',
    'with',
    'yield',
  };

  String _escapeIdentifier(String name) =>
      _dartKeywords.contains(name) ? '$name\$' : name;

  String _capitalize(String s) =>
      s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

  /// Collects all type names referenced by a resolved type (for usage tracking).
  Set<String> _collectTypeRefs(ResolvedType type) {
    return switch (type) {
      RecordType(name: final n) => {n},
      EnumType(name: final n) => {n},
      SealedClassType(name: final n) => {n},
      SchemaReference(name: final n) => {n},
      NullableType(inner: final i) => _collectTypeRefs(i),
      ListType(items: final i) => _collectTypeRefs(i),
      MapType(valueType: final v) => _collectTypeRefs(v),
      TupleType(items: final items) => items.expand(_collectTypeRefs).toSet(),
      _ => {},
    };
  }
}
