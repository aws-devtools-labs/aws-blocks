// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';

import 'flutter_secure_store_test.mocks.dart';

// No TestWidgetsFlutterBinding.ensureInitialized() here: this file checks
// what happens in an app that has not created a binding yet.
void main() {
  test('the first read creates the binding the plugin needs', () async {
    final storage = MockFlutterSecureStorage();
    when(storage.read(key: 'k')).thenAnswer((_) async => 'v');
    expect(
      () => WidgetsBinding.instance,
      throwsA(anything),
      reason: 'no binding before the store is used',
    );

    expect(await FlutterSecureStore(storage: storage).get('k'), 'v');
    expect(WidgetsBinding.instance, isA<WidgetsFlutterBinding>());
  });
}
