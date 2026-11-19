// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:blocks_runtime_flutter/blocks_runtime_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

/// Flutter's plugin registrant calls `<dartPluginClass>.registerWith()` before
/// `main` for each platform the pubspec lists. `flutter test` does not run the
/// registrant, so this checks the declaration it reads.
void main() {
  test('the pubspec declares the plugin class on every non-web platform', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final flutterSection = pubspec.substring(pubspec.indexOf('\nflutter:\n'));
    final platforms = RegExp(
      r'^      (\w+):\n        dartPluginClass: (\w+)$',
      multiLine: true,
    ).allMatches(flutterSection).map((m) => (m.group(1), m.group(2))).toList();

    expect(platforms.map((p) => p.$1), [
      'android',
      'ios',
      'linux',
      'macos',
      'windows',
    ]);
    expect(platforms.map((p) => p.$2).toSet(), {'BlocksRuntimeFlutterPlugin'});
    // The browser keeps the session cookies there; nothing to register.
    expect(flutterSection, isNot(contains('web:')));
  });

  test('the declared class has the static registerWith Flutter calls', () {
    // A tear-off of `void Function()` compiles only if it exists with that
    // signature, which is what the generated registrant calls.
    const void Function() registrant = BlocksRuntimeFlutterPlugin.registerWith;
    expect(registrant, isNotNull);
  });
}
