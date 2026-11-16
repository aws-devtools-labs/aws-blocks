@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:http/http.dart' show ClientException;
import 'package:test/test.dart';

/// A payload larger than one chunk, with a pattern a reordering would break.
Uint8List _payload(int length) =>
    Uint8List.fromList(List.generate(length, (i) => (i * 31 + 7) % 256));

/// Splits [bytes] into chunks of [chunkSize].
Stream<List<int>> _chunked(Uint8List bytes, int chunkSize) async* {
  for (var i = 0; i < bytes.length; i += chunkSize) {
    final end = i + chunkSize > bytes.length ? bytes.length : i + chunkSize;
    yield bytes.sublist(i, end);
  }
}

Future<HttpServer> _serve(Future<void> Function(HttpRequest) handler) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen(handler);
  addTearDown(() => server.close(force: true));
  return server;
}

/// A raw socket server whose response promises 100 bytes and sends 3.
Future<ServerSocket> _truncatingServer() async {
  final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  addTearDown(server.close);
  server.listen((socket) {
    socket.listen((_) {
      socket.add('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n'.codeUnits);
      socket.add([1, 2, 3]);
      socket.flush().then((_) => socket.destroy());
    });
  });
  return server;
}

String _url(HttpServer server, String path) =>
    'http://127.0.0.1:${server.port}$path';

