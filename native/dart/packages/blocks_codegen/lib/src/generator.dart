import 'builder.dart';
import 'identifiers.dart';
import 'model.dart';

/// Generates Dart source code from a [CodegenModel].
class DartCodeGenerator {
  const DartCodeGenerator();

  /// Emits the complete contents of one generated `.blocks.dart` library.
  ///
  /// Output is deterministic for a given [model], so it is safe to check in
  /// and diff.
  String generate(CodegenModel model) {
    final buf = StringBuffer();
    buf.writeln('// GENERATED CODE — DO NOT MODIFY BY HAND');
    buf.writeln('// Generator: blocks-codegen');
    buf.writeln(
      '// Source: ${_commentText(model.title)} v${_commentText(model.version)}',
    );
    buf.writeln('// ignore_for_file: constant_identifier_names');
    buf.writeln();
    buf.writeln("import 'package:blocks_runtime/blocks_runtime.dart';");
    buf.writeln(
      "export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;",
    );

    // Export transferable types for consumer convenience. A transferable
    // counts wherever it appears — a top-level type, an operation result or
    // parameter, or nested in a model, list, map, nullable or tuple — so a
    // client can always name the types its models and operations use.
    final transferableTags = _collectTransferableTags(model);
    if (transferableTags.isNotEmpty) {
      buf.writeln(
        "export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;",
      );
    }

    if (transferableTags.contains('oidc/client')) {
      buf.writeln(
        "export 'package:blocks_runtime/blocks_runtime.dart' show OidcClient, OidcAuthState, OidcSignedIn, OidcSignedOut, OidcLoading, OidcUser, TokenStore, InMemoryTokenStore, AuthProvider, BrowserLauncher, ProviderConfig;",
      );
    }

    // Re-export UnknownTransferable for unbound top-level types and operation
    // results.
    final hasUnknownTransferable =
        model.types.values.any(_isUnboundTransferable) ||
        model.namespaces.any(
          (ns) => ns.operations.any((op) => _isUnboundTransferable(op.result)),
        );
    if (hasUnknownTransferable) {
      buf.writeln(
        "export 'package:blocks_runtime/blocks_runtime.dart' show UnknownTransferable;",
      );
    }
    buf.writeln();

    // Collect all types to emit
    final emittedTypes = <String>{};
    final apiClasses = _apiClassNames(model);
    final declared = _declaredNames(model, apiClasses);

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
      if (!schemaTypes.contains(entry.key) &&
          typeUsage.containsKey(entry.key)) {
        continue;
      }
      final code = _emitType(entry.value, model.types, emittedTypes, declared);
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
          .where(
            (e) =>
                !emittedTypes.contains(e.key) &&
                typeUsage[e.key]?.length == 1 &&
                typeUsage[e.key]?.first == ns.name,
          )
          .toList();
      for (final entry in nsTypes) {
        final code = _emitType(
          entry.value,
          model.types,
          emittedTypes,
          declared,
        );
        if (code.isNotEmpty) {
          buf.writeln(code);
          buf.writeln();
        }
      }
      buf.writeln(
        _emitNamespace(ns, apiClasses[ns.name]!, model.types, declared),
      );
      buf.writeln();
    }

    // Emit Servers class if servers are defined
    if (model.servers.isNotEmpty) {
      buf.writeln(_emitServers(model.servers, declared));
      buf.writeln();
    }

    // Emit Blocks facade
    buf.writeln(
      _emitBlocksFacade(model.namespaces, apiClasses, model.servers, declared),
    );

