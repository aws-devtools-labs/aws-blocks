import 'dart:async';
import 'dart:io';
import 'dart:math';

Future<(Stream<List<int>>, int)> openLocalFile(String path) async {
  final file = File(path);
  return (file.openRead(), await file.length());
}

Future<void> writeLocalFileAtomically(
  String path,
  Future<void> Function(StreamSink<List<int>> sink) write,
) async {
  // Same directory as [path], so the rename stays on one file system.
  final suffix = Random.secure().nextInt(1 << 32).toRadixString(16);
  final partial = File('$path.$suffix.part');
  final sink = partial.openWrite();
  try {
    await write(sink);
    await sink.close();
    await partial.rename(path);
  } catch (_) {
    try {
      await sink.close();
    } catch (_) {
      // The write already failed; that is the error to report.
    }
    if (await partial.exists()) await partial.delete();
    rethrow;
  }
}
