// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// Requires blocks_runtime 0.1.5 or later.
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;
export 'package:blocks_runtime/blocks_runtime.dart' show OidcClient, OidcAuthState, OidcSignedIn, OidcSignedOut, OidcLoading, OidcUser, TokenStore, InMemoryTokenStore, AuthProvider, BrowserLauncher, ProviderConfig;

// --- Models ---

class Note {
  final String id;
  final String text;

  const Note({
    required this.id,
    required this.text,
  });

  factory Note.fromJson(Map<String, dynamic> json) {
    return Note(
      id: json['id'] as String,
      text: json['text'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'text': text,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Note &&
          id == other.id &&
          text == other.text;

  @override
  int get hashCode => Object.hash(id, text);

  @override
  String toString() => 'Note(id: $id, text: $text)';
}


class Attachment {
  final String name;
  final FileDownloadHandle file;
  final List<FileDownloadHandle> previews;

  const Attachment({
    required this.name,
    required this.file,
    required this.previews,
  });

  factory Attachment.fromJson(Map<String, dynamic> json) {
    return Attachment(
      name: json['name'] as String,
      file: FileDownloadHandle.fromJson(json['file'] as Map<String, dynamic>),
      previews: (json['previews'] as List<dynamic>).map((e) => FileDownloadHandle.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'file': file.toJson(),
      'previews': previews.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Attachment &&
          name == other.name &&
          file == other.file &&
          blocksDeepEquals(previews, other.previews);

  @override
  int get hashCode => Object.hash(name, file, blocksDeepHash(previews));

  @override
  String toString() => 'Attachment(name: $name, file: $file, previews: $previews)';
}


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


class GetChatFeedResultChannelMessage {
  final String text;

  const GetChatFeedResultChannelMessage({
    required this.text,
  });

  factory GetChatFeedResultChannelMessage.fromJson(Map<String, dynamic> json) {
    return GetChatFeedResultChannelMessage(
      text: json['text'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'text': text,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetChatFeedResultChannelMessage &&
          text == other.text;

  @override
  int get hashCode => text.hashCode;

  @override
  String toString() => 'GetChatFeedResultChannelMessage(text: $text)';
}


class GetCounterFeedResultChannelMessage {
  final num count;

  const GetCounterFeedResultChannelMessage({
    required this.count,
  });

  factory GetCounterFeedResultChannelMessage.fromJson(Map<String, dynamic> json) {
    return GetCounterFeedResultChannelMessage(
      count: json['count'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'count': count,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetCounterFeedResultChannelMessage &&
          count == other.count;

  @override
  int get hashCode => count.hashCode;

  @override
  String toString() => 'GetCounterFeedResultChannelMessage(count: $count)';
}


// --- API Namespaces ---

class Lobby {
  final RealtimeChannel<List<RealtimeChannel<Note>>> rooms;
  final List<RealtimeChannel<List<RealtimeChannel<Note>>>> roomGroups;
  final Map<String, RealtimeChannel<FileUploadHandle>> uploadsByRoom;

  const Lobby({
    required this.rooms,
    required this.roomGroups,
    required this.uploadsByRoom,
  });

  factory Lobby.fromJson(Map<String, dynamic> json) {
    return Lobby(
      rooms: RealtimeChannel.fromJsonValue(json['rooms'] as Map<String, dynamic>, (payload) => (payload as List<dynamic>).map((e1) => RealtimeChannel.fromJson(e1 as Map<String, dynamic>, (json) => Note.fromJson(json))).toList()),
      roomGroups: (json['roomGroups'] as List<dynamic>).map((e) => RealtimeChannel.fromJsonValue(e as Map<String, dynamic>, (payload) => (payload as List<dynamic>).map((e2) => RealtimeChannel.fromJson(e2 as Map<String, dynamic>, (json) => Note.fromJson(json))).toList())).toList(),
      uploadsByRoom: (json['uploadsByRoom'] as Map<String, dynamic>).map((k, v) => MapEntry(k, RealtimeChannel.fromJsonValue(v as Map<String, dynamic>, (payload) => FileUploadHandle.fromJson(payload as Map<String, dynamic>)))),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'rooms': rooms.toJson(),
      'roomGroups': roomGroups.map((e) => e.toJson()).toList(),
      'uploadsByRoom': uploadsByRoom.map((k, v) => MapEntry(k, v.toJson())),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Lobby &&
          rooms == other.rooms &&
          blocksDeepEquals(roomGroups, other.roomGroups) &&
          blocksDeepEquals(uploadsByRoom, other.uploadsByRoom);

  @override
  int get hashCode => Object.hash(rooms, blocksDeepHash(roomGroups), blocksDeepHash(uploadsByRoom));

  @override
  String toString() => 'Lobby(rooms: $rooms, roomGroups: $roomGroups, uploadsByRoom: $uploadsByRoom)';
}


class SignInBoard {
  final List<RealtimeChannel<SignInOption>> feeds;
  final Map<String, RealtimeChannel<List<OidcClient>>> clientsByTenant;

  const SignInBoard({
    required this.feeds,
    required this.clientsByTenant,
  });

  factory SignInBoard.fromJson(Map<String, dynamic> json, BlocksClient client) {
    return SignInBoard(
      feeds: (json['feeds'] as List<dynamic>).map((e) => RealtimeChannel.fromJson(e as Map<String, dynamic>, (json) => SignInOption.fromJson(json, client))).toList(),
      clientsByTenant: (json['clientsByTenant'] as Map<String, dynamic>).map((k, v) => MapEntry(k, RealtimeChannel.fromJsonValue(v as Map<String, dynamic>, (payload) => (payload as List<dynamic>).map((e2) => OidcClient.fromJson(e2 as Map<String, dynamic>, baseUrl: client.baseUrl, tokenStore: client.tokenStore, sessionStore: client.sessionStore)).toList()))),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'feeds': feeds.map((e) => e.toJson()).toList(),
      'clientsByTenant': clientsByTenant.map((k, v) => MapEntry(k, v.toJson())),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignInBoard &&
          blocksDeepEquals(feeds, other.feeds) &&
          blocksDeepEquals(clientsByTenant, other.clientsByTenant);

  @override
  int get hashCode => Object.hash(blocksDeepHash(feeds), blocksDeepHash(clientsByTenant));

  @override
  String toString() => 'SignInBoard(feeds: $feeds, clientsByTenant: $clientsByTenant)';
}


class ProviderDirectory {
  final String title;
  final Map<String, OidcClient> additionalProperties;

  const ProviderDirectory({
    required this.title,
    this.additionalProperties = const {},
  });

  factory ProviderDirectory.fromJson(Map<String, dynamic> json, BlocksClient client) {
    const knownKeys = {'title'};
    return ProviderDirectory(
      title: json['title'] as String,
      additionalProperties: Map.fromEntries(
        json.entries.where((e) => !knownKeys.contains(e.key))
            .map((e) => MapEntry(e.key, OidcClient.fromJson(e.value as Map<String, dynamic>, baseUrl: client.baseUrl, tokenStore: client.tokenStore, sessionStore: client.sessionStore))),
      ),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'title': title,
      for (final e in additionalProperties.entries)
        if (!const {'title'}.contains(e.key)) e.key: e.value.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ProviderDirectory &&
          title == other.title &&
          blocksDeepEquals(additionalProperties, other.additionalProperties);

  @override
  int get hashCode => Object.hash(title, blocksDeepHash(additionalProperties));

  @override
  String toString() => 'ProviderDirectory(title: $title, additionalProperties: $additionalProperties)';
}


class GetChatFeedResult {
  final RealtimeChannel<GetChatFeedResultChannelMessage> channel;

  const GetChatFeedResult({
    required this.channel,
  });

  factory GetChatFeedResult.fromJson(Map<String, dynamic> json) {
    return GetChatFeedResult(
      channel: RealtimeChannel.fromJson(json['channel'] as Map<String, dynamic>, (json) => GetChatFeedResultChannelMessage.fromJson(json)),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'channel': channel.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetChatFeedResult &&
          channel == other.channel;

  @override
  int get hashCode => channel.hashCode;

  @override
  String toString() => 'GetChatFeedResult(channel: $channel)';
}


class GetCounterFeedResult {
  final RealtimeChannel<GetCounterFeedResultChannelMessage> channel;

  const GetCounterFeedResult({
    required this.channel,
  });

  factory GetCounterFeedResult.fromJson(Map<String, dynamic> json) {
    return GetCounterFeedResult(
      channel: RealtimeChannel.fromJson(json['channel'] as Map<String, dynamic>, (json) => GetCounterFeedResultChannelMessage.fromJson(json)),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'channel': channel.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetCounterFeedResult &&
          channel == other.channel;

  @override
  int get hashCode => channel.hashCode;

  @override
  String toString() => 'GetCounterFeedResult(channel: $channel)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<RealtimeChannel<Attachment>> getAttachmentFeed() async {
    final result = await _client.call('api.getAttachmentFeed', const <dynamic>[]);
    return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => Attachment.fromJson(json));
  }

  Future<RealtimeChannel<List<FileDownloadHandle>>> getDownloadFeed() async {
    final result = await _client.call('api.getDownloadFeed', const <dynamic>[]);
    return RealtimeChannel.fromJsonValue(result as Map<String, dynamic>, (payload) => (payload as List<dynamic>).map((e1) => FileDownloadHandle.fromJson(e1 as Map<String, dynamic>)).toList());
  }

  Future<GetChatFeedResult> getChatFeed() async {
    final result = await _client.call('api.getChatFeed', const <dynamic>[]);
    return GetChatFeedResult.fromJson(result as Map<String, dynamic>);
  }

  Future<GetCounterFeedResult> getCounterFeed() async {
    final result = await _client.call('api.getCounterFeed', const <dynamic>[]);
    return GetCounterFeedResult.fromJson(result as Map<String, dynamic>);
  }

  Future<Lobby> getLobby() async {
    final result = await _client.call('api.getLobby', const <dynamic>[]);
    return Lobby.fromJson(result as Map<String, dynamic>);
  }

  Future<RealtimeChannel<SignInOption>> getSignInFeed() async {
    final result = await _client.call('api.getSignInFeed', const <dynamic>[]);
    return RealtimeChannel.fromJson(result as Map<String, dynamic>, (json) => SignInOption.fromJson(json, _client));
  }

  Future<SignInBoard> getSignInBoard() async {
    final result = await _client.call('api.getSignInBoard', const <dynamic>[]);
    return SignInBoard.fromJson(result as Map<String, dynamic>, _client);
  }

  Future<ProviderDirectory> getProviderDirectory() async {
    final result = await _client.call('api.getProviderDirectory', const <dynamic>[]);
    return ProviderDirectory.fromJson(result as Map<String, dynamic>, _client);
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

