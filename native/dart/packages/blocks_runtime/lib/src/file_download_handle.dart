import 'dart:typed_data';
import 'package:http/http.dart' as http;

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

  Future<Uint8List> download() async {
    final client = UserAgentClient(http.Client());
    try {
      final response = await client.get(Uri.parse(url));
      if (response.statusCode != 200) {
        throw Exception('Download failed: HTTP ${response.statusCode}');
      }
      return response.bodyBytes;
    } finally {
      client.close();
    }
  }
}
