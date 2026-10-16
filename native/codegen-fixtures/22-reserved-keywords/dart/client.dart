// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

// --- API Namespaces ---

class GetClassResult {
  final String type;
  final String class$;
  final String default$;
  final String in$;
  final bool is$;
  final int return$;
  final String var$;
  final String val;
  final String when;
  final String switch$;
  final String self;
  final String super$;

  const GetClassResult({
    required this.type,
    required this.class$,
    required this.default$,
    required this.in$,
    required this.is$,
    required this.return$,
    required this.var$,
    required this.val,
    required this.when,
    required this.switch$,
    required this.self,
    required this.super$,
  });

  factory GetClassResult.fromJson(Map<String, dynamic> json) {
    return GetClassResult(
      type: json['type'] as String,
      class$: json['class'] as String,
      default$: json['default'] as String,
      in$: json['in'] as String,
      is$: json['is'] as bool,
      return$: (json['return'] as num).toInt(),
      var$: json['var'] as String,
      val: json['val'] as String,
      when: json['when'] as String,
      switch$: json['switch'] as String,
      self: json['self'] as String,
      super$: json['super'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'type': type,
      'class': class$,
      'default': default$,
      'in': in$,
      'is': is$,
      'return': return$,
      'var': var$,
      'val': val,
      'when': when,
      'switch': switch$,
      'self': self,
      'super': super$,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetClassResult &&
          type == other.type &&
          class$ == other.class$ &&
          default$ == other.default$ &&
          in$ == other.in$ &&
          is$ == other.is$ &&
          return$ == other.return$ &&
          var$ == other.var$ &&
          val == other.val &&
          when == other.when &&
          switch$ == other.switch$ &&
          self == other.self &&
          super$ == other.super$;

  @override
  int get hashCode => Object.hash(type, class$, default$, in$, is$, return$, var$, val, when, switch$, self, super$);

  @override
  String toString() => 'GetClassResult(type: $type, class\$: ${class$}, default\$: ${default$}, in\$: ${in$}, is\$: ${is$}, return\$: ${return$}, var\$: ${var$}, val: $val, when: $when, switch\$: ${switch$}, self: $self, super\$: ${super$})';
}


class ApiImportInput {
  final String for$;
  final int while$;
  final bool do$;
  final String else$;
  final String enum$;
  final String extends$;
  final String final$;
  final bool abstract$;

  const ApiImportInput({
    required this.for$,
    required this.while$,
    required this.do$,
    required this.else$,
    required this.enum$,
    required this.extends$,
    required this.final$,
    required this.abstract$,
  });

  factory ApiImportInput.fromJson(Map<String, dynamic> json) {
    return ApiImportInput(
      for$: json['for'] as String,
      while$: (json['while'] as num).toInt(),
      do$: json['do'] as bool,
      else$: json['else'] as String,
      enum$: json['enum'] as String,
      extends$: json['extends'] as String,
      final$: json['final'] as String,
      abstract$: json['abstract'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'for': for$,
      'while': while$,
      'do': do$,
      'else': else$,
      'enum': enum$,
      'extends': extends$,
      'final': final$,
      'abstract': abstract$,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiImportInput &&
          for$ == other.for$ &&
          while$ == other.while$ &&
          do$ == other.do$ &&
          else$ == other.else$ &&
          enum$ == other.enum$ &&
          extends$ == other.extends$ &&
          final$ == other.final$ &&
          abstract$ == other.abstract$;

  @override
  int get hashCode => Object.hash(for$, while$, do$, else$, enum$, extends$, final$, abstract$);

  @override
  String toString() => 'ApiImportInput(for\$: ${for$}, while\$: ${while$}, do\$: ${do$}, else\$: ${else$}, enum\$: ${enum$}, extends\$: ${extends$}, final\$: ${final$}, abstract\$: ${abstract$})';
}


class ImportResult {
  final bool ok;

  const ImportResult({
    required this.ok,
  });

  factory ImportResult.fromJson(Map<String, dynamic> json) {
    return ImportResult(
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
      other is ImportResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'ImportResult(ok: $ok)';
}


class ExportResult {
  final String object;
  final String package;
  final String internal;
  final String operator$;
  final String this$;
  final String throw$;
  final bool true$;
  final bool false$;
  final String null$;

  const ExportResult({
    required this.object,
    required this.package,
    required this.internal,
    required this.operator$,
    required this.this$,
    required this.throw$,
    required this.true$,
    required this.false$,
    required this.null$,
  });

  factory ExportResult.fromJson(Map<String, dynamic> json) {
    return ExportResult(
      object: json['object'] as String,
      package: json['package'] as String,
      internal: json['internal'] as String,
      operator$: json['operator'] as String,
      this$: json['this'] as String,
      throw$: json['throw'] as String,
      true$: json['true'] as bool,
      false$: json['false'] as bool,
      null$: json['null'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'object': object,
      'package': package,
      'internal': internal,
      'operator': operator$,
      'this': this$,
      'throw': throw$,
      'true': true$,
      'false': false$,
      'null': null$,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ExportResult &&
          object == other.object &&
          package == other.package &&
          internal == other.internal &&
          operator$ == other.operator$ &&
          this$ == other.this$ &&
          throw$ == other.throw$ &&
          true$ == other.true$ &&
          false$ == other.false$ &&
          null$ == other.null$;

  @override
  int get hashCode => Object.hash(object, package, internal, operator$, this$, throw$, true$, false$, null$);

  @override
  String toString() => 'ExportResult(object: $object, package: $package, internal: $internal, operator\$: ${operator$}, this\$: ${this$}, throw\$: ${throw$}, true\$: ${true$}, false\$: ${false$}, null\$: ${null$})';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<GetClassResult> getClass({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('api.getClass', params);
    return GetClassResult.fromJson(result as Map<String, dynamic>);
  }

  Future<ImportResult> import$({required ApiImportInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.import', params);
    return ImportResult.fromJson(result as Map<String, dynamic>);
  }

  Future<ExportResult> export$() async {
    final result = await _client.call('api.export', const <dynamic>[]);
    return ExportResult.fromJson(result as Map<String, dynamic>);
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

