import 'dart:async';
import 'dart:typed_data';
import 'package:http/http.dart' as http;

import 'file_transfer_exception.dart';
import 'local_file.dart';
import 'timeout_client.dart';
import 'transferable_descriptor.dart';
import 'user_agent_client.dart';

class FileDownloadHandle {
  final String url;

  /// The descriptor this handle was hydrated from, as [toJson] returns it.
  final Map<String, dynamic> _descriptor;

  FileDownloadHandle._({
    required this.url,
    required Map<String, dynamic> descriptor,
  }) : _descriptor = descriptor;

  factory FileDownloadHandle.fromJson(Map<String, dynamic> json) {
    return FileDownloadHandle._(url: json['url'] as String, descriptor: json);
  }

  /// This handle's descriptor, as the server's `toJSON()` sent it and
  /// [FileDownloadHandle.fromJson] read it:
  /// `{"__blocks": "file-bucket/download", "url"}`, with any other key it
  /// held. A generated client sends a handle parameter, or a handle inside a
  /// model it sends, this way; `jsonEncode` calls it too.
  ///
  /// Returns a copy, so changing it doesn't change this handle.
  Map<String, dynamic> toJson() =>
      transferableDescriptor('file-bucket/download', _descriptor);

  String getUrl() => url;

  /// Downloads the whole file into memory.
  ///
  /// Throws a [FileTransferException] on an HTTP error status, and rethrows a
  /// network error.
  Future<Uint8List> download() async {
    final client = UserAgentClient(newBlocksHttpClient());
    try {
      final response = await client.get(Uri.parse(url));
      if (response.statusCode != 200) {
        throw FileTransferException(
          'Download failed: HTTP ${response.statusCode}',
          statusCode: response.statusCode,
        );
      }
      return response.bodyBytes;
    } finally {
      client.close();
    }
  }

  /// Streams the file into [sink] as it arrives, so it does not have to fit
  /// in memory. [sink] can be an `IOSink`, a `StreamController` or its
  /// `sink`, or any other [StreamConsumer].
  ///
  /// [sink] is not closed; the caller owns it. Bytes already written stay in
  /// [sink] if the download fails partway, so a caller that needs all or
  /// nothing should write somewhere it can discard, or use [downloadToFile].
  ///
  /// Throws a [FileTransferException] on an HTTP error status (before
  /// anything is written), and rethrows a network error.
  Future<void> downloadTo(StreamConsumer<List<int>> sink) async {
    final client = UserAgentClient(newBlocksHttpClient());
    try {
      final response = await client.send(http.Request('GET', Uri.parse(url)));
      if (response.statusCode != 200) {
        throw FileTransferException(
          'Download failed: HTTP ${response.statusCode}',
          statusCode: response.statusCode,
        );
      }
      // A StreamController's addStream forwards an error to its listener and
      // completes normally, so catch it here and throw it from this call
      // whatever kind of sink the caller passed.
      Object? failure;
      StackTrace? failureStack;
      await sink.addStream(
        response.stream.handleError((Object e, StackTrace s) {
          failure ??= e;
          failureStack ??= s;
        }),
      );
      if (failure != null) Error.throwWithStackTrace(failure!, failureStack!);
    } finally {
      client.close();
    }
  }

  /// Downloads the file to [path], replacing any file already there.
  ///
  /// Atomic: the body is written to a new file in the same directory and
  /// renamed over [path] once complete, so [path] holds either its previous
  /// contents or the whole download, and a failed download leaves no partial
  /// file. (This matches Swift's `downloadTo(fileURL:)`; [downloadTo] and
  /// Kotlin's `downloadTo(sink)` leave durability to the caller.)
  ///
  /// The new file is named `<path>.<random hex>.part`. It is not flushed to
  /// disk (no fsync) before the rename, and a process killed mid-download
  /// leaves it behind. On Windows the rename fails, keeping the old file, if
  /// another process has [path] open.
  ///
  /// Throws a `FileSystemException` if the new file cannot be created (for
  /// example, when the directory does not exist), before anything is
  /// downloaded. Throws [UnsupportedError] on the web, which has no file
  /// paths.
  Future<void> downloadToFile(String path) =>
      writeLocalFileAtomically(path, downloadTo);
}
