// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

enum WidgetKind {
  cost_,
  a_b,
  x__y,
  b_c,
  d_e
;

  static const _jsonMap = <String, WidgetKind>{
    'cost\$': cost_,
    'a\$b': a_b,
    'x\$\$y': x__y,
    'b-\$c': b_c,
    'd_\$e': d_e,
  };
  static const _toJsonMap = <WidgetKind, String>{
    cost_: 'cost\$',
    a_b: 'a\$b',
    x__y: 'x\$\$y',
    b_c: 'b-\$c',
    d_e: 'd_\$e',
  };
  String toJson() => _toJsonMap[this]!;
  static WidgetKind fromJson(String json) => _jsonMap[json]!;
}


// --- API Namespaces ---

class Widget {
  final String id;
  final String code;
  final WidgetKind kind;
  final String? note_;
  final int? count;
  final int? limit;
  final num? ratio;
  final num? scale;
  final bool? flag;

  Widget({
    required this.id,
    required this.code,
    required this.kind,
    this.note_,
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
      note_: json['note\$'] as String?,
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
      if (note_ != null) 'note\$': note_,
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
          note_ == other.note_ &&
          count == other.count &&
          limit == other.limit &&
          ratio == other.ratio &&
          scale == other.scale &&
          flag == other.flag;

  @override
  int get hashCode => Object.hash(id, code, kind, note_, count, limit, ratio, scale, flag);

  @override
  String toString() => 'Widget(id: $id, code: $code, kind: $kind, note_: $note_, count: $count, limit: $limit, ratio: $ratio, scale: $scale, flag: $flag)';
}


sealed class ApiDoActionInput {
  const ApiDoActionInput();
  Map<String, dynamic> toJson();
  static ApiDoActionInput fromJson(Map<String, dynamic> json) {
    switch (json['action'] as String) {
      case 'create\$': return Create_Input.fromJson(json);
      case 're\$move': return Re_moveInput.fromJson(json);
      default: throw ArgumentError('Unknown action: ${json['action']}');
    }
  }
}

class Create_Input extends ApiDoActionInput {
  final String title;

  const Create_Input({
    required this.title,
  });

  factory Create_Input.fromJson(Map<String, dynamic> json) {
    return Create_Input(
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
      other is Create_Input &&
          title == other.title;

  @override
  int get hashCode => title.hashCode;

  @override
  String toString() => 'Create_Input(title: $title)';
}

class Re_moveInput extends ApiDoActionInput {
  final String id;

  const Re_moveInput({
    required this.id,
  });

  factory Re_moveInput.fromJson(Map<String, dynamic> json) {
    return Re_moveInput(
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
      other is Re_moveInput &&
          id == other.id;

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'Re_moveInput(id: $id)';
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

  Future<Widget> get_x({required String id}) async {
    final params = <String, dynamic>{
      'id': id,
    };
    final result = await _client.call('api.get\$x', params);
    return Widget.fromJson(result as Map<String, dynamic>);
  }

  Future<DoActionResult> doAction({required ApiDoActionInput input}) async {
    final params = <String, dynamic>{
      'input': input.toJson(),
    };
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

