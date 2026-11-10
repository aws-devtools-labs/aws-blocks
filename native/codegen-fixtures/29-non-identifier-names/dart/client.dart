// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

enum Sample_Type__x___Kind {
  a_b,
  c_d,
  x_y,
  newLine,
  $__x_,
  $__z_,
  $__unnamed,
  $1st,
  SpAce
;

  static const _jsonMap = <String, Sample_Type__x___Kind>{
    'a"b': a_b,
    'c;d': c_d,
    'x`y': x_y,
    'new\nline': newLine,
    '\${x}': $__x_,
    '\\(z)': $__z_,
    '*/': $__unnamed,
    '1st': $1st,
    ' sp ace': SpAce,
  };
  static const _toJsonMap = <Sample_Type__x___Kind, String>{
    a_b: 'a"b',
    c_d: 'c;d',
    x_y: 'x`y',
    newLine: 'new\nline',
    $__x_: '\${x}',
    $__z_: '\\(z)',
    $__unnamed: '*/',
    $1st: '1st',
    SpAce: ' sp ace',
  };
  String toJson() => _toJsonMap[this]!;
  static Sample_Type__x___Kind fromJson(String json) => _jsonMap[json]!;
}


// --- API Namespaces ---

class Sample_Type__x___ {
  final String run___error__x________id;
  final String? $_unnamed;
  final String? $__x_;
  final String? $__y_;
  final String? $__unnamed;
  final String? q_uote;
  final String? s_ingle;
  final String semi_colon;
  final String? back_tick;
  final String? new_line;
  final int with_space;
  final bool? $9lives;
  final Sample_Type__x___Kind? kind;

  Sample_Type__x___({
    required this.run___error__x________id,
    this.$_unnamed,
    this.$__x_,
    this.$__y_,
    this.$__unnamed,
    this.q_uote,
    this.s_ingle,
    required this.semi_colon,
    this.back_tick,
    this.new_line,
    required this.with_space,
    this.$9lives,
    this.kind,
  }) {
    if (!(run___error__x________id.length >= 2)) throw ArgumentError('run { error("x") } || id must be at least 2 characters');
    if (!(semi_colon.length <= 10)) throw ArgumentError('semi;colon must be at most 10 characters');
    if (!(with_space >= 1)) throw ArgumentError('with space must be >= 1');
  }

