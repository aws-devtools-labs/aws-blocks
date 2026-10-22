// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

enum WidgetKind {
  cost$,
  a$b,
  x$$y,
  b$c,
  d_$e
;

  static const _jsonMap = <String, WidgetKind>{
    'cost\$': cost$,
    'a\$b': a$b,
    'x\$\$y': x$$y,
    'b-\$c': b$c,
    'd_\$e': d_$e,
  };
  static const _toJsonMap = <WidgetKind, String>{
    cost$: 'cost\$',
    a$b: 'a\$b',
    x$$y: 'x\$\$y',
    b$c: 'b-\$c',
    d_$e: 'd_\$e',
  };
  String toJson() => _toJsonMap[this]!;
  static WidgetKind fromJson(String json) => _jsonMap[json]!;
}


// --- API Namespaces ---

class Widget {
  final String id;
  final String code;
  final WidgetKind kind;
  final String? note$;
  final int? count;
  final int? limit;
  final num? ratio;
  final num? scale;
  final bool? flag;

  Widget({
    required this.id,
    required this.code,
    required this.kind,
    this.note$,
    this.count,
    this.limit,
    this.ratio,
    this.scale,
    this.flag,
  }) {
    if (!(RegExp('^a\'b"c\\\$d[\${x}]+\$').hasMatch(code))) throw ArgumentError('code must match pattern');
  }

  factory Widget.fromJson(Map<String, dynamic> json) {
    return Widget(
      id: json['id'] as String,
      code: json['code'] as String,
      kind: WidgetKind.fromJson(json['kind'] as String),
      note$: json['note\$'] as String?,
      count: (json['count'] as num?)?.toInt(),
      limit: (json['limit'] as num?)?.toInt(),
      ratio: json['ratio'] as num?,
      scale: json['scale'] as num?,
      flag: json['flag'] as bool?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'code': code,
      'kind': kind.toJson(),
      if (note$ != null) 'note\$': note$,
      if (count != null) 'count': count,
      if (limit != null) 'limit': limit,
      if (ratio != null) 'ratio': ratio,
      if (scale != null) 'scale': scale,
      if (flag != null) 'flag': flag,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Widget &&
          id == other.id &&
          code == other.code &&
          kind == other.kind &&
          note$ == other.note$ &&
          count == other.count &&
          limit == other.limit &&
          ratio == other.ratio &&
          scale == other.scale &&
          flag == other.flag;

  @override
  int get hashCode => Object.hash(id, code, kind, note$, count, limit, ratio, scale, flag);

  @override
  String toString() => 'Widget(id: $id, code: $code, kind: $kind, note\$: ${note$}, count: $count, limit: $limit, ratio: $ratio, scale: $scale, flag: $flag)';
}


sealed class ApiDoActionInput {
  const ApiDoActionInput();
  Map<String, dynamic> toJson();
  static ApiDoActionInput fromJson(Map<String, dynamic> json) {
    switch (json['action'] as String) {
      case 'create\$': return Create$Input.fromJson(json);
      case 're\$move': return Re$moveInput.fromJson(json);
      default: throw ArgumentError('Unknown action: ${json['action']}');
    }
  }
}

class Create$Input extends ApiDoActionInput {
  final String title;

  const Create$Input({
    required this.title,
  });

  factory Create$Input.fromJson(Map<String, dynamic> json) {
    return Create$Input(
      title: json['title'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'create\$',
      'title': title,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Create$Input &&
          title == other.title;

  @override
  int get hashCode => title.hashCode;

  @override
  String toString() => 'Create\$Input(title: $title)';
}

class Re$moveInput extends ApiDoActionInput {
  final String id;

  const Re$moveInput({
    required this.id,
  });

  factory Re$moveInput.fromJson(Map<String, dynamic> json) {
    return Re$moveInput(
      id: json['id'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 're\$move',
      'id': id,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Re$moveInput &&
          id == other.id;

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'Re\$moveInput(id: $id)';
}



class DoActionResult {
  final bool ok;

  const DoActionResult({
    required this.ok,
  });

  factory DoActionResult.fromJson(Map<String, dynamic> json) {
    return DoActionResult(
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
      other is DoActionResult &&
          ok == other.ok;

  @override
  int get hashCode => ok.hashCode;

  @override
  String toString() => 'DoActionResult(ok: $ok)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Widget> get$x({required String id}) async {
    final params = <dynamic>[
      id,
    ];
    final result = await _client.call('api.get\$x', params);
    return Widget.fromJson(result as Map<String, dynamic>);
  }

  Future<DoActionResult> doAction({required ApiDoActionInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('api.doAction', params);
    return DoActionResult.fromJson(result as Map<String, dynamic>);
  }
}


// --- Servers ---

class Servers {
  static const String primary = 'https://example.com/a\'b\$c\${x}"d\\e';
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;

  Blocks({String? baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl ?? Servers.primary, sessionStore: sessionStore);
    api = ApiApi(client);
  }
}

