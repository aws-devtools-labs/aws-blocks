import 'dart:typed_data';
import 'package:http/http.dart' as http;

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
    final client = UserAgentClient(http.Client());
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
}
