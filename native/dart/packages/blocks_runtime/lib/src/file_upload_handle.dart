import 'dart:typed_data';
import 'package:http/http.dart' as http;

import 'user_agent_client.dart';

class FileUploadHandle {
  final String url;
  final String? contentType;

  FileUploadHandle._({required this.url, this.contentType});

  factory FileUploadHandle.fromJson(Map<String, dynamic> json) {
    return FileUploadHandle._(
      url: json['url'] as String,
      contentType: json['contentType'] as String?,
    );
  }

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
