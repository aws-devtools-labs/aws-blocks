// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class GetSessionResultChannelMessage {
  final String text;

  const GetSessionResultChannelMessage({
    required this.text,
  });

  factory GetSessionResultChannelMessage.fromJson(Map<String, dynamic> json) {
    return GetSessionResultChannelMessage(
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
      other is GetSessionResultChannelMessage &&
          text == other.text;

  @override
  int get hashCode => text.hashCode;

  @override
  String toString() => 'GetSessionResultChannelMessage(text: $text)';
}


class CountResult {
  final int count;

  const CountResult({
    required this.count,
  });

  factory CountResult.fromJson(Map<String, dynamic> json) {
    return CountResult(
      count: (json['count'] as num).toInt(),
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
      other is CountResult &&
          count == other.count;

  @override
  int get hashCode => count.hashCode;

  @override
  String toString() => 'CountResult(count: $count)';
}


class MessageGetSessionResultEventChannelMessage {
  final String body;

  const MessageGetSessionResultEventChannelMessage({
    required this.body,
  });

  factory MessageGetSessionResultEventChannelMessage.fromJson(Map<String, dynamic> json) {
    return MessageGetSessionResultEventChannelMessage(
      body: json['body'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'body': body,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MessageGetSessionResultEventChannelMessage &&
          body == other.body;

  @override
  int get hashCode => body.hashCode;

  @override
  String toString() => 'MessageGetSessionResultEventChannelMessage(body: $body)';
}


class PresenceGetSessionResultEventChannelMessage {
  final bool online;

  const PresenceGetSessionResultEventChannelMessage({
    required this.online,
  });

  factory PresenceGetSessionResultEventChannelMessage.fromJson(Map<String, dynamic> json) {
    return PresenceGetSessionResultEventChannelMessage(
      online: json['online'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'online': online,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PresenceGetSessionResultEventChannelMessage &&
          online == other.online;

  @override
  int get hashCode => online.hashCode;

  @override
  String toString() => 'PresenceGetSessionResultEventChannelMessage(online: $online)';
}


sealed class GetSessionResultEvent {
  const GetSessionResultEvent();
  Map<String, dynamic> toJson();
  static GetSessionResultEvent fromJson(Map<String, dynamic> json) {
    switch (json['kind'] as String) {
      case 'message': return MessageGetSessionResultEvent.fromJson(json);
      case 'presence': return PresenceGetSessionResultEvent.fromJson(json);
      default: throw ArgumentError('Unknown kind: ${json['kind']}');
    }
  }
}

class MessageGetSessionResultEvent extends GetSessionResultEvent {
  final RealtimeChannel<MessageGetSessionResultEventChannelMessage> channel;

  const MessageGetSessionResultEvent({
    required this.channel,
  });

  factory MessageGetSessionResultEvent.fromJson(Map<String, dynamic> json) {
    return MessageGetSessionResultEvent(
      channel: json['channel'],
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'kind': 'message',
      'channel': channel,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MessageGetSessionResultEvent &&
          channel == other.channel;

  @override
  int get hashCode => channel.hashCode;

  @override
  String toString() => 'MessageGetSessionResultEvent(channel: $channel)';
}

class PresenceGetSessionResultEvent extends GetSessionResultEvent {
  final RealtimeChannel<PresenceGetSessionResultEventChannelMessage> channel;

  const PresenceGetSessionResultEvent({
    required this.channel,
  });

  factory PresenceGetSessionResultEvent.fromJson(Map<String, dynamic> json) {
    return PresenceGetSessionResultEvent(
      channel: json['channel'],
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'kind': 'presence',
      'channel': channel,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PresenceGetSessionResultEvent &&
          channel == other.channel;

  @override
  int get hashCode => channel.hashCode;

  @override
  String toString() => 'PresenceGetSessionResultEvent(channel: $channel)';
}



// --- API Namespaces ---

class GetSessionResultInner {
  final RealtimeChannel<CountResult> channel;

  const GetSessionResultInner({
    required this.channel,
  });

  factory GetSessionResultInner.fromJson(Map<String, dynamic> json) {
    return GetSessionResultInner(
      channel: json['channel'],
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'channel': channel,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetSessionResultInner &&
          channel == other.channel;

  @override
  int get hashCode => channel.hashCode;

  @override
  String toString() => 'GetSessionResultInner(channel: $channel)';
}


class GetSessionResult {
  final String sessionId;
  final RealtimeChannel<GetSessionResultChannelMessage> channel;
  final GetSessionResultInner inner;
  final GetSessionResultEvent event;
  final RealtimeChannel<List<String>> stringValues;
  final RealtimeChannel<List<int>> integerValues;

  const GetSessionResult({
    required this.sessionId,
    required this.channel,
    required this.inner,
    required this.event,
    required this.stringValues,
    required this.integerValues,
  });

  factory GetSessionResult.fromJson(Map<String, dynamic> json) {
    return GetSessionResult(
      sessionId: json['sessionId'] as String,
      channel: json['channel'],
      inner: GetSessionResultInner.fromJson(json['inner'] as Map<String, dynamic>),
      event: GetSessionResultEvent.fromJson(json['event'] as Map<String, dynamic>),
      stringValues: json['stringValues'],
      integerValues: json['integerValues'],
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'sessionId': sessionId,
      'channel': channel,
      'inner': inner.toJson(),
      'event': event.toJson(),
      'stringValues': stringValues,
      'integerValues': integerValues,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetSessionResult &&
          sessionId == other.sessionId &&
          channel == other.channel &&
          inner == other.inner &&
          event == other.event &&
          stringValues == other.stringValues &&
          integerValues == other.integerValues;

  @override
  int get hashCode => Object.hash(sessionId, channel, inner, event, stringValues, integerValues);

  @override
  String toString() => 'GetSessionResult(sessionId: $sessionId, channel: $channel, inner: $inner, event: $event, stringValues: $stringValues, integerValues: $integerValues)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<GetSessionResult> getSession() async {
    final result = await _client.call('api.getSession', <String, dynamic>{});
    return GetSessionResult.fromJson(result as Map<String, dynamic>);
  }

  Future<GetSessionResultInner> getOtherSession() async {
    final result = await _client.call('api.getOtherSession', <String, dynamic>{});
    return GetSessionResultInner.fromJson(result as Map<String, dynamic>);
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

