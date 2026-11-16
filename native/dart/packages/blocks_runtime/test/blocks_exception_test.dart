import 'dart:convert';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

BlocksRpcException _rpc(Object? data) => BlocksRpcException(
  code: 401,
  message: 'Authentication required',
  data: data,
);

void main() {
  group('BlocksRpcException.name', () {
    test('is the server error name from data', () {
      expect(
        _rpc({'name': 'NotAuthenticatedException'}).name,
        'NotAuthenticatedException',
      );
    });

    test('is null when there is no data', () {
      expect(_rpc(null).name, isNull);
    });

    test('is null when data has no name', () {
      expect(_rpc({'field': 'email'}).name, isNull);
    });

    test('is null when data is not a map', () {
      expect(_rpc('NotAuthenticatedException').name, isNull);
      expect(_rpc([1, 2]).name, isNull);
    });

    test('is null when the name is not a string', () {
      expect(_rpc({'name': 42}).name, isNull);
    });

    test('is read from the response a BlocksClient decodes', () async {
      final client = BlocksClient(
        baseUrl: 'http://test/aws-blocks/api',
        client: MockClient(
          (_) async => http.Response(
            jsonEncode({
              'jsonrpc': '2.0',
              'error': {
                'code': 409,
                'message': 'User already exists',
                'data': {'name': 'UserAlreadyExistsException'},
              },
              'id': 1,
            }),
            200,
          ),
        ),
      );
      await expectLater(
        client.call('auth.signUp', []),
        throwsA(
          isA<BlocksRpcException>().having(
            (e) => e.name,
            'name',
            'UserAlreadyExistsException',
          ),
        ),
      );
    });
  });

  group('isBlocksError', () {
    test('matches a BlocksRpcException by name', () {
      expect(
        isBlocksError(
          _rpc({'name': 'NotAuthenticatedException'}),
          'NotAuthenticatedException',
        ),
        isTrue,
      );
    });

    test('does not match another name', () {
      expect(
        isBlocksError(
          _rpc({'name': 'NotAuthenticatedException'}),
          'ValidationException',
        ),
        isFalse,
      );
    });

    test('agrees with an object pattern on name', () {
      bool byPattern(Object e) => switch (e) {
        BlocksRpcException(name: 'NotAuthenticatedException') => true,
        _ => false,
      };
      for (final e in [
        _rpc({'name': 'NotAuthenticatedException'}),
        _rpc({'name': 'ValidationException'}),
        _rpc(null),
      ]) {
        expect(byPattern(e), isBlocksError(e, 'NotAuthenticatedException'));
      }
    });

    test('does not match a BlocksRpcException with no name', () {
      expect(isBlocksError(_rpc(null), 'NotAuthenticatedException'), isFalse);
    });

    test('does not match other errors, whatever their message', () {
      expect(
        isBlocksError(
          Exception('NotAuthenticatedException'),
          'NotAuthenticatedException',
        ),
        isFalse,
      );
      expect(
        isBlocksError(
          const FileTransferException('NotAuthenticatedException'),
          'NotAuthenticatedException',
        ),
        isFalse,
      );
      expect(isBlocksError(null, 'NotAuthenticatedException'), isFalse);
    });
  });

  group('BlocksException', () {
    test('is implemented by BlocksRpcException and FileTransferException', () {
      expect(_rpc(null), isA<BlocksException>());
      expect(const FileTransferException('x'), isA<BlocksException>());
    });

    test('a BlocksRpcException has no cause', () {
      expect(_rpc(null).cause, isNull);
    });

    test('carries the cause through the root type', () {
      final cause = StateError('socket gone');
      final BlocksException e = FileTransferException('x', cause: cause);
      expect(e.cause, same(cause));
    });

    test('keeps both catchable as Exception', () {
      expect(_rpc(null), isA<Exception>());
      expect(const FileTransferException('x'), isA<Exception>());
    });
  });

  group('FileTransferException', () {
    test('carries the status code and the underlying error', () {
      final cause = StateError('socket gone');
      final e = FileTransferException(
        'Upload failed: HTTP 403',
        statusCode: 403,
        cause: cause,
      );
      expect(e.message, 'Upload failed: HTTP 403');
      expect(e.statusCode, 403);
      expect(e.cause, same(cause));
    });

    test('toString names the type and keeps the message', () {
      expect(
        const FileTransferException('Download failed: HTTP 404').toString(),
        'FileTransferException: Download failed: HTTP 404',
      );
    });
  });
}
