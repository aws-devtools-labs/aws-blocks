// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;
export 'package:blocks_runtime/blocks_runtime.dart' show OidcClient, OidcAuthState, OidcSignedIn, OidcSignedOut, OidcLoading, OidcUser, TokenStore, InMemoryTokenStore, AuthProvider, BrowserLauncher, ProviderConfig;

// --- Models ---

class SignInOption {
  final String label;
  final OidcClient client;

  const SignInOption({
    required this.label,
    required this.client,
  });

  factory SignInOption.fromJson(Map<String, dynamic> json, BlocksClient client) {
    return SignInOption(
      label: json['label'] as String,
      client: OidcClient.fromJson(json['client'] as Map<String, dynamic>, baseUrl: client.baseUrl, tokenStore: client.tokenStore, sessionStore: client.sessionStore),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'label': label,
      'client': client.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignInOption &&
          label == other.label &&
          client == other.client;

  @override
  int get hashCode => Object.hash(label, client);

  @override
  String toString() => 'SignInOption(label: $label, client: $client)';
}


// --- API Namespaces ---

enum Level {
  low,
  high
;

  String toJson() => name;
  static Level fromJson(String json) => values.byName(json);
}


class Note {
  final String id;
  final String body;

  const Note({
    required this.id,
    required this.body,
  });

  factory Note.fromJson(Map<String, dynamic> json) {
    return Note(
      id: json['id'] as String,
      body: json['body'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'body': body,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Note &&
          id == other.id &&
          body == other.body;

  @override
  int get hashCode => Object.hash(id, body);

  @override
  String toString() => 'Note(id: $id, body: $body)';
}


class Layout {
  final Map<String, List<String>> tagsByUser;
  final Map<String, List<int>>? scoresByUser;
  final Map<String, List<Note>> notesByTag;
  final List<Map<String, Note>> pages;
  final List<List<Note>> grid;
  final List<List<int>> matrix;
  final List<Level> levels;
  final Map<String, List<Level>>? levelsByUser;
  final Map<String, Map<String, Level>> nestedLevels;
  final List<Note?> maybeNotes;

  const Layout({
    required this.tagsByUser,
    this.scoresByUser,
    required this.notesByTag,
    required this.pages,
    required this.grid,
    required this.matrix,
    required this.levels,
    this.levelsByUser,
    required this.nestedLevels,
    required this.maybeNotes,
  });

  factory Layout.fromJson(Map<String, dynamic> json) {
    return Layout(
      tagsByUser: (json['tagsByUser'] as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as List<dynamic>).cast<String>())),
      scoresByUser: (json['scoresByUser'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, (v as List<dynamic>).cast<int>())),
      notesByTag: (json['notesByTag'] as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as List<dynamic>).map((e1) => Note.fromJson(e1 as Map<String, dynamic>)).toList())),
      pages: (json['pages'] as List<dynamic>).map((e) => (e as Map<String, dynamic>).map((k1, v1) => MapEntry(k1, Note.fromJson(v1 as Map<String, dynamic>)))).toList(),
      grid: (json['grid'] as List<dynamic>).map((e) => (e as List<dynamic>).map((e1) => Note.fromJson(e1 as Map<String, dynamic>)).toList()).toList(),
      matrix: (json['matrix'] as List<dynamic>).map((e) => (e as List<dynamic>).cast<int>()).toList(),
      levels: (json['levels'] as List<dynamic>).map((e) => Level.fromJson(e as String)).toList(),
      levelsByUser: (json['levelsByUser'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, (v as List<dynamic>).map((e1) => Level.fromJson(e1 as String)).toList())),
      nestedLevels: (json['nestedLevels'] as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as Map<String, dynamic>).map((k1, v1) => MapEntry(k1, Level.fromJson(v1 as String))))),
      maybeNotes: (json['maybeNotes'] as List<dynamic>).map((e) => e == null ? null : Note.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'tagsByUser': tagsByUser,
      if (scoresByUser != null) 'scoresByUser': scoresByUser,
      'notesByTag': notesByTag.map((k, v) => MapEntry(k, v.map((e1) => e1.toJson()).toList())),
      'pages': pages.map((e) => e.map((k1, v1) => MapEntry(k1, v1.toJson()))).toList(),
      'grid': grid.map((e) => e.map((e1) => e1.toJson()).toList()).toList(),
      'matrix': matrix,
      'levels': levels.map((e) => e.toJson()).toList(),
      if (levelsByUser != null) 'levelsByUser': levelsByUser?.map((k, v) => MapEntry(k, v.map((e1) => e1.toJson()).toList())),
      'nestedLevels': nestedLevels.map((k, v) => MapEntry(k, v.map((k1, v1) => MapEntry(k1, v1.toJson())))),
      'maybeNotes': maybeNotes.map((e) => e?.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Layout &&
          blocksDeepEquals(tagsByUser, other.tagsByUser) &&
          blocksDeepEquals(scoresByUser, other.scoresByUser) &&
          blocksDeepEquals(notesByTag, other.notesByTag) &&
          blocksDeepEquals(pages, other.pages) &&
          blocksDeepEquals(grid, other.grid) &&
          blocksDeepEquals(matrix, other.matrix) &&
          blocksDeepEquals(levels, other.levels) &&
          blocksDeepEquals(levelsByUser, other.levelsByUser) &&
          blocksDeepEquals(nestedLevels, other.nestedLevels) &&
          blocksDeepEquals(maybeNotes, other.maybeNotes);

  @override
  int get hashCode => Object.hash(blocksDeepHash(tagsByUser), blocksDeepHash(scoresByUser), blocksDeepHash(notesByTag), blocksDeepHash(pages), blocksDeepHash(grid), blocksDeepHash(matrix), blocksDeepHash(levels), blocksDeepHash(levelsByUser), blocksDeepHash(nestedLevels), blocksDeepHash(maybeNotes));

  @override
  String toString() => 'Layout(tagsByUser: $tagsByUser, scoresByUser: $scoresByUser, notesByTag: $notesByTag, pages: $pages, grid: $grid, matrix: $matrix, levels: $levels, levelsByUser: $levelsByUser, nestedLevels: $nestedLevels, maybeNotes: $maybeNotes)';
}


class Board {
  final String title;
  final List<RealtimeChannel<Note>> channels;
  final List<RealtimeChannel<List<String>>>? tagFeeds;
  final Map<String, RealtimeChannel<Note>> feedsByRoom;
  final List<FileDownloadHandle> downloads;
  final Layout layout;

  const Board({
    required this.title,
    required this.channels,
    this.tagFeeds,
    required this.feedsByRoom,
    required this.downloads,
    required this.layout,
  });

  factory Board.fromJson(Map<String, dynamic> json) {
    return Board(
      title: json['title'] as String,
      channels: (json['channels'] as List<dynamic>).map((e) => RealtimeChannel.fromJson(e as Map<String, dynamic>, (json) => Note.fromJson(json))).toList(),
      tagFeeds: (json['tagFeeds'] as List<dynamic>?)?.map((e) => RealtimeChannel.fromJsonValue(e as Map<String, dynamic>, (payload) => (payload as List<dynamic>).cast<String>())).toList(),
      feedsByRoom: (json['feedsByRoom'] as Map<String, dynamic>).map((k, v) => MapEntry(k, RealtimeChannel.fromJson(v as Map<String, dynamic>, (json) => Note.fromJson(json)))),
      downloads: (json['downloads'] as List<dynamic>).map((e) => FileDownloadHandle.fromJson(e as Map<String, dynamic>)).toList(),
      layout: Layout.fromJson(json['layout'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'title': title,
      'channels': channels.map((e) => e.toJson()).toList(),
      if (tagFeeds != null) 'tagFeeds': tagFeeds?.map((e) => e.toJson()).toList(),
      'feedsByRoom': feedsByRoom.map((k, v) => MapEntry(k, v.toJson())),
      'downloads': downloads.map((e) => e.toJson()).toList(),
      'layout': layout.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Board &&
          title == other.title &&
          blocksDeepEquals(channels, other.channels) &&
          blocksDeepEquals(tagFeeds, other.tagFeeds) &&
          blocksDeepEquals(feedsByRoom, other.feedsByRoom) &&
          blocksDeepEquals(downloads, other.downloads) &&
          layout == other.layout;

  @override
  int get hashCode => Object.hash(title, blocksDeepHash(channels), blocksDeepHash(tagFeeds), blocksDeepHash(feedsByRoom), blocksDeepHash(downloads), layout);

  @override
  String toString() => 'Board(title: $title, channels: $channels, tagFeeds: $tagFeeds, feedsByRoom: $feedsByRoom, downloads: $downloads, layout: $layout)';
}


class LoginMenu {
  final SignInOption primary;
  final List<SignInOption> options;
  final OidcClient? fallback;

  const LoginMenu({
    required this.primary,
    required this.options,
    this.fallback,
  });

  factory LoginMenu.fromJson(Map<String, dynamic> json, BlocksClient client) {
    return LoginMenu(
      primary: SignInOption.fromJson(json['primary'] as Map<String, dynamic>, client),
      options: (json['options'] as List<dynamic>).map((e) => SignInOption.fromJson(e as Map<String, dynamic>, client)).toList(),
      fallback: json['fallback'] != null ? OidcClient.fromJson(json['fallback'] as Map<String, dynamic>, baseUrl: client.baseUrl, tokenStore: client.tokenStore, sessionStore: client.sessionStore) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'primary': primary.toJson(),
      'options': options.map((e) => e.toJson()).toList(),
      if (fallback != null) 'fallback': fallback?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is LoginMenu &&
          primary == other.primary &&
          blocksDeepEquals(options, other.options) &&
          fallback == other.fallback;

  @override
  int get hashCode => Object.hash(primary, blocksDeepHash(options), fallback);

  @override
  String toString() => 'LoginMenu(primary: $primary, options: $options, fallback: $fallback)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Board> getBoard() async {
    final result = await _client.call('api.getBoard', const <dynamic>[]);
    return Board.fromJson(result as Map<String, dynamic>);
  }

  Future<Layout> saveLayout({required Layout layout}) async {
    final params = <dynamic>[
      layout.toJson(),
    ];
    final result = await _client.call('api.saveLayout', params);
    return Layout.fromJson(result as Map<String, dynamic>);
  }

  Future<Map<String, List<Note>>> groupNotes({required Map<String, List<Note>> groups, List<Level>? levels}) async {
    final params = <dynamic>[
      groups.map((k, v) => MapEntry(k, v.map((e1) => e1.toJson()).toList())),
      if (levels != null) levels.map((e) => e.toJson()).toList(),
    ];
    final result = await _client.call('api.groupNotes', params);
    return (result as Map<String, dynamic>).map((k, v) => MapEntry(k, (v as List<dynamic>).map((e1) => Note.fromJson(e1 as Map<String, dynamic>)).toList()));
  }

  Future<List<RealtimeChannel<Note>>> listFeeds() async {
    final result = await _client.call('api.listFeeds', const <dynamic>[]);
    return (result as List<dynamic>).map((e) => RealtimeChannel.fromJson(e as Map<String, dynamic>, (json) => Note.fromJson(json))).toList();
  }

  Future<LoginMenu> getLoginMenu() async {
    final result = await _client.call('api.getLoginMenu', const <dynamic>[]);
    return LoginMenu.fromJson(result as Map<String, dynamic>, _client);
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

