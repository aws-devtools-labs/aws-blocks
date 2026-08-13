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

  printResults();
}

bool _bytesEqual(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
