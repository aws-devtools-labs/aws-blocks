// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

/// Asserts a [TransferableException] whose message contains [needle], so a test
/// distinguishes the four rejection branches rather than accepting any throw.
Matcher _throwsDescriptor(String needle) => throwsA(
  isA<TransferableException>().having(
    (e) => e.message,
    'message',
    contains(needle),
  ),
);

void main() {
  group('UnknownTransferable.fromJson', () {
    test('accepts an object whose __blocks matches expectedTag', () {
      final descriptor = <String, dynamic>{
        '__blocks': 'example-iot/device-link',
        'endpoint': 'wss://iot.example.com/thing-4417',
      };

      final unknown = UnknownTransferable.fromJson(
        descriptor,
        expectedTag: 'example-iot/device-link',
      );

      expect(unknown.tag, 'example-iot/device-link');
      expect(unknown.descriptor, same(descriptor));
    });

    test('rejects an object whose __blocks tag differs from expectedTag', () {
      expect(
        () => UnknownTransferable.fromJson(<String, dynamic>{
          '__blocks': 'other/tag',
        }, expectedTag: 'example-iot/device-link'),
        _throwsDescriptor(
          "expected tag 'example-iot/device-link', got 'other/tag'",
        ),
      );
    });

    test('rejects an object missing the __blocks field', () {
      expect(
        () => UnknownTransferable.fromJson(<String, dynamic>{
          'endpoint': 'wss://iot.example.com',
        }, expectedTag: 'example-iot/device-link'),
        _throwsDescriptor("expected a string '__blocks' tag"),
      );
    });

    test('rejects an object whose __blocks is an empty string', () {
      expect(
        () => UnknownTransferable.fromJson(<String, dynamic>{
          '__blocks': '',
        }, expectedTag: 'example-iot/device-link'),
        _throwsDescriptor("expected a non-empty '__blocks' tag"),
      );
    });

    test('rejects an object whose __blocks is not a string', () {
      expect(
        () => UnknownTransferable.fromJson(<String, dynamic>{
          '__blocks': 42,
        }, expectedTag: 'example-iot/device-link'),
        _throwsDescriptor("expected a string '__blocks' tag"),
      );
    });

    test('rejects a non-object descriptor', () {
      expect(
        () => UnknownTransferable.fromJson(
          'not-an-object',
          expectedTag: 'example-iot/device-link',
        ),
        _throwsDescriptor('expected a JSON object'),
      );
    });

    test('names the expected tag in a rejection message', () {
      expect(
        () => UnknownTransferable.fromJson(
          'not-an-object',
          expectedTag: 'example-iot/device-link',
        ),
        _throwsDescriptor("'example-iot/device-link'"),
      );
    });
  });
}
