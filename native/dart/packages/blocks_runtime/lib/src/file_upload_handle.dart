// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:typed_data';
import 'package:http/http.dart' as http;

import 'file_transfer_exception.dart';
import 'transferable_descriptor.dart';
import 'transport.dart';
import 'user_agent_client.dart';

class FileUploadHandle {
  final String url;
  final String? contentType;

  FileUploadHandle._({required this.url, this.contentType});

  /// Throws an `InvalidDescriptorException` when [json] has no string `url`.
  factory FileUploadHandle.fromJson(Map<String, dynamic> json) {
    return FileUploadHandle._(
      url: requireDescriptorField<String>(
        json,
        'url',
        tag: 'file-bucket/upload',
        subject: 'FileUploadHandle',
      ),
      contentType: json['contentType'] as String?,
    );
  }

  String getUrl() => url;

  /// PUTs [bytes] to the presigned URL.
  ///
  /// Throws a [FileTransferException] when the URL rejects the upload, with
  /// the HTTP status as [FileTransferException.statusCode], or when no
  /// response arrives, with the HTTP client's error as its `cause`.
  Future<void> upload(Uint8List bytes) async {
    final headers = <String, String>{};
    if (contentType != null) headers['Content-Type'] = contentType!;
    final client = UserAgentClient(http.Client());
    try {
      final response = await guardTransport(
        () => client.put(Uri.parse(url), headers: headers, body: bytes),
        (e) => FileTransferException(
          'Upload failed: ${transportFailureMessage(e)}',
          cause: e,
        ),
      );
      if (response.statusCode != 200 && response.statusCode != 204) {
        throw FileTransferException(
          'Upload failed: HTTP ${response.statusCode}',
          statusCode: response.statusCode,
        );
      }
    } finally {
      client.close();
    }
  }
}
