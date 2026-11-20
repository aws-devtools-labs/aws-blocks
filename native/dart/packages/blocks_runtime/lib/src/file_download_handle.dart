// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:typed_data';
import 'package:http/http.dart' as http;

import 'file_transfer_exception.dart';
import 'transferable_descriptor.dart';
import 'transport.dart';
import 'user_agent_client.dart';

class FileDownloadHandle {
  final String url;

  FileDownloadHandle._({required this.url});

  /// Throws an `InvalidDescriptorException` when [json] has no string `url`.
  factory FileDownloadHandle.fromJson(Map<String, dynamic> json) {
    return FileDownloadHandle._(
      url: requireDescriptorField<String>(
        json,
        'url',
        tag: 'file-bucket/download',
        subject: 'FileDownloadHandle',
      ),
    );
  }

  String getUrl() => url;

  /// GETs the file from the presigned URL.
  ///
  /// Throws a [FileTransferException] when the URL rejects the download, with
  /// the HTTP status as [FileTransferException.statusCode], or when no
  /// response arrives, with the HTTP client's error as its `cause`.
  Future<Uint8List> download() async {
    final client = UserAgentClient(http.Client());
    try {
      final response = await guardTransport(
        () => client.get(Uri.parse(url)),
        (e) => FileTransferException(
          'Download failed: ${transportFailureMessage(e)}',
          cause: e,
        ),
      );
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
}
