// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_runtime/src/token_store.dart';

/// A [TokenStore] that keeps each value in a file of its own, for pure Dart
/// programs on a desktop or server operating system.
///
/// Not available on the web, where this constructor throws an
/// [UnsupportedError]; see the `dart:io` implementation for the details.
///
/// The class is `final`: implement [TokenStore] for a store of your own.
final class FileTokenStore implements TokenStore {
  /// Throws an [UnsupportedError]: there is no file system on the web.
  FileTokenStore({required String applicationId, String? rootDirectory}) {
    throw UnsupportedError(
      'FileTokenStore needs dart:io and is not available on the web '
      '(application $applicationId).',
    );
  }

  /// The directory this store's files are in.
  String get directoryPath => throw UnsupportedError('FileTokenStore');

  @override
  Future<String?> get(String key) => throw UnsupportedError('FileTokenStore');

  @override
  Future<void> set(String key, String value) =>
      throw UnsupportedError('FileTokenStore');

  @override
  Future<void> delete(String key) => throw UnsupportedError('FileTokenStore');
}
