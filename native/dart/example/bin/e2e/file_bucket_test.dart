import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'harness.dart';

void main() async {
  final blocks = createBlocks();
  final prefix = 'test_${DateTime.now().millisecondsSinceEpoch}';

  group('FileBucket: text upload/download via handles');
  final up1 = await blocks.api.fileCreateUploadHandle(
    path: '$prefix/hello.txt',
  );
  check(up1.url.isNotEmpty, 'upload handle has url');
  await up1.upload(Uint8List.fromList('hello from dart'.codeUnits));
  final down1 = await blocks.api.fileGetHandle(path: '$prefix/hello.txt');
  final bytes1 = await down1.download();
  check(
    String.fromCharCodes(bytes1) == 'hello from dart',
    'text content matches',
  );

  group('FileBucket: binary data round-trip');
  final binaryData = Uint8List.fromList(List.generate(256, (i) => i));
  final up2 = await blocks.api.fileCreateUploadHandle(
    path: '$prefix/binary.bin',
  );
  await up2.upload(binaryData);
  final down2 = await blocks.api.fileGetHandle(path: '$prefix/binary.bin');
  final bytes2 = await down2.download();
  check(bytes2.length == 256, 'binary length matches (got: ${bytes2.length})');
  check(
    _bytesEqual(bytes2, binaryData),
    'binary content matches byte-for-byte',
  );

  group('FileBucket: server-side put/get');
  await blocks.api.filePut(path: '$prefix/server.txt', content: 'server-side');
  final file = await blocks.api.fileGet(path: '$prefix/server.txt');
  check(file != null, 'fileGet returns file');
  check(file?.body == 'server-side', 'content matches');

  group('FileBucket: delete');
  await blocks.api.fileDelete(path: '$prefix/server.txt');
  final deleted = await blocks.api.fileGet(path: '$prefix/server.txt');
  check(deleted == null, 'deleted file returns null');

  group('FileBucket: scan with prefix');
  await blocks.api.filePut(path: '$prefix/scan/a.txt', content: 'a');
  await blocks.api.filePut(path: '$prefix/scan/b.txt', content: 'b');
  final scanned = await blocks.api.fileScan(prefix: '$prefix/scan/');
  check(
    scanned.length >= 2,
    'scan returns at least 2 files (got: ${scanned.length})',
  );

  group('FileBucket: large file (100KB)');
  final largeData = Uint8List.fromList(List.generate(100000, (i) => i % 256));
  final up3 = await blocks.api.fileCreateUploadHandle(
    path: '$prefix/large.bin',
  );
  await up3.upload(largeData);
  final down3 = await blocks.api.fileGetHandle(path: '$prefix/large.bin');
  final bytes3 = await down3.download();
  check(bytes3.length == 100000, 'large file length (got: ${bytes3.length})');

  group('FileBucket: streaming upload/download (1MB)');
  final streamData = Uint8List.fromList(
    List.generate(1024 * 1024, (i) => (i * 7) % 256),
  );
  final up4 = await blocks.api.fileCreateUploadHandle(
    path: '$prefix/stream.bin',
  );
  // Several chunks, sent as they come.
  await up4.uploadFrom(
    Stream.fromIterable([
      for (var i = 0; i < streamData.length; i += 64 * 1024)
        streamData.sublist(i, i + 64 * 1024),
    ]),
    contentLength: streamData.length,
  );
  final down4 = await blocks.api.fileGetHandle(path: '$prefix/stream.bin');
  final streamed = BytesBuilder(copy: false);
  final sink = StreamController<List<int>>();
  final drained = sink.stream.forEach(streamed.add);
  await down4.downloadTo(sink.sink);
  await sink.close();
  await drained;
  check(
    _bytesEqual(streamed.takeBytes(), streamData),
    'chunked uploadFrom then downloadTo round-trips byte-for-byte',
  );

  final dir = await Directory.systemTemp.createTemp('blocks_e2e_');
  try {
    final source = File('${dir.path}/source.bin');
    await source.writeAsBytes(streamData);
    final up5 = await blocks.api.fileCreateUploadHandle(
      path: '$prefix/stream-file.bin',
    );
    await up5.uploadFromFile(source.path);
    final down5 = await blocks.api.fileGetHandle(
      path: '$prefix/stream-file.bin',
    );
    final target = File('${dir.path}/target.bin');
    await down5.downloadToFile(target.path);
    check(
      _bytesEqual(await target.readAsBytes(), streamData),
      'uploadFromFile then downloadToFile round-trips byte-for-byte',
    );
  } finally {
    await dir.delete(recursive: true);
  }

  printResults();
}

bool _bytesEqual(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
