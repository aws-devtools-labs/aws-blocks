// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

@TestOn('vm')
library;

import 'dart:io';

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

/// A standard error stream whose writes fail, as a closed pipe's do.
class _BrokenStderr implements Stdout {
  int writes = 0;

  @override
  void writeln([Object? object = '']) {
    writes++;
    throw const FileSystemException('Broken pipe');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnsupportedError('${invocation.memberName}');
}

/// A [TokenStore] whose writes fail until [failing] is false.
class _FailingWrites extends InMemoryTokenStore {
  bool failing = true;

  @override
  Future<void> set(String key, String value) {
    if (failing) throw StateError('storage is full');
    return super.set(key, value);
  }
}

void main() {
  final api = Uri.parse('https://example.com/cdk-blocks/api');

  test('a warning that cannot be written does not stop later writes', () async {
    final stderr = _BrokenStderr();
    await IOOverrides.runZoned(() async {
      final token = _FailingWrites();
      final store = PersistentSessionStore(store: token, storageKey: 'k')
        ..setCookies('session=a; Path=/', requestUri: api);
      await expectLater(store.flush(), completes);
      expect(stderr.writes, 1);

      token.failing = false;
      store.setCookies('session=b; Path=/', requestUri: api);
      await expectLater(store.flush(), completes);
      expect(await token.get('k'), contains('"value":"b"'));
    }, stderr: () => stderr);
  });
}
