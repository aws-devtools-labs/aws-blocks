import 'dart:async';

Future<(Stream<List<int>>, int)> openLocalFile(String path) =>
    throw UnsupportedError('File paths are not supported on the web.');

Future<void> writeLocalFileAtomically(
  String path,
  Future<void> Function(StreamSink<List<int>> sink) write,
) => throw UnsupportedError('File paths are not supported on the web.');
