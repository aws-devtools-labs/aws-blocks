import 'dart:typed_data';
import 'package:http/http.dart' as http;

import 'local_file.dart';
import 'timeout_client.dart';
import 'transferable_descriptor.dart';
import 'user_agent_client.dart';

class FileUploadHandle {
  final String url;
  final String? contentType;

  /// The descriptor this handle was hydrated from, as [toJson] returns it.
  final Map<String, dynamic> _descriptor;

  FileUploadHandle._({
    required this.url,
    this.contentType,
    required Map<String, dynamic> descriptor,
  }) : _descriptor = descriptor;

  factory FileUploadHandle.fromJson(Map<String, dynamic> json) {
    return FileUploadHandle._(
      url: json['url'] as String,
      contentType: json['contentType'] as String?,
      descriptor: json,
    );
  }

  /// This handle's descriptor, as the server's `toJSON()` sent it and
  /// [FileUploadHandle.fromJson] read it:
  /// `{"__blocks": "file-bucket/upload", "url", "contentType"?}`, with any
  /// other key it held. A generated client sends a handle parameter, or a
  /// handle inside a model it sends, this way; `jsonEncode` calls it too.
  ///
  /// Returns a copy, so changing it doesn't change this handle.
  Map<String, dynamic> toJson() =>
      transferableDescriptor('file-bucket/upload', _descriptor);

  String getUrl() => url;

  Future<void> upload(Uint8List bytes) async {
    final headers = <String, String>{};
    if (contentType != null) headers['Content-Type'] = contentType!;
    final client = UserAgentClient(newBlocksHttpClient());
    try {
      final response = await client.put(
        Uri.parse(url),
        headers: headers,
        body: bytes,
      );
      if (response.statusCode != 200 && response.statusCode != 204) {
        throw Exception('Upload failed: HTTP ${response.statusCode}');
      }
    } finally {
      client.close();
    }
  }

  /// Streams [source] to the presigned upload URL, so the file does not have
  /// to fit in memory.
  ///
  /// [contentLength] is the body size in bytes, sent as the `Content-Length`
  /// header. It is required because a presigned upload URL does not accept a
  /// chunked body. If the handle was created on the server with a
  /// `contentLength` option, that size is signed into the URL and the upload
  /// is rejected unless it sends exactly that `Content-Length`, so pass the
  /// same value here. A [source] that yields more or fewer bytes than
  /// [contentLength] fails the upload before the request completes, so
  /// nothing is stored.
  ///
  /// A [source] that yields nothing for the idle timeout (60 seconds) fails
  /// the upload with a `TimeoutException`.
  ///
  /// On the web, package:http's browser client reads the whole body into
  /// memory before it sends the request.
  ///
  /// Throws an [Exception] on an HTTP error status or a byte-count mismatch,
  /// and rethrows an error from [source] or the network.
  Future<void> uploadFrom(
    Stream<List<int>> source, {
    required int contentLength,
  }) async {
    RangeError.checkNotNegative(contentLength, 'contentLength');
    final request = _StreamingRequest(
      'PUT',
      Uri.parse(url),
      _exactly(source, contentLength),
    );
    if (contentType != null) request.headers['Content-Type'] = contentType!;
    request.contentLength = contentLength;
    final client = UserAgentClient(newBlocksHttpClient());
    try {
      final response = await client.send(request);
      await response.stream.drain<void>();
      if (response.statusCode != 200 && response.statusCode != 204) {
        // TODO(error-taxonomy): use the shared file-transfer error type.
        throw Exception('Upload failed: HTTP ${response.statusCode}');
      }
    } finally {
      client.close();
    }
  }

  /// Streams the file at [path] to the presigned upload URL, sending its size
  /// as the `Content-Length`. See [uploadFrom].
  ///
  /// Throws [UnsupportedError] on the web, which has no file paths.
  Future<void> uploadFromFile(String path) async {
    final (source, length) = await openLocalFile(path);
    await uploadFrom(source, contentLength: length);
  }

  /// Passes [source] through, failing it if it yields more or fewer than
  /// [expected] bytes. The chunk that reaches [expected] is held back until
  /// [source] ends, so an extra byte fails the stream before the server has
  /// a complete request, and a short source fails it at its end.
  static Stream<List<int>> _exactly(
    Stream<List<int>> source,
    int expected,
  ) async* {
    var sent = 0;
    List<int>? last;
    await for (final chunk in source) {
      if (chunk.isEmpty) continue;
      sent += chunk.length;
      if (sent > expected) {
        // TODO(error-taxonomy): use the shared file-transfer error type.
        throw Exception(
          'Upload failed: source yielded more than the $expected bytes '
          'given as contentLength',
        );
      }
      if (sent == expected) {
        last = chunk;
      } else {
        yield chunk;
      }
    }
    if (sent < expected) {
      // TODO(error-taxonomy): use the shared file-transfer error type.
      throw Exception(
        'Upload failed: source yielded $sent of the $expected bytes '
        'given as contentLength',
      );
    }
    if (last != null) yield last;
  }
}

/// A request whose body is a caller's stream, read as the connection accepts
/// it rather than buffered first.
class _StreamingRequest extends http.BaseRequest {
  final Stream<List<int>> _body;

  _StreamingRequest(super.method, super.url, this._body);

  @override
  http.ByteStream finalize() {
    super.finalize();
    return http.ByteStream(_body);
  }
}