void main() {
  group('FileUploadHandle.uploadFrom', () {
    test('streams a large chunked source with its Content-Length', () async {
      final data = _payload(5 * 1024 * 1024 + 123);
      final received = BytesBuilder(copy: false);
      String? transferEncoding;
      int? contentLength;
      String? contentType;
      final server = await _serve((req) async {
        transferEncoding = req.headers.value('transfer-encoding');
        contentLength = req.headers.contentLength;
        contentType = req.headers.value('content-type');
        await req.forEach(received.add);
        req.response.statusCode = 200;
        await req.response.close();
      });

      await FileUploadHandle.fromJson({
        'url': _url(server, '/put'),
        'contentType': 'application/octet-stream',
      }).uploadFrom(_chunked(data, 64 * 1024), contentLength: data.length);

      expect(received.takeBytes(), data);
      expect(transferEncoding, isNull);
      expect(contentLength, data.length);
      expect(contentType, 'application/octet-stream');
    });

    test('sends the body before the source has finished', () async {
      // The server answers only after its first chunk arrives, and the source
      // only finishes after that answer, so a body buffered until the source
      // is done would never be sent and this test would time out.
      final firstChunkArrived = Completer<void>();
      final received = BytesBuilder(copy: false);
      final server = await _serve((req) async {
        await req.forEach((chunk) {
          received.add(chunk);
          if (!firstChunkArrived.isCompleted) firstChunkArrived.complete();
        });
        req.response.statusCode = 200;
        await req.response.close();
      });

      final source = StreamController<List<int>>();
      // Larger than dart:io's write buffer, so it is not held back.
      final first = _payload(64 * 1024);
      final upload = FileUploadHandle.fromJson({
        'url': _url(server, '/put'),
      }).uploadFrom(source.stream, contentLength: first.length + 2);
      source.add(first);
      await firstChunkArrived.future.timeout(const Duration(seconds: 5));
      source.add([4, 5]);
      await source.close();
      await upload;

      expect(received.takeBytes(), [...first, 4, 5]);
    });

    test('sends Content-Length when contentLength matches', () async {
      final data = _payload(300000);
      final received = BytesBuilder(copy: false);
      int? contentLength;
      final server = await _serve((req) async {
        contentLength = req.headers.contentLength;
        await req.forEach(received.add);
        req.response.statusCode = 200;
        await req.response.close();
      });

      await FileUploadHandle.fromJson({
        'url': _url(server, '/put'),
      }).uploadFrom(_chunked(data, 8192), contentLength: data.length);

      expect(contentLength, data.length);
      expect(received.takeBytes(), data);
    });

    test('fails when the source yields more than contentLength', () async {
      final server = await _serve((req) async {
        await req.drain<void>();
        req.response.statusCode = 200;
        await req.response.close();
      });

      await expectLater(
        FileUploadHandle.fromJson({
          'url': _url(server, '/put'),
        }).uploadFrom(_chunked(_payload(10), 4), contentLength: 8),
        throwsA(
          isA<FileTransferException>()
              .having((e) => e.statusCode, 'statusCode', isNull)
              .having(
                (e) => e.message,
                'message',
                contains('Upload failed: source yielded more than the 8 bytes'),
              ),
        ),
      );
    });

    test('fails when the source yields fewer than contentLength', () async {
      final server = await _serve((req) async {
        await req.drain<void>();
        req.response.statusCode = 200;
        await req.response.close();
      });

      await expectLater(
        FileUploadHandle.fromJson({
          'url': _url(server, '/put'),
        }).uploadFrom(_chunked(_payload(5), 2), contentLength: 8),
        throwsA(
          isA<FileTransferException>()
              .having((e) => e.statusCode, 'statusCode', isNull)
              .having(
                (e) => e.message,
                'message',
                contains('Upload failed: source yielded 5 of the 8 bytes'),
              ),
        ),
      );
    });

    test(
      'stores nothing when the extra byte comes after a full chunk',
      () async {
        // The first chunk alone is exactly contentLength. If it were sent at
        // once, the server would see a complete request and store it before
        // the extra byte arrived.
        const length = 64 * 1024 + 1;
        var stored = false;
        final server = await _serve((req) async {
          final body = BytesBuilder(copy: false);
          await req.forEach(body.add);
          if (body.length == req.headers.contentLength) stored = true;
          req.response.statusCode = 200;
          await req.response.close();
        });

        final source = StreamController<List<int>>();
        final upload = FileUploadHandle.fromJson({
          'url': _url(server, '/put'),
        }).uploadFrom(source.stream, contentLength: length);
        source.add(_payload(length));
        await Future<void>.delayed(const Duration(milliseconds: 500));
        source.add([0]);
        await source.close();

        await expectLater(upload, throwsA(isA<FileTransferException>()));
        expect(stored, isFalse);
      },
    );

    test('rejects a negative contentLength', () {
      expect(
        () => FileUploadHandle.fromJson({
          'url': 'http://127.0.0.1:1/put',
        }).uploadFrom(const Stream.empty(), contentLength: -1),
        throwsRangeError,
      );
    });

    test('surfaces an HTTP error status', () async {
      final server = await _serve((req) async {
        await req.drain<void>();
        req.response.statusCode = 403;
        await req.response.close();
      });

      await expectLater(
        FileUploadHandle.fromJson({
          'url': _url(server, '/put'),
        }).uploadFrom(Stream.value([1, 2, 3]), contentLength: 3),
        throwsA(
          isA<FileTransferException>()
              .having((e) => e.statusCode, 'statusCode', 403)
              .having((e) => e.message, 'message', 'Upload failed: HTTP 403'),
        ),
      );
    });
  });

  group('FileUploadHandle.uploadFromFile', () {
    test('streams the file with its length', () async {
      final dir = await Directory.systemTemp.createTemp('blocks_upload_');
      addTearDown(() => dir.delete(recursive: true));
      final data = _payload(1024 * 1024 + 1);
      final file = File('${dir.path}/upload.bin');
      await file.writeAsBytes(data);

      final received = BytesBuilder(copy: false);
      int? contentLength;
      final server = await _serve((req) async {
        contentLength = req.headers.contentLength;
        await req.forEach(received.add);
        req.response.statusCode = 200;
        await req.response.close();
      });

      await FileUploadHandle.fromJson({
        'url': _url(server, '/put'),
      }).uploadFromFile(file.path);

      expect(contentLength, data.length);
      expect(received.takeBytes(), data);
    });
  });

  group('FileDownloadHandle.downloadTo', () {
    test('streams a large body into the sink', () async {
      final data = _payload(5 * 1024 * 1024 + 321);
      final server = await _serve((req) async {
        req.response.statusCode = 200;
        await req.response.addStream(_chunked(data, 64 * 1024));
        await req.response.close();
      });

      final received = BytesBuilder(copy: false);
      final sink = StreamController<List<int>>();
      final done = sink.stream.forEach(received.add);
      await FileDownloadHandle.fromJson({
        'url': _url(server, '/get'),
      }).downloadTo(sink.sink);
      await sink.close();
      await done;

      expect(received.takeBytes(), data);
    });

    test('writes to the sink before the body has finished', () async {
      // The server holds the rest of the body until the sink has seen the
      // first chunk, so a download buffered until the body ends would never
      // reach the sink and this test would time out.
      final firstChunkSeen = Completer<void>();
      final first = _payload(64 * 1024);
      final server = await _serve((req) async {
        req.response.statusCode = 200;
        req.response.add(first);
        await req.response.flush();
        await firstChunkSeen.future.timeout(const Duration(seconds: 5));
        req.response.add([4, 5]);
        await req.response.close();
      });

      final received = BytesBuilder(copy: false);
      final sink = StreamController<List<int>>();
      final done = sink.stream.forEach((chunk) {
        received.add(chunk);
        if (!firstChunkSeen.isCompleted) firstChunkSeen.complete();
      });
      await FileDownloadHandle.fromJson({
        'url': _url(server, '/get'),
      }).downloadTo(sink.sink);
      await sink.close();
      await done;

      expect(received.takeBytes(), [...first, 4, 5]);
    });

    test('surfaces an HTTP error status and writes nothing', () async {
      final server = await _serve((req) async {
        req.response.statusCode = 404;
        req.response.write('not found');
        await req.response.close();
      });

      final received = <List<int>>[];
      final sink = StreamController<List<int>>();
      final done = sink.stream.forEach(received.add);
      await expectLater(
        FileDownloadHandle.fromJson({
          'url': _url(server, '/get'),
        }).downloadTo(sink.sink),
        throwsA(
          isA<FileTransferException>()
              .having((e) => e.statusCode, 'statusCode', 404)
              .having((e) => e.message, 'message', 'Download failed: HTTP 404'),
        ),
      );
      await sink.close();
      await done;
      expect(received, isEmpty);
    });

    test('throws when the body is cut off, whatever the sink', () async {
      // A StreamController's addStream would otherwise swallow the error.
      final server = await _truncatingServer();
      final sink = StreamController<List<int>>();
      final done = sink.stream.drain<void>();
      await expectLater(
        FileDownloadHandle.fromJson({
          'url': 'http://127.0.0.1:${server.port}/get',
        }).downloadTo(sink.sink),
        throwsA(isA<ClientException>()),
      );
      await sink.close();
      await done;
    });
  });

  group('FileDownloadHandle.downloadToFile', () {
    late Directory dir;
    setUp(() async {
      dir = await Directory.systemTemp.createTemp('blocks_download_');
      addTearDown(() => dir.delete(recursive: true));
    });

    test('writes the body to the file, replacing an existing one', () async {
      final data = _payload(2 * 1024 * 1024 + 5);
      final server = await _serve((req) async {
        req.response.statusCode = 200;
        await req.response.addStream(_chunked(data, 64 * 1024));
        await req.response.close();
      });
      final file = File('${dir.path}/download.bin');
      await file.writeAsString('old contents');

      await FileDownloadHandle.fromJson({
        'url': _url(server, '/get'),
      }).downloadToFile(file.path);

      expect(await file.readAsBytes(), data);
      expect(dir.listSync().map((e) => e.path), [file.path]);
    });

    test('leaves an existing file untouched when the download fails', () async {
      final server = await _serve((req) async {
        req.response.statusCode = 500;
        await req.response.close();
      });
      final file = File('${dir.path}/download.bin');
      await file.writeAsString('old contents');

      await expectLater(
        FileDownloadHandle.fromJson({
          'url': _url(server, '/get'),
        }).downloadToFile(file.path),
        throwsA(
          isA<FileTransferException>().having(
            (e) => e.statusCode,
            'statusCode',
            500,
          ),
        ),
      );

      expect(await file.readAsString(), 'old contents');
      expect(dir.listSync().map((e) => e.path), [file.path]);
    });

    test('throws when the directory does not exist', () async {
      final server = await _serve((req) async {
        req.response.statusCode = 200;
        req.response.add([1, 2, 3]);
        await req.response.close();
      });

      await expectLater(
        FileDownloadHandle.fromJson({
          'url': _url(server, '/get'),
        }).downloadToFile('${dir.path}/missing/download.bin'),
        throwsA(isA<PathNotFoundException>()),
      );
      expect(dir.listSync(), isEmpty);
    });

    test('leaves no file when the body is cut off', () async {
      final server = await _truncatingServer();
      final file = File('${dir.path}/download.bin');

      await expectLater(
        FileDownloadHandle.fromJson({
          'url': 'http://127.0.0.1:${server.port}/get',
        }).downloadToFile(file.path),
        throwsA(isA<ClientException>()),
      );

      expect(dir.listSync(), isEmpty);
    });
  });
}
