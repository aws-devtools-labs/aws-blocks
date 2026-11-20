// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

/// Calls `ns.method` through a client whose every response is [body] at
/// [status], and returns what the call returned.
Future<Object?> _call(Object body, {int status = 200}) {
  final client = BlocksClient(
    baseUrl: 'http://test/cdk-blocks/api',
    client: MockClient(
      (_) async =>
          http.Response(body is String ? body : jsonEncode(body), status),
    ),
  );
  return client.call('ns.method', []);
}

/// A JSON-RPC error envelope.
Map<String, Object?> _errorEnvelope(
  Object? code,
  String message, [
  Map<String, Object?>? data,
]) => {
  'jsonrpc': '2.0',
  'id': 1,
  'error': {'code': code, 'message': message, 'data': ?data},
};

Matcher _api({
  required int status,
  Object? name = isNull,
  Object? message = anything,
  bool retriable = false,
}) => throwsA(
  isA<ApiException>()
      .having((e) => e.status, 'status', status)
      .having((e) => e.name, 'name', name)
      .having((e) => e.message, 'message', message)
      .having((e) => e.retriable, 'retriable', retriable),
);

Matcher _transport({required Object? statusCode, Object? message = anything}) =>
    throwsA(
      isA<TransportException>()
          .having((e) => e.statusCode, 'statusCode', statusCode)
          .having((e) => e.message, 'message', message),
    );

