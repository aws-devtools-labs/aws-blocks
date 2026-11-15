// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 0.1.5 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

enum SampleType$XKind {
  aB,
  cD,
  xY,
  newLine,
  $X,
  Z,
  $,
  $1st,
  SpAce
;

  static const _jsonMap = <String, SampleType$XKind>{
    'a"b': aB,
    'c;d': cD,
    'x`y': xY,
    'new\nline': newLine,
    '\${x}': $X,
    '\\(z)': Z,
    '*/': $,
    '1st': $1st,
    ' sp ace': SpAce,
  };
  static const _toJsonMap = <SampleType$XKind, String>{
    aB: 'a"b',
    cD: 'c;d',
    xY: 'x`y',
    newLine: 'new\nline',
    $X: '\${x}',
    Z: '\\(z)',
    $: '*/',
    $1st: '1st',
    SpAce: ' sp ace',
  };
  String toJson() => _toJsonMap[this]!;
  static SampleType$XKind fromJson(String json) => _jsonMap[json]!;
}


// --- API Namespaces ---

class SampleType$X {
  final String runErrorXId;
  final String? $;
  final String? $X;
  final String? Y;
  final String? $$;
  final String? qUote;
  final String? sIngle;
  final String semiColon;
  final String? backTick;
  final String? newLine;
  final int withSpace;
  final bool? $9lives;
  final SampleType$XKind? kind;

  SampleType$X({
    required this.runErrorXId,
    this.$,
    this.$X,
    this.Y,
    this.$$,
    this.qUote,
    this.sIngle,
    required this.semiColon,
    this.backTick,
    this.newLine,
    required this.withSpace,
    this.$9lives,
    this.kind,
  }) {
    if (!(runErrorXId.length >= 2)) throw ArgumentError('runErrorXId must be at least 2 characters');
    if (!(semiColon.length <= 10)) throw ArgumentError('semiColon must be at most 10 characters');
    if (!(withSpace >= 1)) throw ArgumentError('withSpace must be >= 1');
  }

  factory SampleType$X.fromJson(Map<String, dynamic> json) {
    return SampleType$X(
      runErrorXId: json['run { error("x") } || id'] as String,
      $: json['\$'] as String?,
      $X: json['\${x}'] as String?,
      Y: json['\\(y)'] as String?,
      $$: json['*/'] as String?,
      qUote: json['q"uote'] as String?,
      sIngle: json['s\'ingle'] as String?,
      semiColon: json['semi;colon'] as String,
      backTick: json['back`tick'] as String?,
      newLine: json['new\nline'] as String?,
      withSpace: (json['with space'] as num).toInt(),
      $9lives: json['9lives'] as bool?,
      kind: json['kind'] != null ? SampleType$XKind.fromJson(json['kind'] as String) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'run { error("x") } || id': runErrorXId,
      if ($ != null) '\$': $,
      if ($X != null) '\${x}': $X,
      if (Y != null) '\\(y)': Y,
      if ($$ != null) '*/': $$,
      if (qUote != null) 'q"uote': qUote,
      if (sIngle != null) 's\'ingle': sIngle,
      'semi;colon': semiColon,
      if (backTick != null) 'back`tick': backTick,
      if (newLine != null) 'new\nline': newLine,
      'with space': withSpace,
      if ($9lives != null) '9lives': $9lives,
      if (kind != null) 'kind': kind?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SampleType$X &&
          runErrorXId == other.runErrorXId &&
          $ == other.$ &&
          $X == other.$X &&
          Y == other.Y &&
          $$ == other.$$ &&
          qUote == other.qUote &&
          sIngle == other.sIngle &&
          semiColon == other.semiColon &&
          backTick == other.backTick &&
          newLine == other.newLine &&
          withSpace == other.withSpace &&
          $9lives == other.$9lives &&
          kind == other.kind;

  @override
  int get hashCode => Object.hash(runErrorXId, $, $X, Y, $$, qUote, sIngle, semiColon, backTick, newLine, withSpace, $9lives, kind);

  @override
  String toString() => 'SampleType\$X(runErrorXId: $runErrorXId, \$: ${$}, \$X: ${$X}, Y: $Y, \$\$: ${$$}, qUote: $qUote, sIngle: $sIngle, semiColon: $semiColon, backTick: $backTick, newLine: $newLine, withSpace: $withSpace, \$9lives: ${$9lives}, kind: $kind)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<SampleType$X> getSampleX({required String runErrorXParamP, required SampleType$X item, int? optIonal}) async {
    final params = <dynamic>[
      runErrorXParamP,
      item.toJson(),
      if (optIonal != null) optIonal,
    ];
    final result = await _client.call('api.get"Sample`;x', params);
    return SampleType$X.fromJson(result as Map<String, dynamic>);
  }
}


sealed class NsDoActionInput {
  const NsDoActionInput();
  Map<String, dynamic> toJson();
  static NsDoActionInput fromJson(Map<String, dynamic> json) {
    switch (json['ty pe'] as String) {
      case 'cre"ate': return CreAteInput.fromJson(json);
      case 're`move': return ReMoveInput.fromJson(json);
      default: throw ArgumentError('Unknown ty pe: ${json['ty pe']}');
    }
  }
}

class CreAteInput extends NsDoActionInput {
  final String tiTle;

  const CreAteInput({
    required this.tiTle,
  });

  factory CreAteInput.fromJson(Map<String, dynamic> json) {
    return CreAteInput(
      tiTle: json['ti;tle'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'ty pe': 'cre"ate',
      'ti;tle': tiTle,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CreAteInput &&
          tiTle == other.tiTle;

  @override
  int get hashCode => tiTle.hashCode;

  @override
  String toString() => 'CreAteInput(tiTle: $tiTle)';
}

class ReMoveInput extends NsDoActionInput {
  final String $Id;

  const ReMoveInput({
    required this.$Id,
  });

  factory ReMoveInput.fromJson(Map<String, dynamic> json) {
    return ReMoveInput(
      $Id: json['\${id}'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'ty pe': 're`move',
      '\${id}': $Id,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ReMoveInput &&
          $Id == other.$Id;

  @override
  int get hashCode => $Id.hashCode;

  @override
  String toString() => 'ReMoveInput(\$Id: ${$Id})';
}



class DoActionResult {
  final bool ok;

  const DoActionResult({
    required this.ok,
  });

  factory DoActionResult.fromJson(Map<String, dynamic> json) {
    return DoActionResult(
      ok: json['ok`'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'ok`': ok,
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


class NsApi {
  final BlocksClient _client;
  NsApi(this._client);

  Future<DoActionResult> doAction({required NsDoActionInput input}) async {
    final params = <dynamic>[
      input.toJson(),
    ];
    final result = await _client.call('ns.do`Action', params);
    return DoActionResult.fromJson(result as Map<String, dynamic>);
  }
}


// --- Servers ---

class Servers {
  static const String mainValX1 = 'https://example.com';
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;
  late final NsApi ns;

  Blocks({String? baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl ?? Servers.mainValX1, sessionStore: sessionStore);
    api = ApiApi(client);
    ns = NsApi(client);
  }
}

