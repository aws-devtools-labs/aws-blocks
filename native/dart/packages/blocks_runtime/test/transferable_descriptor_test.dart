// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

Matcher _throwsDescriptor(String needle) => throwsA(
  isA<TransferableException>().having(
    (e) => e.message,
    'message',
    contains(needle),
  ),
);

void main() {
  group('validateTransferableDescriptor', () {
    test('rejects a tag differing only in case', () {
      expect(
        () => validateTransferableDescriptor(<String, dynamic>{
          '__blocks': 'Example-IoT/Device-Link',
        }, expectedTag: 'example-iot/device-link'),
        _throwsDescriptor("got 'Example-IoT/Device-Link'"),
      );
    });

    test('names the expected tag in every rejection message', () {
      for (final json in <Object?>[
        'not-an-object',
        <String, dynamic>{},
        <String, dynamic>{'__blocks': ''},
      ]) {
        expect(
          () => validateTransferableDescriptor(
            json,
            expectedTag: 'example-iot/device-link',
          ),
          _throwsDescriptor("'example-iot/device-link'"),
          reason: '$json',
        );
      }
    });

    test('subject defaults to Transferable and is overridable', () {
      expect(
        () => validateTransferableDescriptor(
          'not-an-object',
          expectedTag: 'example-iot/device-link',
        ),
        // Anchored: "UnknownTransferable for ..." contains "Transferable
        // for ...", so a substring match cannot tell a wrong default apart.
        throwsA(
          isA<TransferableException>().having(
            (e) => e.message,
            'message',
            startsWith("Transferable for 'example-iot/device-link' expected"),
          ),
        ),
      );
      expect(
        () => validateTransferableDescriptor(
          'not-an-object',
          expectedTag: 'example-iot/device-link',
          subject: 'UnknownTransferable',
        ),
        _throwsDescriptor(
          "UnknownTransferable for 'example-iot/device-link' expected",
        ),
      );
    });
  });

  test(
    'UnknownTransferable.fromJson keeps its own subject in every message',
    () {
      for (final json in <Object?>[
        'not-a-map',
        <String, dynamic>{'__blocks': 1},
        <String, dynamic>{'__blocks': ''},
        <String, dynamic>{'__blocks': 'other/tag'},
      ]) {
        expect(
          () => UnknownTransferable.fromJson(json, expectedTag: 'ex/tag'),
          throwsA(
            isA<TransferableException>().having(
              (e) => e.message,
              'message',
              startsWith('UnknownTransferable'),
            ),
          ),
        );
      }
    },
  );
}