    return buf.toString();
  }

  String _emitType(
    ResolvedType type,
    Map<String, ResolvedType> allTypes,
    Set<String> emitted,
    Set<String> declared,
  ) {
    return switch (type) {
      RecordType() => _emitRecord(type, allTypes, emitted, declared),
      EnumType() => _emitEnum(type, emitted, declared),
      SealedClassType() => _emitSealedClass(type, allTypes, emitted, declared),
      _ => '',
    };
  }

  String _emitRecord(
    RecordType record,
    Map<String, ResolvedType> allTypes,
    Set<String> emitted,
    Set<String> declared,
  ) {
    if (emitted.contains(record.name)) return '';
    emitted.add(record.name);
    final buf = StringBuffer();
    final hasAdditional = record.additionalProperties != null;
    final ids = _identifiers(
      record.fields.map((f) => f.name),
      reserved: {..._modelMembers, if (hasAdditional) 'additionalProperties'},
      declared: declared,
    );

    // Collect validation checks for constrained fields. A nullable field (an
    // optional one, or a required `T | null`) can't be promoted by an inline
    // null check — it's a public field, not a local — so its checks run on a
    // non-null local bound by `if (x case final x?)`, like Swift's `if let`.
    final validations = <String>[];
    for (final f in record.fields) {
      final constraints = _getConstraints(_unalias(f.type, allTypes));
      if (constraints == null) continue;
      final ident = ids[f.name]!;
      final stmts = _buildValidations(ident, constraints);
      if (stmts.isEmpty) continue;
      if (f.isRequired && _unalias(f.type, allTypes) is! NullableType) {
        validations.addAll(stmts);
      } else {
        validations
          ..add('if ($ident case final $ident?) {')
          ..addAll(stmts.map((v) => '  $v'))
          ..add('}');
      }
    }
    final hasValidations = validations.isNotEmpty;

    buf.writeln('class ${record.name} {');
    // Fields
    for (final f in record.fields) {
      final typeStr = _dartTypeStr(f.type, allTypes);
      final ident = ids[f.name]!;
      buf.writeln(
        '  final ${f.isRequired ? typeStr : _orNull(typeStr)} $ident;',
      );
    }
    if (hasAdditional) {
      _writeExtrasField(buf, record.additionalProperties!, allTypes);
    }
    buf.writeln();

    // Constructor (drop const if we have validations)
    buf.writeln('  ${hasValidations ? '' : 'const '}${record.name}({');
    for (final f in record.fields) {
      final ident = ids[f.name]!;
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

    // fromJson. A model holding an `oidc/client` (at any depth) also takes the
    // calling client, whose base URL and stores the `OidcClient` needs.
    final needsClient = _needsClient(record, allTypes);
    final scope = _DecodeScope(allTypes, client: needsClient ? 'client' : null);
    buf.writeln(
      '  factory ${record.name}.fromJson(${_fromJsonParams(needsClient)}) {',
    );
    final ownKeys = [for (final f in record.fields) f.name];
    if (hasAdditional) _writeExtrasKnownKeys(buf, ownKeys);
    buf.writeln('    return ${record.name}(');
    for (final f in record.fields) {
      final ident = ids[f.name]!;
      buf.writeln(
        '      $ident: ${_fromJsonExpr(_jsonKey(f.name), f.type, scope, !f.isRequired)},',
      );
    }
    if (hasAdditional) {
      _writeExtrasDecode(buf, record.additionalProperties!, scope);
    }
    buf.writeln('    );');
    buf.writeln('  }');
    buf.writeln();

    // toJson
    buf.writeln('  Map<String, dynamic> toJson() {');
    buf.writeln('    return {');
    for (final f in record.fields) {
      final ident = ids[f.name]!;
      final expr = _toJsonExpr(ident, f.type, scope, !f.isRequired);
      final key = _dartStringLiteral(f.name);
      if (f.isRequired) {
        buf.writeln('      $key: $expr,');
      } else {
        buf.writeln('      if ($ident != null) $key: $expr,');
      }
    }
    if (hasAdditional) {
      _writeExtrasEncode(buf, record.additionalProperties!, ownKeys, scope);
    }
    buf.writeln('    };');
    buf.writeln('  }');

    // == / hashCode / toString
    final allFields = [
      for (final f in record.fields)
        (ids[f.name]!, _comparesDeeply(f.type, allTypes)),
      if (hasAdditional) ('additionalProperties', true),
    ];
    _emitEquality(buf, record.name, allFields);

    buf.writeln('}');
    return buf.toString();
  }

  String _emitEnum(
    EnumType enumType,
    Set<String> emitted,
    Set<String> declared,
  ) {
    if (emitted.contains(enumType.name)) return '';
    emitted.add(enumType.name);
    final buf = StringBuffer();
    final ids = _identifiers(
      enumType.values,
      reserved: _enumMembers,
      declared: declared,
    );
    final sanitized = [for (final v in enumType.values) ids[v]!];
    // `name` and `values.byName` map a value to its JSON only while every
    // identifier is the value itself.
    final needsMap = enumType.values.any((v) => v != ids[v]);
    buf.writeln('enum ${enumType.name} {');
    buf.writeln(sanitized.map((v) => '  $v').join(',\n'));
    buf.writeln(';');
    buf.writeln();
    if (needsMap) {
      buf.writeln('  static const _jsonMap = <String, ${enumType.name}>{');
      for (var i = 0; i < enumType.values.length; i++) {
        buf.writeln(
          '    ${_dartStringLiteral(enumType.values[i])}: ${sanitized[i]},',
        );
      }
      buf.writeln('  };');
      buf.writeln('  static const _toJsonMap = <${enumType.name}, String>{');
      for (var i = 0; i < enumType.values.length; i++) {
        buf.writeln(
          '    ${sanitized[i]}: ${_dartStringLiteral(enumType.values[i])},',
        );
      }
      buf.writeln('  };');
      buf.writeln('  String toJson() => _toJsonMap[this]!;');
      buf.writeln(
        '  static ${enumType.name} fromJson(String json) => _jsonMap[json]!;',
      );
    } else {
      buf.writeln('  String toJson() => name;');
      buf.writeln(
        '  static ${enumType.name} fromJson(String json) => values.byName(json);',
      );
    }
    buf.writeln('}');
    return buf.toString();
  }

  String _emitSealedClass(
    SealedClassType sealed,
    Map<String, ResolvedType> allTypes,
    Set<String> emitted,
    Set<String> declared,
  ) {
    if (emitted.contains(sealed.name)) return '';
    emitted.add(sealed.name);
    final buf = StringBuffer();

    // Base sealed class
    // A union holding an `oidc/client` in any variant passes the calling
    // client to every variant's `fromJson`.
    final needsClient = _needsClient(sealed, allTypes);
    final clientArg = needsClient ? ', client' : '';
    final scope = _DecodeScope(allTypes, client: needsClient ? 'client' : null);
    buf.writeln('sealed class ${sealed.name} {');
    buf.writeln('  const ${sealed.name}();');
    buf.writeln('  Map<String, dynamic> toJson();');
    buf.writeln(
      '  static ${sealed.name} fromJson(${_fromJsonParams(needsClient)}) {',
    );
    if (sealed.discriminantIsBoolean) {
      // Boolean discriminant: switch on the real bool; case labels and the
      // serialized value are unquoted true/false literals. true/false are
      // exhaustive for a bool, so no (unreachable) default clause is emitted.
      buf.writeln('    switch (${_jsonKey(sealed.discriminant)} as bool) {');
      for (final v in sealed.variants) {
        buf.writeln(
          "      case ${v.discriminantValue}: return ${v.className}.fromJson(json$clientArg);",
        );
      }
      buf.writeln('    }');
    } else {
      final discriminant = _jsonKey(sealed.discriminant);
      buf.writeln('    switch ($discriminant as String) {');
      for (final v in sealed.variants) {
        buf.writeln(
          '      case ${_dartStringLiteral(v.discriminantValue)}: return ${v.className}.fromJson(json$clientArg);',
        );
      }
      buf.writeln(
        "      default: throw ArgumentError('Unknown ${_escapeStringContent(sealed.discriminant)}: \${$discriminant}');",
      );
      buf.writeln('    }');
    }
    buf.writeln('  }');
    buf.writeln('}');
    buf.writeln();

    // Variant subclasses
    for (final v in sealed.variants) {
      // Emit embedded union sealed class if present
      if (v.embeddedUnion != null) {
        buf.writeln(
          _emitSealedClass(v.embeddedUnion!, allTypes, emitted, declared),
        );
        buf.writeln();
      }
      final embedded = v.embeddedUnion;
      final extras = v.additionalProperties;
      final ids = _identifiers(
        [for (final f in v.fields) f.name, ?embedded?.discriminant],
        reserved: {
          ..._modelMembers,
          if (extras != null) 'additionalProperties',
        },
        declared: declared,
      );
      final embeddedIdent = embedded == null
          ? null
          : ids[embedded.discriminant];

      buf.writeln('class ${v.className} extends ${sealed.name} {');
      for (final f in v.fields) {
        final typeStr = _dartTypeStr(f.type, allTypes);
        final ident = ids[f.name]!;
        buf.writeln(
          '  final ${f.isRequired ? typeStr : _orNull(typeStr)} $ident;',
        );
      }
      if (v.embeddedUnion != null) {
        buf.writeln('  final ${v.embeddedUnion!.name} $embeddedIdent;');
      }
      if (extras != null) _writeExtrasField(buf, extras, allTypes);
      buf.writeln();

      if (v.fields.isEmpty && v.embeddedUnion == null && extras == null) {
        buf.writeln('  const ${v.className}();');
      } else {
        buf.writeln('  const ${v.className}({');
        for (final f in v.fields) {
          final ident = ids[f.name]!;
          buf.writeln('    ${f.isRequired ? 'required ' : ''}this.$ident,');
        }
        if (v.embeddedUnion != null) {
          buf.writeln('    required this.$embeddedIdent,');
        }
        if (extras != null) {
          buf.writeln('    this.additionalProperties = const {},');
        }
        buf.writeln('  });');
      }
      buf.writeln();

      // An open variant's extra keys are every key of its JSON object that
      // isn't one of its own: the discriminator, its properties, an embedded
      // union's keys, and an enclosing hybrid arm's.
      final ownKeys = {
        sealed.discriminant,
        for (final f in v.fields) f.name,
        if (v.embeddedUnion != null) ..._unionKeys(v.embeddedUnion!),
        ...sealed.enclosingKeys,
      };

      // fromJson
      buf.writeln(
        '  factory ${v.className}.fromJson(${_fromJsonParams(needsClient)}) {',
      );
      if (extras != null) _writeExtrasKnownKeys(buf, ownKeys);
      buf.writeln('    return ${v.className}(');
      for (final f in v.fields) {
        final ident = ids[f.name]!;
        buf.writeln(
          '      $ident: ${_fromJsonExpr(_jsonKey(f.name), f.type, scope, !f.isRequired)},',
        );
      }
      if (v.embeddedUnion != null) {
        buf.writeln(
          "      $embeddedIdent: ${v.embeddedUnion!.name}.fromJson(json${_clientArg(v.embeddedUnion!, scope)}),",
        );
      }
      if (extras != null) _writeExtrasDecode(buf, extras, scope);
      buf.writeln('    );');
      buf.writeln('  }');
      buf.writeln();

      // toJson
      buf.writeln('  @override');
      buf.writeln('  Map<String, dynamic> toJson() {');
      buf.writeln('    return {');
      final discriminantKey = _dartStringLiteral(sealed.discriminant);
      if (sealed.discriminantIsBoolean) {
        buf.writeln('      $discriminantKey: ${v.discriminantValue},');
      } else {
        buf.writeln(
          '      $discriminantKey: ${_dartStringLiteral(v.discriminantValue)},',
        );
      }
      for (final f in v.fields) {
        final ident = ids[f.name]!;
        final expr = _toJsonExpr(ident, f.type, scope, !f.isRequired);
        final key = _dartStringLiteral(f.name);
        if (f.isRequired) {
          buf.writeln('      $key: $expr,');
        } else {
          buf.writeln('      if ($ident != null) $key: $expr,');
        }
      }
      if (v.embeddedUnion != null) {
        buf.writeln('      ...$embeddedIdent.toJson(),');
      }
      if (extras != null) _writeExtrasEncode(buf, extras, ownKeys, scope);
      buf.writeln('    };');
      buf.writeln('  }');

      // == / hashCode / toString
      final variantFields = [
        for (final f in v.fields)
          (ids[f.name]!, _comparesDeeply(f.type, allTypes)),
        if (embeddedIdent != null) (embeddedIdent, false),
        if (extras != null) ('additionalProperties', true),
      ];
      _emitEquality(buf, v.className, variantFields);

      buf.writeln('}');
      buf.writeln();
    }
    return buf.toString();
  }

  // --- Open records ---
  //
  // An open record (an object schema with `properties` and
  // `additionalProperties`, TS `T & Record<string, V>`) keeps its extra keys in
  // `additionalProperties`, flat beside its own keys on the wire: a top-level
  // or operation-scoped model ([_emitRecord]) and a union variant
  // ([_emitSealedClass]) alike. Decoding collects every key that isn't one of
  // the record's own; encoding writes each extra key that isn't, so a typed
  // property (or a variant's discriminator) always wins over an extra key of
  // the same name.

  /// The `additionalProperties` field of an open record whose extra values are
  /// [extras].
  void _writeExtrasField(
    StringBuffer buf,
    ResolvedType extras,
    Map<String, ResolvedType> allTypes,
  ) {
    buf.writeln(
      '  final Map<String, ${_dartTypeStr(extras, allTypes)}> additionalProperties;',
    );
  }

  /// `fromJson`'s set of the record's own keys, [ownKeys], which aren't extra.
  void _writeExtrasKnownKeys(StringBuffer buf, Iterable<String> ownKeys) {
    buf.writeln('    const knownKeys = ${_stringSetLiteral(ownKeys)};');
  }

  /// `fromJson`'s `additionalProperties:` argument: every key of `json` not in
  /// `knownKeys` (see [_writeExtrasKnownKeys]), its value decoded as [extras].
  void _writeExtrasDecode(
    StringBuffer buf,
    ResolvedType extras,
    _DecodeScope scope,
  ) {
    final valueType = _dartTypeStr(extras, scope.allTypes);
    final castExpr = valueType == 'dynamic'
        ? 'e.value'
        : _isCastSafe(_unalias(extras, scope.allTypes))
        ? 'e.value as $valueType'
        : _decode('e.value', extras, scope.deeper);
    buf.writeln('      additionalProperties: Map.fromEntries(');
    buf.writeln(
      '        json.entries.where((e) => !knownKeys.contains(e.key))',
    );
    buf.writeln('            .map((e) => MapEntry(e.key, $castExpr)),');
    buf.writeln('      ),');
  }

  /// `toJson`'s entries for the extra keys, flat, skipping any named like one
  /// of [ownKeys] (the typed value wins), each value encoded as [extras].
  void _writeExtrasEncode(
    StringBuffer buf,
    ResolvedType extras,
    Iterable<String> ownKeys,
    _DecodeScope scope,
  ) {
    final value = _encode('e.value', extras, scope.deeper);
    final ownKeySet = _stringSetLiteral(ownKeys);
    buf.writeln('      for (final e in additionalProperties.entries)');
    buf.writeln(
      '        if (!const $ownKeySet.contains(e.key)) e.key: $value,',
    );
  }

  /// Every key a union's variants read from the JSON object they share with an
  /// enclosing hybrid arm: the discriminator and each variant's properties, at
  /// any depth.
  Set<String> _unionKeys(SealedClassType union) => {
    union.discriminant,
    for (final v in union.variants) ...[
      for (final f in v.fields) f.name,
      if (v.embeddedUnion != null) ..._unionKeys(v.embeddedUnion!),
    ],
  };

  /// A Dart set literal of the strings [values], e.g. `{'a', 'b'}`.
  String _stringSetLiteral(Iterable<String> values) =>
      '{${values.map(_dartStringLiteral).join(', ')}}';

  String _emitNamespace(
    Namespace ns,
    String className,
    Map<String, ResolvedType> allTypes,
    Set<String> declared,
  ) {
    final buf = StringBuffer();
    final methodIds = _identifiers(
      ns.operations.map((op) => op.name),
      reserved: _objectMembers,
      declared: declared,
    );
    buf.writeln('class $className {');
    buf.writeln('  final BlocksClient _client;');
    buf.writeln('  $className(this._client);');

    for (final op in ns.operations) {
      buf.writeln();
      final unboundResult = _isUnboundTransferable(op.result)
          ? op.result as TransferableType
          : null;
      final returnType = unboundResult != null
          ? 'UnknownTransferable'
          : _dartTypeStr(op.result, allTypes);
      final isVoid = returnType == 'void';
      final asyncReturn = isVoid ? 'Future<void>' : 'Future<$returnType>';
      final methodName = methodIds[op.name]!;
      final ids = _identifiers(
        op.params.map((p) => p.name),
        declared: declared,
      );

      // The body's own locals (`params`, `result`) yield to a parameter of
      // the same name: the parameter is public API, the locals aren't.
      final paramIdents = ids.values.toSet();
      final paramsVar = _freeName('params', paramIdents);
      final resultVar = _freeName('result', paramIdents);

      // Build parameter signature
      final paramParts = <String>[];
      for (final p in op.params) {
        final typeStr = _dartTypeStr(p.type, allTypes);
        final ident = ids[p.name]!;
        if (p.isRequired) {
          paramParts.add('required $typeStr $ident');
        } else {
          paramParts.add('${_orNull(typeStr)} $ident');
        }
      }
      final paramSig = paramParts.isEmpty ? '' : '{${paramParts.join(', ')}}';

      buf.writeln('  $asyncReturn $methodName($paramSig) async {');

      // Build the params array. An AWS Blocks server reads params by
      // position (`parseRpcRequest` reads a by-name object by its values, in
      // order), so the arguments go in spec order, as the TypeScript client
      // sends them: an optional argument before the last required one keeps
      // its slot (`null` when unset); a trailing optional one is added when it
      // or any later one is set, so trailing unset ones are left off.
      if (op.params.isNotEmpty) {
        final lastRequired = op.params.lastIndexWhere((p) => p.isRequired);
        buf.writeln('    final $paramsVar = <dynamic>[');
        for (var i = 0; i < op.params.length; i++) {
          final p = op.params[i];
          final ident = ids[p.name]!;
          if (p.isRequired) {
            final valExpr = _paramToJsonExpr(ident, p.type, allTypes);
            buf.writeln('      $valExpr,');
          } else if (i < lastRequired) {
            final valExpr = _paramToJsonExpr(
              ident,
              p.type,
              allTypes,
              nullable: true,
            );
            buf.writeln('      $valExpr,');
          } else if (i == op.params.length - 1) {
            final valExpr = _paramToJsonExpr(
              ident,
              p.type,
              allTypes,
              promoted: true,
            );
            buf.writeln('      if ($ident != null) $valExpr,');
          } else {
            final valExpr = _paramToJsonExpr(
              ident,
              p.type,
              allTypes,
              nullable: true,
            );
            final setFromHere = [
              for (final later in op.params.skip(i))
                '${ids[later.name]!} != null',
            ].join(' || ');
            buf.writeln('      if ($setFromHere) $valExpr,');
          }
        }
        buf.writeln('    ];');
      }

      final paramsArg = op.params.isNotEmpty ? paramsVar : 'const <dynamic>[]';

      if (isVoid) {
        buf.writeln(
          '    await _client.call(${_dartStringLiteral(op.fullName)}, $paramsArg);',
        );
      } else {
        buf.writeln(
          '    final $resultVar = await _client.call(${_dartStringLiteral(op.fullName)}, $paramsArg);',
        );
        final deserExpr = unboundResult != null
            ? 'UnknownTransferable.fromJson($resultVar, expectedTag: '
                  '${_dartStringLiteral(unboundResult.blocksType)})'
            : _decode(
                resultVar,
                op.result,
                _DecodeScope(allTypes, client: '_client'),
              );
        buf.writeln('    return $deserExpr;');
      }
      buf.writeln('  }');
    }

    buf.writeln('}');
    return buf.toString();
  }

  String _emitServers(List<Server> servers, Set<String> declared) {
    final ids = _serverIdentifiers(servers, declared);
    final buf = StringBuffer();
    buf.writeln('// --- Servers ---');
    buf.writeln();
    buf.writeln('class Servers {');
    for (final server in servers) {
      final fieldName = ids[server.name]!;
      buf.writeln(
        '  static const String $fieldName = ${_dartStringLiteral(server.url)};',
      );
    }
    buf.writeln('}');
    return buf.toString();
  }

  String _emitBlocksFacade(
    List<Namespace> namespaces,
    Map<String, String> apiClasses,
    List<Server> servers,
    Set<String> declared,
  ) {
    final buf = StringBuffer();
    final ids = _identifiers(
      namespaces.map((ns) => ns.name),
      reserved: _objectMembers,
      declared: declared,
    );
    // A namespace's field is public API, and so are the constructor's
    // parameters: a field named like one is assigned through `this.`. The
    // `client` local isn't public, so it yields to a field of the same name.
    final fields = ids.values.toSet();
    final client = _freeName('client', fields);
    const ctorParams = {'baseUrl', 'sessionStore'};
    buf.writeln('// --- Blocks Client ---');
    buf.writeln();
    buf.writeln('class Blocks {');
    for (final ns in namespaces) {
      final ident = ids[ns.name]!;
      buf.writeln('  late final ${apiClasses[ns.name]} $ident;');
    }
    buf.writeln();
    final hasDefault = servers.isNotEmpty;
    final defaultExpr = hasDefault
        ? 'Servers.${_serverIdentifiers(servers, declared)[servers.first.name]}'
        : null;
    if (hasDefault) {
      buf.writeln('  Blocks({String? baseUrl, SessionStore? sessionStore}) {');
      buf.writeln(
        '    final $client = BlocksClient(baseUrl: baseUrl ?? $defaultExpr, sessionStore: sessionStore);',
      );
    } else {
      buf.writeln(
        '  Blocks({required String baseUrl, SessionStore? sessionStore}) {',
      );
      buf.writeln(
        '    final $client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);',
      );
    }
    for (final ns in namespaces) {
      final ident = ids[ns.name]!;
      final target = ctorParams.contains(ident) ? 'this.$ident' : ident;
      buf.writeln('    $target = ${apiClasses[ns.name]}($client);');
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

  /// Checks for [c] on [ident], which must hold a non-null value.
  List<String> _buildValidations(String ident, Constraints c) {
    final stmts = <String>[];
    // [ident] in a message: a keyword-escaped name (`class$`) would otherwise
    // read as an interpolation inside the string literal.
    final label = ident.replaceAll(r'$', r'\$');
    if (c.format != null) {
      switch (c.format) {
        case 'uri':
          final cond = '(Uri.tryParse($ident)?.hasScheme ?? false)';
          stmts.add(
            "if (!($cond)) throw ArgumentError('$label must be a valid URI');",
          );
        case 'email':
          final cond = "$ident.contains('@')";
          stmts.add(
            "if (!($cond)) throw ArgumentError('$label must be a valid email');",
          );
      }
    }
    if (c.minLength != null) {
      final cond = '$ident.length >= ${c.minLength}';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must be at least ${c.minLength} characters');",
      );
    }
    if (c.maxLength != null) {
      final cond = '$ident.length <= ${c.maxLength}';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must be at most ${c.maxLength} characters');",
      );
    }
    if (c.pattern != null) {
      final cond = 'RegExp(${_dartRegExpLiteral(c.pattern!)}).hasMatch($ident)';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must match pattern');",
      );
    }
    if (c.minimum != null) {
      final cond = '$ident >= ${c.minimum}';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must be >= ${c.minimum}');",
      );
    }
    if (c.maximum != null) {
      final cond = '$ident <= ${c.maximum}';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must be <= ${c.maximum}');",
      );
    }
    if (c.exclusiveMinimum != null) {
      final cond = '$ident > ${c.exclusiveMinimum}';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must be > ${c.exclusiveMinimum}');",
      );
    }
    if (c.exclusiveMaximum != null) {
      final cond = '$ident < ${c.exclusiveMaximum}';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must be < ${c.exclusiveMaximum}');",
      );
    }
    if (c.multipleOf != null) {
      final cond = '$ident % ${c.multipleOf} == 0';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must be a multiple of ${c.multipleOf}');",
      );
    }
    if (c.minItems != null) {
      final cond = '$ident.length >= ${c.minItems}';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must have at least ${c.minItems} items');",
      );
    }
    if (c.maxItems != null) {
      final cond = '$ident.length <= ${c.maxItems}';
      stmts.add(
        "if (!($cond)) throw ArgumentError('$label must have at most ${c.maxItems} items');",
      );
    }
    return stmts;
  }

  // --- Type string helpers ---

  /// [type] made nullable. `dynamic` (an `unknown` value) already admits null,
  /// so it stays `dynamic` — `dynamic?` trips `unnecessary_question_mark`.
  String _orNull(String type) =>
      type == 'dynamic' || type.endsWith('?') ? type : '$type?';

  String _dartTypeStr(ResolvedType type, Map<String, ResolvedType> allTypes) {
    return switch (_unalias(type, allTypes)) {
      PrimitiveType(dartType: final dt) => dt,
      NullableType(inner: final inner) => _orNull(
        _dartTypeStr(inner, allTypes),
      ),
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

  String _transferableDartType(
    String blocksType,
    List<ResolvedType> typeArgs,
    Map<String, ResolvedType> allTypes,
  ) {
    // Tags outside the registry stay dynamic even if a switch arm exists.
    if (!knownTransferableTags.contains(blocksType)) return 'dynamic';
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
  //
  // [_decode] is the one recursive decoder. Given an expression holding a JSON
  // value (`dynamic`), it builds the expression that turns it into the Dart
  // type of a [ResolvedType], descending through lists, maps, nullables and
  // tuples so that every element that needs converting — a model, an enum, a
  // transferable, a nested list or map — goes through its own decoder. A cast
  // is emitted only where the cast *is* the conversion: a primitive, or a
  // container of primitives (`.cast<T>()`, `v as T`). A bare cast to anything
  // else compiles but throws at runtime, since the value is a JSON map or
  // list, not the Dart type.
  //
  // [_fromJsonExpr] (model fields) wraps it and differs from [_decode] used
  // directly (operation results) only in spelling: an optional field reads
  // `x != null ? … : null`, and a field's own `List<int>` converts each item
  // through `num`.

  /// A model field read from [accessor]. [optional] means the key may be
  /// absent, so the field decodes to null then.
  String _fromJsonExpr(
    String accessor,
    ResolvedType type,
    _DecodeScope s,
    bool optional,
  ) {
    switch (_unalias(type, s.allTypes)) {
      case PrimitiveType(dartType: final dt):
        return _primitiveFromJson(accessor, dt, optional);
      case NullableType(inner: PrimitiveType(dartType: final dt)):
        return '$accessor as ${_orNull(dt)}';
      case NullableType(inner: final inner):
        return _fromJsonExpr(accessor, inner, s, true);
      case ListType(items: final items):
        // A field's own `List<int>` keeps converting each item through `num`.
        return _decodeList(
          accessor,
          items,
          s,
          orNull: optional,
          intsViaNum: true,
        );
      case MapType(valueType: final vt):
        return _decodeMap(accessor, vt, s, orNull: optional);
      case final other:
        final decoded = _decode(accessor, other, s);
        if (!optional || decoded == accessor) return decoded;
        return '$accessor != null ? $decoded : null';
    }
  }

  String _primitiveFromJson(String accessor, String dartType, bool optional) {
    if (dartType == 'int') {
      return optional
          ? '($accessor as num?)?.toInt()'
          : '($accessor as num).toInt()';
    }
    return '$accessor as ${optional ? _orNull(dartType) : dartType}';
  }

  /// The expression decoding the JSON value in [v] to [type]. [v] is read more
  /// than once for a nullable value, so it must be side-effect free.
  String _decode(String v, ResolvedType type, _DecodeScope s) {
    final t = _unalias(type, s.allTypes);
    switch (t) {
      case PrimitiveType(dartType: 'int'):
        return '($v as num).toInt()';
      case PrimitiveType(dartType: final dt):
        return '$v as $dt';
      case NullableType(inner: final inner):
        return _decodeNullable(v, inner, s);
      case ListType(items: final items):
        return _decodeList(v, items, s);
      case MapType(valueType: final vt):
        return _decodeMap(v, vt, s);
      case RecordType(name: final n) || SealedClassType(name: final n):
        return '$n.fromJson($v as Map<String, dynamic>${_clientArg(t, s)})';
      case EnumType(name: final n):
        return '$n.fromJson($v as String)';
      case SchemaReference(name: final n):
        if (s.allTypes[n] is EnumType) return '$n.fromJson($v as String)';
        return '$n.fromJson($v as Map<String, dynamic>${_clientArg(t, s)})';
      case TupleType(items: final items):
        final list = '($v as List<dynamic>)';
        final fields = [
          for (var i = 0; i < items.length; i++)
            _decode('$list[$i]', items[i], s),
        ];
        return '(${fields.join(', ')})';
      case TransferableType():
        // A tag with no runtime binding stays the raw (`dynamic`) value.
        return _decodeTransferable('$v as Map<String, dynamic>', t, s) ?? v;
    }
  }

  String _decodeNullable(String v, ResolvedType inner, _DecodeScope s) {
    switch (_unalias(inner, s.allTypes)) {
      case PrimitiveType(dartType: final dt):
        return '$v as ${_orNull(dt)}';
      case ListType(items: final items):
        return _decodeList(v, items, s, orNull: true);
      case MapType(valueType: final vt):
        return _decodeMap(v, vt, s, orNull: true);
      case NullableType(inner: final i):
        return _decodeNullable(v, i, s);
      case final other:
        final decoded = _decode(v, other, s);
        if (decoded == v) return v;
        return '$v == null ? null : $decoded';
    }
  }

  /// A JSON array in [v] as a `List`. [orNull] lets [v] be null, giving null.
  /// [intsViaNum] converts `int` items through `num` rather than casting.
  String _decodeList(
    String v,
    ResolvedType items,
    _DecodeScope s, {
    bool orNull = false,
    bool intsViaNum = false,
  }) {
    final q = orNull ? '?' : '';
    final list = '($v as List<dynamic>$q)$q';
    final unaliased = _unalias(items, s.allTypes);
    final intItems = unaliased is PrimitiveType && unaliased.dartType == 'int';
    if (_isCastSafe(unaliased) && !(intsViaNum && intItems)) {
      return '$list.cast<${_dartTypeStr(items, s.allTypes)}>()';
    }
    final e = s.name('e');
    return '$list.map(($e) => ${_decode(e, items, s.deeper)}).toList()';
  }

  /// A JSON object in [v] as a `Map<String, V>`. [orNull] lets [v] be null,
  /// giving null.
  String _decodeMap(
    String v,
    ResolvedType valueType,
    _DecodeScope s, {
    bool orNull = false,
  }) {
    final q = orNull ? '?' : '';
    final map = '($v as Map<String, dynamic>$q)$q';
    final k = s.name('k');
    final value = s.name('v');
    final valueExpr = _isCastSafe(_unalias(valueType, s.allTypes))
        ? '$value as ${_dartTypeStr(valueType, s.allTypes)}'
        : _decode(value, valueType, s.deeper);
    return '$map.map(($k, $value) => MapEntry($k, $valueExpr))';
  }

  /// Whether a JSON value already *is* [type] at runtime, so a cast converts
  /// it: a primitive (JSON integers decode as `int`), or `dynamic`.
  bool _isCastSafe(ResolvedType type) => switch (type) {
    PrimitiveType() => true,
    NullableType(inner: PrimitiveType()) => true,
    TransferableType(blocksType: final t) => !knownTransferableTags.contains(t),
    _ => false,
  };

  /// Hydration of a known transferable from [descriptor], an expression typed
  /// `Map<String, dynamic>`. Null for a tag with no runtime binding.
  String? _decodeTransferable(
    String descriptor,
    TransferableType type,
    _DecodeScope s,
  ) {
    if (!knownTransferableTags.contains(type.blocksType)) return null;
    return switch (type.blocksType) {
      'realtime/channel' => _realtimeChannelFromJson(
        descriptor,
        type.typeArgs.isEmpty ? null : type.typeArgs.first,
        s,
      ),
      'file-bucket/download' => 'FileDownloadHandle.fromJson($descriptor)',
      'file-bucket/upload' => 'FileUploadHandle.fromJson($descriptor)',
      'oidc/client' => _oidcClientFromJson(descriptor, s),
      _ => null,
    };
  }

  /// An `OidcClient` needs the calling client's base URL and stores. An
  /// operation passes its own `_client`; a model that holds one (at any depth)
  /// takes a `BlocksClient client` in its `fromJson` (see [_needsClient]).
  String _oidcClientFromJson(String descriptor, _DecodeScope s) {
    final c = s.client;
    if (c == null) {
      throw StateError('an oidc/client decoded with no BlocksClient in scope');
    }
    return 'OidcClient.fromJson($descriptor, baseUrl: $c.baseUrl, '
        'tokenStore: $c.tokenStore, sessionStore: $c.sessionStore)';
  }

  /// A `RealtimeChannel<T>` from [descriptor]. An object message type decodes
  /// through the map-typed `fromJson`; any other (a list, primitive, enum, or
  /// `unknown`) through `fromJsonValue`, which hands over the raw payload —
  /// as Kotlin and Swift decode the payload with `T`'s own decoder.
  String _realtimeChannelFromJson(
    String descriptor,
    ResolvedType? message,
    _DecodeScope s,
  ) {
    if (message == null) {
      return 'RealtimeChannel.fromJson($descriptor, (json) => json)';
    }
    message = _unalias(message, s.allTypes);
    final isObject = switch (message) {
      RecordType() || SealedClassType() => true,
      SchemaReference(name: final n) => s.allTypes[n] is! EnumType,
      _ => false,
    };
    if (isObject) {
      final name = _dartTypeStr(message, s.allTypes);
      return 'RealtimeChannel.fromJson($descriptor, (json) => $name.fromJson(json${_clientArg(message, s)}))';
    }
    final decode = message is PrimitiveType && message.dartType == 'dynamic'
        ? 'payload'
        : _decode('payload', message, s.deeper);
    return 'RealtimeChannel.fromJsonValue($descriptor, (payload) => $decode)';
  }

  /// `, <client>` when decoding [type] needs a `BlocksClient`, else empty.
  String _clientArg(ResolvedType type, _DecodeScope s) {
    if (!_needsClient(type, s.allTypes)) return '';
    final c = s.client;
    if (c == null) {
      throw StateError('a model holding an oidc/client decoded with no client');
    }
    return ', $c';
  }

  /// Whether decoding [type] reaches an `oidc/client`, which needs the
  /// calling `BlocksClient`'s base URL and stores. A model for which this
  /// holds takes the client as a second `fromJson` argument.
  bool _needsClient(
    ResolvedType type,
    Map<String, ResolvedType> allTypes, [
    Set<String>? seen,
  ]) {
    final visited = seen ?? <String>{};
    bool needs(ResolvedType t) => _needsClient(t, allTypes, visited);
    return switch (type) {
      TransferableType(blocksType: 'oidc/client') => true,
      TransferableType(typeArgs: final args) => args.any(needs),
      NullableType(inner: final inner) => needs(inner),
      ListType(items: final items) => needs(items),
      MapType(valueType: final vt) => needs(vt),
      TupleType(items: final items) => items.any(needs),
      RecordType(name: final n, fields: final fields) =>
        visited.add('record:$n') &&
            (fields.any((f) => needs(f.type)) ||
                (type.additionalProperties != null &&
                    needs(type.additionalProperties!))),
      SealedClassType(name: final n, variants: final variants) =>
        visited.add('sealed:$n') &&
            variants.any(
              (v) =>
                  v.fields.any((f) => needs(f.type)) ||
                  (v.embeddedUnion != null && needs(v.embeddedUnion!)) ||
                  (v.additionalProperties != null &&
                      needs(v.additionalProperties!)),
            ),
      SchemaReference(name: final n) =>
        visited.add('ref:$n') && allTypes[n] != null && needs(allTypes[n]!),
      PrimitiveType() || EnumType() => false,
    };
  }

  /// The `fromJson` parameter list of a model; see [_needsClient].
  String _fromJsonParams(bool needsClient) => needsClient
      ? 'Map<String, dynamic> json, BlocksClient client'
      : 'Map<String, dynamic> json';

  // --- toJson expression helpers ---
  //
  // [_encode] mirrors [_decode]: it turns a Dart value back into its JSON
  // shape, descending through the same containers, so `toJson()` returns
  // plain JSON (maps, lists, strings, numbers, booleans, null) and
  // `X.fromJson(x.toJson())` round-trips. A transferable is a handle the
  // server issues; it encodes as the `{"__blocks": …}` descriptor it was
  // hydrated from (the runtime type's `toJson()`), the shape the server sent
  // it in, as Kotlin and Swift send it. One with no runtime binding is typed
  // `dynamic`, holds that descriptor as JSON already, and is passed as is.

  /// A model field's JSON value. [optional] means the field may be null.
  String _toJsonExpr(
    String field,
    ResolvedType type,
    _DecodeScope s,
    bool optional,
  ) {
    final t = _unalias(type, s.allTypes);
    return _encode(
      field,
      optional && t is! NullableType ? NullableType(t) : t,
      s,
    );
  }

  /// The JSON value of [v], a value of [type]. Returns [v] itself when the
  /// value already is JSON.
  String _encode(String v, ResolvedType type, _DecodeScope s) {
    switch (_unalias(type, s.allTypes)) {
      case PrimitiveType():
        return v;
      case TransferableType(blocksType: final tag):
        return knownTransferableTags.contains(tag) ? '$v.toJson()' : v;
      case NullableType(inner: final inner):
        return _encodeNullable(v, inner, s);
      case ListType(items: final items):
        final e = s.name('e');
        final item = _encode(e, items, s.deeper);
        return item == e ? v : '$v.map(($e) => $item).toList()';
      case MapType(valueType: final vt):
        final k = s.name('k');
        final value = s.name('v');
        final valueExpr = _encode(value, vt, s.deeper);
        return valueExpr == value
            ? v
            : '$v.map(($k, $value) => MapEntry($k, $valueExpr))';
      case RecordType() || SealedClassType() || EnumType():
        return '$v.toJson()';
      case SchemaReference(name: final n):
        return s.allTypes[n] is PrimitiveType ? v : '$v.toJson()';
      case TupleType(items: final items):
        final fields = [
          for (var i = 0; i < items.length; i++)
            _encode('$v.\$${i + 1}', items[i], s),
        ];
        return '[${fields.join(', ')}]';
    }
  }

  /// The JSON value of [v], which may be null. A model field doesn't promote
  /// after a null check, so this uses `?.`, or binds a non-null local.
  String _encodeNullable(String v, ResolvedType type, _DecodeScope s) {
    final inner = _unalias(type, s.allTypes);
    if (_encode(v, inner, s) == v) return v;
    switch (inner) {
      case RecordType() ||
          SealedClassType() ||
          EnumType() ||
          SchemaReference() ||
          TransferableType():
        return '$v?.toJson()';
      case ListType(items: final items):
        final e = s.name('e');
        return '$v?.map(($e) => ${_encode(e, items, s.deeper)}).toList()';
      case MapType(valueType: final vt):
        final k = s.name('k');
        final value = s.name('v');
        return '$v?.map(($k, $value) => MapEntry($k, ${_encode(value, vt, s.deeper)}))';
      default:
        final x = s.name('value');
        return 'switch ($v) { final $x? => ${_encode(x, inner, s.deeper)}, _ => null }';
    }
  }

  // --- Param serialization ---

  /// A parameter's JSON value. An optional parameter is encoded inside an
  /// `if (p != null)` entry, where it is promoted, so it encodes as non-null.
  ///
  /// With [nullable], the parameter isn't promoted (an optional one whose slot
  /// is kept, or that is sent because a later one is set), so it is encoded as
  /// a nullable value: `null` stays `null` in its slot.
  String _paramToJsonExpr(
    String name,
    ResolvedType type,
    Map<String, ResolvedType> allTypes, {
    bool promoted = false,
    bool nullable = false,
  }) {
    final unaliased = _unalias(type, allTypes);
    final t = promoted && unaliased is NullableType
        ? unaliased.inner
        : nullable && unaliased is! NullableType
        ? NullableType(unaliased)
        : unaliased;
    return _encode(name, t, _DecodeScope(allTypes));
  }

  /// Whether a field of [type] can hold a list or map, which `==` would
  /// compare by identity: a list or map (possibly nullable, or behind a
  /// `$ref`), or a `dynamic` value (an `unknown`, or a transferable with no
  /// runtime binding), which holds whatever JSON arrived. A model, enum,
  /// sealed class, known transferable or tuple keeps its own `==`.
  bool _comparesDeeply(
    ResolvedType type,
    Map<String, ResolvedType> allTypes, [
    Set<String>? seen,
  ]) => switch (type) {
    ListType() || MapType() => true,
    PrimitiveType(dartType: final t) => t == 'dynamic',
    TransferableType(blocksType: final tag) => !knownTransferableTags.contains(
      tag,
    ),
    NullableType(inner: final i) => _comparesDeeply(i, allTypes, seen),
    SchemaReference(name: final n) =>
      (seen ??= {}).add(n) &&
          allTypes[n] != null &&
          _comparesDeeply(allTypes[n]!, allTypes, seen),
    _ => false,
  };

  /// Every transferable tag the generated library's types and operations use,
  /// at any depth: top-level types, model and union fields, additional
  /// properties, list items, map values, nullables, tuples, channel message
  /// types, and operation results and parameters.
  Set<String> _collectTransferableTags(CodegenModel model) {
    final tags = <String>{};
    final seen = <ResolvedType>{};
    void walk(ResolvedType type) {
      if (!seen.add(type)) return;
      switch (type) {
        case TransferableType(blocksType: final tag, typeArgs: final args):
          tags.add(tag);
          args.forEach(walk);
        case RecordType(fields: final fields, additionalProperties: final ap):
          for (final f in fields) {
            walk(f.type);
          }
          if (ap != null) walk(ap);
        case SealedClassType(variants: final variants):
          for (final v in variants) {
            for (final f in v.fields) {
              walk(f.type);
            }
            if (v.embeddedUnion != null) walk(v.embeddedUnion!);
            if (v.additionalProperties case final ap?) walk(ap);
          }
        case NullableType(inner: final i):
          walk(i);
        case ListType(items: final i):
          walk(i);
        case MapType(valueType: final v):
          walk(v);
        case TupleType(items: final items):
          items.forEach(walk);
        case SchemaReference(name: final n):
          if (model.types[n] case final t?) walk(t);
        case PrimitiveType() || EnumType():
          break;
      }
    }

    model.types.values.forEach(walk);
    for (final ns in model.namespaces) {
      for (final op in ns.operations) {
        walk(op.result);
        for (final p in op.params) {
          walk(p.type);
        }
      }
    }
    return tags;
  }

  /// A bare transferable whose tag has no runtime binding (the fallback case).
  /// A nested/nullable/list-wrapped one is out of scope and stays `dynamic`.
  bool _isUnboundTransferable(ResolvedType type) =>
      type is TransferableType &&
      !knownTransferableTags.contains(type.blocksType);

  /// Single-quoted Dart string literal for [value]. Every string from the
  /// spec that the generated code holds as a literal goes through this (or
  /// [_escapeStringContent], for one spliced into a larger literal): JSON
  /// keys, discriminants and their values, enum wire values, operation
  /// names, server URLs and transferable tags. Escapes `\`, `$`, `'`, `\n`,
  /// `\r`, `\t`, and every other control character and lone surrogate, so the
  /// literal neither ends early nor interpolates.
  String _dartStringLiteral(String value) => "'${_escapeStringContent(value)}'";

  /// [value] escaped to sit between the quotes of a single-quoted, non-raw
  /// Dart string literal; see [_dartStringLiteral].
  String _escapeStringContent(String value) {
    final buf = StringBuffer();
    for (final unit in value.runes) {
      switch (unit) {
        case 0x5C:
          buf.write(r'\\');
        case 0x24:
          buf.write(r'\$');
        case 0x27:
          buf.write(r"\'");
        case 0x0A:
          buf.write(r'\n');
        case 0x0D:
          buf.write(r'\r');
        case 0x09:
          buf.write(r'\t');
        case < 0x20 || 0x7F || >= 0xD800 && <= 0xDFFF:
          buf.write('\\u{${unit.toRadixString(16)}}');
        default:
          buf.writeCharCode(unit);
      }
    }
    return buf.toString();
  }

  /// A Dart string literal for the regular expression [pattern]: raw
  /// (`r'…'`), so backslashes read as written, unless the pattern holds a
  /// `'` or a control character a raw literal can't; then an escaped one
  /// (see [_dartStringLiteral]), which holds the same characters.
  String _dartRegExpLiteral(String pattern) =>
      RegExp(r"['\x00-\x1F\x7F\uD800-\uDFFF]").hasMatch(pattern)
      ? _dartStringLiteral(pattern)
      : "r'$pattern'";

  /// The expression reading [key] from a model's `json` map.
  String _jsonKey(String key) => 'json[${_dartStringLiteral(key)}]';

  /// [text] for a `//` comment: a line break would end the comment and turn
  /// the rest into code, so each run of them becomes a space.
  String _commentText(String text) =>
      text.replaceAll(RegExp(r'[\r\n\u2028\u2029]+'), ' ');

  /// Emits ==, hashCode, and toString overrides for a data class.
  ///
  /// Each field is `(identifier, deep)`. A deep field holds a list or map,
  /// which Dart compares by identity, so it is compared with the runtime's
  /// `blocksDeepEquals` and hashed with `blocksDeepHash` (see
  /// [_comparesDeeply]); any other field uses its own `==` and `hashCode`.
  void _emitEquality(
    StringBuffer buf,
    String className,
    List<(String, bool)> fields,
  ) {
    // == operator. Its parameter yields to a field of the same name, which
    // would otherwise shadow the field (`other == other.other`).
    final other = _freeName('other', {for (final (f, _) in fields) f});
    buf.writeln();
    buf.writeln('  @override');
    buf.writeln('  bool operator ==(Object $other) =>');
    buf.writeln('      identical(this, $other) ||');
    if (fields.isEmpty) {
      buf.writeln('      $other is $className;');
    } else {
      buf.write('      $other is $className');
      for (final (f, deep) in fields) {
        buf.writeln(' &&');
        buf.write(
          deep
              ? '          blocksDeepEquals($f, $other.$f)'
              : '          $f == $other.$f',
        );
      }
      buf.writeln(';');
    }

    // hashCode
    final hashes = [
      for (final (f, deep) in fields) deep ? 'blocksDeepHash($f)' : f,
    ];
    buf.writeln();
    buf.writeln('  @override');
    if (fields.isEmpty) {
      buf.writeln('  int get hashCode => runtimeType.hashCode;');
    } else if (fields.length == 1) {
      final (f, deep) = fields.first;
      buf.writeln(
        '  int get hashCode => ${deep ? 'blocksDeepHash($f)' : '$f.hashCode'};',
      );
    } else if (fields.length <= 20) {
      buf.writeln('  int get hashCode => Object.hash(${hashes.join(', ')});');
    } else {
      buf.writeln(
        '  int get hashCode => Object.hashAll([${hashes.join(', ')}]);',
      );
    }

    // toString
    buf.writeln();
    buf.writeln('  @override');
    final props = fields
        .map((field) {
          final f = field.$1;
          // Reserved-word fields are escaped with a trailing '$' (e.g. `required$`).
          // A bare '$' in the string literal/interpolation is misparsed by Dart, so
          // such identifiers need a '$'-escaped label and brace interpolation.
          // Normal identifiers keep the terse `$field` form (no golden churn).
          if (f.contains(r'$')) {
            final label = f.replaceAll(r'$', r'\$');
            return '$label: \${$f}';
          }
          return '$f: \$$f';
        })
        .join(', ');
    // A type name can hold a `$` too (`String$`), which needs escaping in the
    // literal.
    final label = className.replaceAll(r'$', r'\$');
    buf.writeln("  String toString() => '$label($props)';");
  }

  /// Members every Dart object has. A field, method, `Blocks` field, server
  /// constant or enum value with one of these names is a duplicate or an
  /// invalid override.
  static const _objectMembers = {
    'hashCode',
    'noSuchMethod',
    'runtimeType',
    'toString',
  };

  /// What a model or union variant class declares or refers to besides its
  /// fields: `fromJson`, `toJson`, the `@override` annotation and the
  /// functions `==` and `hashCode` call. An open record's
  /// `additionalProperties` map is added where the record has one.
  static const _modelMembers = {
    ..._objectMembers,
    'blocksDeepEquals',
    'blocksDeepHash',
    'fromJson',
    'identical',
    'override',
    'toJson',
  };

  /// What a generated enum declares or inherits besides its values: Dart's
  /// `values`, `index` and `name`, and the generated `fromJson` / `toJson`.
  static const _enumMembers = {
    ..._objectMembers,
    'fromJson',
    'index',
    'name',
    'toJson',
    'values',
  };

  /// The names the generated library declares at the top level: every
  /// model, enum, union and variant class, each namespace's `…Api` class
  /// ([apiClasses]), `Blocks` and `Servers`. A member or parameter named like
  /// one shadows the type, as with [referencedNames].
  Set<String> _declaredNames(
    CodegenModel model,
    Map<String, String> apiClasses,
  ) => {..._typeNames(model), ...apiClasses.values};

  /// `Blocks`, `Servers`, and the name of every model, enum, union and
  /// variant class. The builder has already made each a usable identifier.
  Set<String> _typeNames(CodegenModel model) {
    final names = {'Blocks', 'Servers'};
    void addUnion(SealedClassType union) {
      names.add(union.name);
      for (final v in union.variants) {
        names.add(v.className);
        if (v.embeddedUnion case final embedded?) addUnion(embedded);
      }
    }

    for (final type in model.types.values) {
      switch (type) {
        case RecordType(name: final n) || EnumType(name: final n):
          names.add(n);
        case SealedClassType():
          addUnion(type);
        default:
          break;
      }
    }
    return names;
  }

  /// The `…Api` class of each namespace, keyed by the namespace's name: the
  /// name camel-cased and capitalized, then `Api` (`todos` is `TodosApi`,
  /// `a.b` is `ABApi`, `_default` is `$defaultApi`; see [_identifiers]).
  /// The class is generated, so it yields to a type of the same name
  /// (`TodosApi$`), and of namespaces that land on one class, the one whose
  /// name is already an identifier keeps it, as its `Blocks` field does.
  Map<String, String> _apiClassNames(CodegenModel model) {
    final names = model.namespaces.map((ns) => ns.name).toList();
    return dartIdentifiers(
      [
        ...names.where((n) => sanitizeIdentifier(n) == n),
        ...names.where((n) => sanitizeIdentifier(n) != n),
      ],
      reserved: {..._typeNames(model), ...generatedTopLevelNames},
      sanitize: (n) => '${_capitalize(sanitizeIdentifier(n))}Api',
    );
  }

  /// The Dart identifier for each of [names]: names from the spec (JSON
  /// keys, operation, parameter, namespace and server names, enum values)
  /// that share one scope, keyed by the name. This is the one place a spec
  /// name becomes an identifier; the JSON key stays the original name.
  ///
  /// A name is used as is unless Dart can't take it there (see
  /// [dartIdentifiers], which this calls):
  ///
  /// - A name with characters an identifier can't hold is camel-cased
  ///   across them first ([sanitizeIdentifier]): `content-type` is
  ///   `contentType`, `a.b` is `aB`, and an enum value `in-progress` is
  ///   `inProgress`.
  /// - A leading `_` would make it library-private (and a named parameter
  ///   can't start with `_`), so each leading `_` becomes `$`: `_id` is
  ///   `$id`, `__v` is `$$v`.
  /// - A Dart keyword, a name the generated code refers to
  ///   ([referencedNames]), a top-level name of the library ([declared]),
  ///   or a member the scope already has ([reserved]) gets a trailing `$`:
  ///   `class$`, `int$`, `toJson$`, `values$`.
  ///
  /// An identifier that another name of the scope already has as is gets
  /// more `$`s, so no two names share one. Every other name is unchanged,
  /// so existing output is too.
  Map<String, String> _identifiers(
    Iterable<String> names, {
    Set<String> reserved = const {},
    Set<String> declared = const {},
  }) => dartIdentifiers(names, reserved: {...reserved, ...declared});

  /// The `Servers` constant for each server name; see [_identifiers].
  Map<String, String> _serverIdentifiers(
    List<Server> servers,
    Set<String> declared,
  ) => _identifiers(
    servers.map((s) => s.name),
    reserved: _objectMembers,
    declared: declared,
  );

  /// A name for a local (or parameter) the generated code declares in a scope
  /// that also holds the user-chosen identifiers [taken]: [base] itself, or,
  /// when a user name already has it, `$base` (then `$base2`, …).
  ///
  /// The generated name yields, not the user's: a user name is public API (a
  /// named parameter, a field), and renaming it only where it collides would
  /// change what a caller writes. [taken] holds the user names as
  /// identifiers (see [_identifiers]), so a user `_result`, which is
  /// `$result`, pushes a yielded local on to `$result2`.
  /// Names that collide with nothing are unchanged, so existing output is too.
  static String _freeName(String base, Set<String> taken) {
    if (!taken.contains(base)) return base;
    var candidate = '\$$base';
    for (var i = 2; taken.contains(candidate); i++) {
      candidate = '\$$base$i';
    }
    return candidate;
  }

  String _capitalize(String s) =>
      s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

  /// [type], with a `$ref` to a schema that has no Dart declaration replaced
  /// by the type that schema resolves to (see [_aliasTarget]), at the top
  /// level and under a nullable. Every other type is returned as is.
  ResolvedType _unalias(ResolvedType type, Map<String, ResolvedType> allTypes) {
    switch (type) {
      case SchemaReference(name: final n):
        final target = _aliasTarget(n, allTypes);
        return target == null ? type : _unalias(target, allTypes);
      case NullableType(inner: final inner):
        final u = _unalias(inner, allTypes);
        if (u is NullableType) return u;
        return identical(u, inner) ? type : NullableType(u);
      default:
        return type;
    }
  }

  /// What a `$ref` to the schema [name] stands for when the schema isn't a
  /// model, an enum or a union (which are declared under its name): a
  /// primitive, list, map, nullable, tuple, transferable, another `$ref`, or
  /// `dynamic` (e.g. a union discriminated by `const`). Such a schema has no
  /// Dart declaration, so a `$ref` to it is typed, decoded and encoded as the
  /// type itself. A schema that reaches itself only through such types
  /// (`Loop = List<Loop>`) has no finite Dart type and stands for `dynamic`.
  /// Null when [name] is declared, or isn't a schema.
  ResolvedType? _aliasTarget(String name, Map<String, ResolvedType> allTypes) {
    final target = allTypes[name];
    if (target == null || _isDeclared(target)) return null;
    return _aliasReaches(target, name, allTypes, {name})
        ? const PrimitiveType('dynamic')
        : target;
  }

  bool _isDeclared(ResolvedType type) =>
      type is RecordType || type is EnumType || type is SealedClassType;

  /// Whether [type] reaches a `$ref` to [name] without passing through a
  /// declared type (whose own name breaks the cycle).
  bool _aliasReaches(
    ResolvedType type,
    String name,
    Map<String, ResolvedType> allTypes,
    Set<String> seen,
  ) {
    bool reaches(ResolvedType t) => _aliasReaches(t, name, allTypes, seen);
    return switch (type) {
      SchemaReference(name: final n) =>
        n == name ||
            switch (allTypes[n]) {
              final t? => !_isDeclared(t) && seen.add(n) && reaches(t),
              null => false,
            },
      NullableType(inner: final i) => reaches(i),
      ListType(items: final i) => reaches(i),
      MapType(valueType: final v) => reaches(v),
      TupleType(items: final items) => items.any(reaches),
      TransferableType(typeArgs: final args) => args.any(reaches),
      _ => false,
    };
  }

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

/// What a decode or encode expression can reach: the model's types, and an
/// expression for a `BlocksClient` when one is in scope (an `oidc/client`
/// needs the client's base URL and stores). [depth] numbers the parameters of
/// nested closures (`e`, `e1`, …) so that inner ones don't shadow outer ones.
class _DecodeScope {
  final Map<String, ResolvedType> allTypes;
  final String? client;
  final int depth;
  const _DecodeScope(this.allTypes, {this.client, this.depth = 0});

  _DecodeScope get deeper =>
      _DecodeScope(allTypes, client: client, depth: depth + 1);

  /// [base], suffixed with the depth below the outermost closure.
  String name(String base) => depth == 0 ? base : '$base$depth';
}