  factory Sample_Type__x___.fromJson(Map<String, dynamic> json) {
    return Sample_Type__x___(
      run___error__x________id: json['run { error("x") } || id'] as String,
      $_unnamed: json['\$'] as String?,
      $__x_: json['\${x}'] as String?,
      $__y_: json['\\(y)'] as String?,
      $__unnamed: json['*/'] as String?,
      q_uote: json['q"uote'] as String?,
      s_ingle: json['s\'ingle'] as String?,
      semi_colon: json['semi;colon'] as String,
      back_tick: json['back`tick'] as String?,
      new_line: json['new\nline'] as String?,
      with_space: (json['with space'] as num).toInt(),
      $9lives: json['9lives'] as bool?,
      kind: json['kind'] != null ? Sample_Type__x___Kind.fromJson(json['kind'] as String) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'run { error("x") } || id': run___error__x________id,
      if ($_unnamed != null) '\$': $_unnamed,
      if ($__x_ != null) '\${x}': $__x_,
      if ($__y_ != null) '\\(y)': $__y_,
      if ($__unnamed != null) '*/': $__unnamed,
      if (q_uote != null) 'q"uote': q_uote,
      if (s_ingle != null) 's\'ingle': s_ingle,
      'semi;colon': semi_colon,
      if (back_tick != null) 'back`tick': back_tick,
      if (new_line != null) 'new\nline': new_line,
      'with space': with_space,
      if ($9lives != null) '9lives': $9lives,
      if (kind != null) 'kind': kind?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Sample_Type__x___ &&
          run___error__x________id == other.run___error__x________id &&
          $_unnamed == other.$_unnamed &&
          $__x_ == other.$__x_ &&
          $__y_ == other.$__y_ &&
          $__unnamed == other.$__unnamed &&
          q_uote == other.q_uote &&
          s_ingle == other.s_ingle &&
          semi_colon == other.semi_colon &&
          back_tick == other.back_tick &&
          new_line == other.new_line &&
          with_space == other.with_space &&
          $9lives == other.$9lives &&
          kind == other.kind;

  @override
  int get hashCode => Object.hash(run___error__x________id, $_unnamed, $__x_, $__y_, $__unnamed, q_uote, s_ingle, semi_colon, back_tick, new_line, with_space, $9lives, kind);

  @override
  String toString() => 'Sample_Type__x___(run___error__x________id: $run___error__x________id, \$_unnamed: ${$_unnamed}, \$__x_: ${$__x_}, \$__y_: ${$__y_}, \$__unnamed: ${$__unnamed}, q_uote: $q_uote, s_ingle: $s_ingle, semi_colon: $semi_colon, back_tick: $back_tick, new_line: $new_line, with_space: $with_space, \$9lives: ${$9lives}, kind: $kind)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Sample_Type__x___> get_Sample__x({required String run___error__xParam________p, required Sample_Type__x___ item, int? opt_ional_}) async {
    final params = <String, dynamic>{
      'run { error("xParam") } || p': run___error__xParam________p,
      'item': item.toJson(),
      if (opt_ional_ != null) 'opt;ional\n': opt_ional_,
    };
    final result = await _client.call('api.get"Sample`;x', params);
    return Sample_Type__x___.fromJson(result as Map<String, dynamic>);
  }
}


sealed class NsDo_ActionInput {
  const NsDo_ActionInput();
  Map<String, dynamic> toJson();
  static NsDo_ActionInput fromJson(Map<String, dynamic> json) {
    switch (json['ty pe'] as String) {
      case 'cre"ate': return Cre_ateInput.fromJson(json);
      case 're`move': return Re_moveInput.fromJson(json);
      default: throw ArgumentError('Unknown ty pe: ${json['ty pe']}');
    }
  }
}

class Cre_ateInput extends NsDo_ActionInput {
  final String ti_tle;

  const Cre_ateInput({
    required this.ti_tle,
  });

  factory Cre_ateInput.fromJson(Map<String, dynamic> json) {
    return Cre_ateInput(
      ti_tle: json['ti;tle'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'ty pe': 'cre"ate',
      'ti;tle': ti_tle,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Cre_ateInput &&
          ti_tle == other.ti_tle;

  @override
  int get hashCode => ti_tle.hashCode;

  @override
  String toString() => 'Cre_ateInput(ti_tle: $ti_tle)';
}

class Re_moveInput extends NsDo_ActionInput {
  final String $__id_;

  const Re_moveInput({
    required this.$__id_,
  });

  factory Re_moveInput.fromJson(Map<String, dynamic> json) {
    return Re_moveInput(
      $__id_: json['\${id}'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'ty pe': 're`move',
      '\${id}': $__id_,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Re_moveInput &&
          $__id_ == other.$__id_;

  @override
  int get hashCode => $__id_.hashCode;

  @override
  String toString() => 'Re_moveInput(\$__id_: ${$__id_})';
}



class DoActionResult {
  final bool ok_;

  const DoActionResult({
    required this.ok_,
  });

  factory DoActionResult.fromJson(Map<String, dynamic> json) {
    return DoActionResult(
      ok_: json['ok`'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'ok`': ok_,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DoActionResult &&
          ok_ == other.ok_;

  @override
  int get hashCode => ok_.hashCode;

  @override
  String toString() => 'DoActionResult(ok_: $ok_)';
}


class NsApi {
  final BlocksClient _client;
  NsApi(this._client);

  Future<DoActionResult> do_Action({required NsDo_ActionInput input}) async {
    final params = <String, dynamic>{
      'input': input.toJson(),
    };
    final result = await _client.call('ns.do`Action', params);
    return DoActionResult.fromJson(result as Map<String, dynamic>);
  }
}


// --- Servers ---

class Servers {
  static const String main___val_x___1___ = 'https://example.com';
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;
  late final NsApi ns;

  Blocks({String? baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl ?? Servers.main___val_x___1___, sessionStore: sessionStore);
    api = ApiApi(client);
    ns = NsApi(client);
  }
}

