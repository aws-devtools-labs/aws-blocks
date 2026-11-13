import 'dart:async';

import 'local_file_web.dart'
    if (dart.library.io) 'local_file_io.dart'
    as platform;

/// Opens the file at [path] for a streaming read, with its length in bytes.
///
/// Throws [UnsupportedError] on the web, which has no file paths.
Future<(Stream<List<int>>, int)> openLocalFile(String path) =>
    platform.openLocalFile(path);

/// Runs [write] into a new file next to [path], then renames it over [path],
/// so [path] holds either its previous contents or everything [write] wrote.
/// If [write] throws, the new file is deleted and [path] is left unchanged.
///
/// Throws [UnsupportedError] on the web, which has no file paths.
Future<void> writeLocalFileAtomically(
  String path,
  Future<void> Function(StreamSink<List<int>> sink) write,
) => platform.writeLocalFileAtomically(path, write);