void main() {
  group('BlocksClient error mapping', () {
    test('error envelope with name and retriable', () async {
      await expectLater(
        _call(
          _errorEnvelope(409, 'Username already taken', {
            'name': 'ConditionalCheckFailedException',
            'retriable': true,
          }),
        ),
        _api(
          status: 409,
          name: 'ConditionalCheckFailedException',
          message: 'Username already taken',
          retriable: true,
        ),
      );
    });

    test('error envelope with a reserved -32602 code', () async {
      await expectLater(
        _call(
          _errorEnvelope(-32602, 'Invalid params', {'name': 'InvalidParams'}),
        ),
        _api(status: 500, name: 'InvalidParams', message: 'Invalid params'),
      );
    });

    test('error envelope with -32601 and no data', () async {
      await expectLater(
        _call(_errorEnvelope(-32601, 'Method not found: ns.method')),
        _api(
          status: 500,
          name: 'MethodNotFound',
          message: 'Method not found: ns.method',
        ),
      );
    });

    test(
      'every reserved code the server leaves unnamed gets its name',
      () async {
        const names = {
          -32700: 'ParseError',
          -32600: 'InvalidRequest',
          -32601: 'MethodNotFound',
          -32602: 'InvalidParams',
          -32603: 'InternalError',
        };
        for (final MapEntry(key: code, value: name) in names.entries) {
          await expectLater(
            _call(_errorEnvelope(code, 'reserved')),
            _api(status: 500, name: name),
            reason: '$code',
          );
        }
      },
    );

    test(
      'a reserved code with a name-less data object gets its name',
      () async {
        await expectLater(
          _call(_errorEnvelope(-32700, 'Parse error', {'detail': 'x'})),
          _api(status: 500, name: 'ParseError'),
        );
      },
    );

    test('error envelope with -32600 and a server-sent name', () async {
      await expectLater(
        _call(
          _errorEnvelope(-32600, 'Invalid Request', {
            'name': 'NamespaceMismatch',
          }),
        ),
        _api(status: 500, name: 'NamespaceMismatch'),
      );
    });

    test('an unreserved negative code gets no name', () async {
      await expectLater(
        _call(_errorEnvelope(-32000, 'Server error')),
        _api(status: 500, name: isNull),
      );
    });

    test('error envelope at HTTP 401 (httpErrorStatus)', () async {
      for (final status in [401, 200]) {
        await expectLater(
          _call(
            _errorEnvelope(401, 'Authentication required', {
              'name': 'NotAuthenticatedException',
            }),
            status: status,
          ),
          _api(
            status: 401,
            name: 'NotAuthenticatedException',
            message: 'Authentication required',
          ),
          reason: 'HTTP $status',
        );
      }
    });

    test('error envelope at HTTP 503 is still an ApiException', () async {
      await expectLater(
        _call(
          _errorEnvelope(503, 'Unavailable', {'name': 'ServiceUnavailable'}),
          status: 503,
        ),
        _api(status: 503, name: 'ServiceUnavailable'),
      );
    });

    test('error envelope, named, no status (branded BB error)', () async {
      await expectLater(
        _call(
          _errorEnvelope(500, 'Key not found', {'name': 'KeyNotFoundError'}),
        ),
        _api(status: 500, name: 'KeyNotFoundError', message: 'Key not found'),
      );
    });

    test('error envelope with no name is a nameless 500', () async {
      await expectLater(
        _call(_errorEnvelope(500, 'Internal error')),
        _api(status: 500, name: isNull, message: 'Internal error'),
      );
    });

    test('retriable is false unless the server sends true', () async {
      for (final data in <Map<String, Object?>?>[
        null,
        {'name': 'WrongCode'},
        {'name': 'WrongCode', 'retriable': false},
        {'name': 'WrongCode', 'retriable': 'true'},
      ]) {
        await expectLater(
          _call(_errorEnvelope(400, 'nope', data)),
          _api(status: 400, name: data == null ? isNull : 'WrongCode'),
          reason: '$data',
        );
      }
    });

    test('a non-int code is reported as 500 with no name', () async {
      await expectLater(
        _call(_errorEnvelope('E1', 'Bad'), status: 400),
        _api(status: 500, name: isNull, message: 'Bad'),
      );
    });

    test('a non-string name and a missing message are ignored', () async {
      await expectLater(
        _call({
          'jsonrpc': '2.0',
          'id': 1,
          'error': {
            'code': 400,
            'data': {'name': 7},
          },
        }),
        _api(status: 400, name: isNull, message: 'Unknown error'),
      );
    });

    test('HTTP 503 with an HTML body', () async {
      await expectLater(
        _call('<html><body>Service Unavailable</body></html>', status: 503),
        _transport(statusCode: 503, message: 'HTTP 503'),
      );
    });

    test('HTTP 404 with a string error (was a TypeError)', () async {
      await expectLater(
        _call({'error': 'Not Found'}, status: 404),
        _transport(statusCode: 404, message: 'Not Found'),
      );
    });

    test('HTTP 403 gateway message (was a null success)', () async {
      await expectLater(
        _call({'message': 'Forbidden'}, status: 403),
        _transport(statusCode: 403, message: 'Forbidden'),
      );
    });

    test('HTTP 502 with an empty body', () async {
      await expectLater(
        _call('', status: 502),
        _transport(statusCode: 502, message: 'HTTP 502'),
      );
    });

    test('HTTP 200 with a non-envelope JSON body', () async {
      for (final body in <Object>[
        {'message': 'ok'},
        {'result': 'no jsonrpc member'},
        [1],
        'null',
      ]) {
        await expectLater(
          _call(body),
          _transport(
            statusCode: 200,
            message: 'Response was not a JSON-RPC envelope',
          ),
          reason: '$body',
        );
      }
    });

    test('HTTP 200 with a body that is not JSON', () async {
      await expectLater(_call('<html>ok</html>'), _transport(statusCode: 200));
    });

    test('HTTP 200 envelope whose error is not an object', () async {
      await expectLater(
        _call({'jsonrpc': '2.0', 'id': 1, 'error': 'boom'}),
        _transport(statusCode: 200),
      );
    });

    test('HTTP 200 envelope with no result is a void success', () async {
      // The server leaves `result` out for a `Promise<void>` method.
      expect(await _call({'jsonrpc': '2.0', 'id': 1}), isNull);
    });

    test('HTTP 200 envelope with a null result is a null success', () async {
      expect(await _call({'jsonrpc': '2.0', 'id': 1, 'result': null}), isNull);
    });

    test('connection refused', () async {
      final refused = http.ClientException('Connection refused');
      final client = BlocksClient(
        baseUrl: 'http://test/cdk-blocks/api',
        client: MockClient((_) async => throw refused),
      );
      await expectLater(
        client.call('ns.method', []),
        throwsA(
          isA<TransportException>()
              .having((e) => e.statusCode, 'statusCode', isNull)
              .having((e) => e.message, 'message', 'Connection refused')
              .having((e) => e.cause, 'cause', same(refused)),
        ),
      );
    });

    test('a timeout is a TransportException with its cause', () async {
      final timeout = TimeoutException('Request stalled');
      final client = BlocksClient(
        baseUrl: 'http://test/cdk-blocks/api',
        client: MockClient((_) async => throw timeout),
      );
      await expectLater(
        client.call('ns.method', []),
        throwsA(
          isA<TransportException>()
              .having((e) => e.statusCode, 'statusCode', isNull)
              .having((e) => e.message, 'message', 'Request stalled')
              .having((e) => e.cause, 'cause', same(timeout)),
        ),
      );
    });

    test('auth provider cancellation passes through unchanged', () async {
      // Cancellation and other errors the runtime already reports pass
      // through as they are.
      final cancelled = OidcCancelledException();
      var sent = false;
      final client = BlocksClient(
        baseUrl: 'http://test/cdk-blocks/api',
        client: MockClient((_) async {
          sent = true;
          return http.Response('{}', 200);
        }),
        authProvider: _ThrowingAuthProvider(cancelled),
      );
      await expectLater(client.call('ns.method', []), throwsA(same(cancelled)));
      expect(sent, isFalse);
    });

    test('HTTP client cancellation passes through unchanged', () async {
      final cancelled = OidcCancelledException();
      final client = BlocksClient(
        baseUrl: 'http://test/cdk-blocks/api',
        client: MockClient((_) async => throw cancelled),
      );
      await expectLater(client.call('ns.method', []), throwsA(same(cancelled)));
    });

    test('an aborted request is not wrapped', () async {
      // Aborting a request is the caller's own cancellation.
      final aborted = http.RequestAbortedException();
      final client = BlocksClient(
        baseUrl: 'http://test/cdk-blocks/api',
        client: MockClient((_) async => throw aborted),
      );
      await expectLater(client.call('ns.method', []), throwsA(same(aborted)));
    });

    test('an Error from the HTTP client is not wrapped', () async {
      final client = BlocksClient(
        baseUrl: 'http://test/cdk-blocks/api',
        client: MockClient((_) async => throw StateError('bug')),
      );
      await expectLater(
        client.call('ns.method', []),
        throwsA(isA<StateError>()),
      );
    });

    test('request after close()', () async {
      var sent = 0;
      final client = BlocksClient(
        baseUrl: 'http://test/cdk-blocks/api',
        client: MockClient((_) async {
          sent++;
          return http.Response(
            jsonEncode({'jsonrpc': '2.0', 'id': 1, 'result': 'ok'}),
            200,
          );
        }),
      );
      expect(await client.call('ns.method', []), 'ok');
      client
        ..close()
        // Closing twice is not an error.
        ..close();
      await expectLater(
        client.call('ns.method', []),
        throwsA(isA<ClientClosedException>()),
      );
      expect(sent, 1);
    });

    test('close() during a 401 refresh fails the retry as closed', () async {
      var sent = 0;
      late final BlocksClient client;
      client = BlocksClient(
        baseUrl: 'http://test/cdk-blocks/api',
        client: MockClient((_) async {
          sent++;
          return http.Response('{}', 401);
        }),
        authProvider: _ThrowingAuthProvider(
          null,
          onFailure: () => client.close(),
        ),
      );
      await expectLater(
        client.call('ns.method', []),
        throwsA(isA<ClientClosedException>()),
      );
      expect(sent, 1);
    });
  });

  group('isBlocksError', () {
    const named = ApiException(
      'nope',
      status: 409,
      name: 'ConditionalCheckFailedException',
    );

    test('match, mismatch, wrong error type', () {
      expect(isBlocksError(named, 'ConditionalCheckFailedException'), isTrue);
      expect(isBlocksError(named, 'SomeOtherException'), isFalse);
      expect(
        isBlocksError(
          Exception('ConditionalCheckFailedException'),
          'ConditionalCheckFailedException',
        ),
        isFalse,
      );
      expect(
        isBlocksError(
          const TransportException('ConditionalCheckFailedException'),
          'ConditionalCheckFailedException',
        ),
        isFalse,
      );
    });

    test('does not match a nameless ApiException or null', () {
      expect(isBlocksError(const ApiException('x', status: 500), ''), isFalse);
      expect(isBlocksError(null, 'ConditionalCheckFailedException'), isFalse);
    });

    test('matches a name synthesized from a reserved code', () async {
      Object? caught;
      try {
        await _call(_errorEnvelope(-32601, 'Method not found'));
      } on Exception catch (e) {
        caught = e;
      }
      expect(isBlocksError(caught, 'MethodNotFound'), isTrue);
    });
  });

  group('BlocksException', () {
    test('is the base of every runtime error', () {
      final errors = <Object>[
        const ApiException('a', status: 400),
        const TransportException('t'),
        const ClientClosedException(),
        const TransferableException('x'),
        const InvalidDescriptorException(
          'x',
          blocksType: 'realtime/channel',
          missingField: 'wsUrl',
        ),
        const FileTransferException('f'),
        const RealtimeChannelClosedException(),
        const RealtimeConnectionException('c'),
        OidcCancelledException(),
        OidcExchangeException('e'),
        OidcCallbackException('cb'),
        OidcUnknownProviderException('p'),
      ];
      for (final e in errors) {
        expect(e, isA<BlocksException>(), reason: '$e');
        expect(e, isA<Exception>(), reason: '$e');
      }
    });

    test('carries the cause', () {
      final cause = http.ClientException('offline');
      expect(TransportException('t', cause: cause).cause, same(cause));
      expect(FileTransferException('f', cause: cause).cause, same(cause));
      expect(RealtimeConnectionException('c', cause).cause, same(cause));
      expect(const ApiException('a', status: 400).cause, isNull);
    });

    test('toString names the type, status and name', () {
      expect(
        const ApiException('nope', status: 409, name: 'Conflict').toString(),
        'ApiException(409 Conflict): nope',
      );
      expect(
        const ApiException('boom', status: 500).toString(),
        'ApiException(500): boom',
      );
      expect(
        const TransportException('HTTP 503', statusCode: 503).toString(),
        'TransportException(503): HTTP 503',
      );
      // A gateway body's message keeps the status beside it.
      expect(
        const TransportException('Forbidden', statusCode: 403).toString(),
        'TransportException(403): Forbidden',
      );
      expect(
        const TransportException('Connection refused').toString(),
        'TransportException: Connection refused',
      );
      expect(
        TransportException(
          'offline',
          cause: http.ClientException('offline'),
        ).toString(),
        'TransportException: offline (cause: ClientException: offline)',
      );
      // An OIDC error names its own type, not the sealed base's.
      expect(
        OidcCancelledException('timed out').toString(),
        'OidcCancelledException: timed out',
      );
      expect(
        OidcExchangeException(
          'Exchange failed',
          const ApiException('no', status: 400),
        ).toString(),
        'OidcExchangeException: Exchange failed (cause: ApiException(400): no)',
      );
      expect(
        const ClientClosedException().toString(),
        'ClientClosedException: BlocksClient is closed',
      );
    });

    test('RealtimeException is a closed set of kinds', () {
      // An exhaustive switch with no default: adding a kind is a compile
      // error here, which is the reminder to add it everywhere else.
      String kind(RealtimeException e) => switch (e) {
        RealtimeChannelClosedException() => 'closed',
        RealtimeConnectionException() => 'connection',
        RealtimeSubscriptionEndedException() => 'ended',
      };
      expect(kind(const RealtimeChannelClosedException()), 'closed');
      expect(kind(const RealtimeConnectionException('c')), 'connection');
      expect(
        kind(const RealtimeSubscriptionEndedException('room', null, 'm')),
        'ended',
      );
    });

    test('RealtimeSubscriptionEndedException names the channel and code', () {
      const e = RealtimeSubscriptionEndedException(
        'room',
        'token_expired',
        'Channel token expired',
      );
      expect(e, isA<BlocksException>());
      expect(
        e.toString(),
        'RealtimeSubscriptionEndedException(room, token_expired): '
        'Channel token expired',
      );
      expect(
        const RealtimeSubscriptionEndedException(
          'room',
          null,
          'refused',
        ).toString(),
        'RealtimeSubscriptionEndedException(room): refused',
      );
    });
  });

  group('FileTransferException', () {
    Future<void> withResponses(
      Future<http.Response> Function(http.Request) handler,
      Future<void> Function() body,
    ) => http.runWithClient(body, () => MockClient(handler));

    final upload = FileUploadHandle.fromJson({
      '__blocks': 'file-bucket/upload',
      'url': 'https://bucket.example/put',
    });
    final download = FileDownloadHandle.fromJson({
      '__blocks': 'file-bucket/download',
      'url': 'https://bucket.example/get',
    });

    test('a failed upload carries the HTTP status as a field', () async {
      await withResponses((_) async => http.Response('denied', 403), () async {
        await expectLater(
          upload.upload(Uint8List.fromList([1])),
          throwsA(
            isA<FileTransferException>()
                .having((e) => e.statusCode, 'statusCode', 403)
                .having((e) => e.message, 'message', 'Upload failed: HTTP 403'),
          ),
        );
      });
    });

    test('a failed download carries the HTTP status as a field', () async {
      await withResponses((_) async => http.Response('', 404), () async {
        await expectLater(
          download.download(),
          throwsA(
            isA<FileTransferException>()
                .having((e) => e.statusCode, 'statusCode', 404)
                .having(
                  (e) => e.message,
                  'message',
                  'Download failed: HTTP 404',
                ),
          ),
        );
      });
    });

    test('a transfer with no response has no status and a cause', () async {
      final offline = http.ClientException('offline');
      await withResponses((_) async => throw offline, () async {
        await expectLater(
          upload.upload(Uint8List.fromList([1])),
          throwsA(
            isA<FileTransferException>()
                .having((e) => e.statusCode, 'statusCode', isNull)
                .having((e) => e.message, 'message', 'Upload failed: offline')
                .having((e) => e.cause, 'cause', same(offline)),
          ),
        );
        await expectLater(
          download.download(),
          throwsA(
            isA<FileTransferException>()
                .having((e) => e.statusCode, 'statusCode', isNull)
                .having((e) => e.cause, 'cause', same(offline)),
          ),
        );
      });
    });
  });

  group('TransferableException', () {
    test('a handle descriptor without its url', () {
      for (final hydrate in <void Function()>[
        () => FileUploadHandle.fromJson({'__blocks': 'file-bucket/upload'}),
        () => FileDownloadHandle.fromJson({'url': 7}),
      ]) {
        expect(
          hydrate,
          throwsA(
            isA<InvalidDescriptorException>()
                .having((e) => e.missingField, 'missingField', 'url')
                .having(
                  (e) => e.blocksType,
                  'blocksType',
                  startsWith('file-bucket/'),
                ),
          ),
        );
      }
    });

    test('a channel descriptor without a required field', () {
      for (final field in ['channel', 'wsUrl', 'token']) {
        final descriptor = <String, dynamic>{
          '__blocks': 'realtime/channel',
          'channel': 'room',
          'wsUrl': 'ws://h/',
          'token': 't',
        }..remove(field);
        expect(
          () => RealtimeChannel.fromJsonValue(descriptor, (p) => p),
          throwsA(
            isA<InvalidDescriptorException>()
                .having((e) => e.blocksType, 'blocksType', 'realtime/channel')
                .having((e) => e.missingField, 'missingField', field),
          ),
          reason: field,
        );
      }
    });

    test('a descriptor with the wrong tag', () {
      expect(
        () => validateTransferableDescriptor({
          '__blocks': 'other/tag',
        }, expectedTag: 'file-bucket/upload'),
        throwsA(
          isA<TransferableException>().having(
            (e) => e,
            'type',
            isNot(isA<InvalidDescriptorException>()),
          ),
        ),
      );
    });
  });

  group('RealtimeChannelClosedException', () {
    test('subscribing to a closed channel', () {
      final channel = RealtimeChannel.fromJsonValue({
        '__blocks': 'realtime/channel',
        'channel': 'room',
        'wsUrl': 'ws://127.0.0.1:1/',
        'token': 't',
      }, (p) => p)..close();
      expect(channel.subscribe, throwsA(isA<RealtimeChannelClosedException>()));
    });
  });
}

class _ThrowingAuthProvider implements AuthProvider {
  _ThrowingAuthProvider(this.error, {this.onFailure});

  final Exception? error;
  final void Function()? onFailure;

  @override
  Future<String?> getAccessToken() async {
    if (error != null) throw error!;
    return null;
  }

  @override
  Future<void> onAuthFailure() async => onFailure?.call();
}
