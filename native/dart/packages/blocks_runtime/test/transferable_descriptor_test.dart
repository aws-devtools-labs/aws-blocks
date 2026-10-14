import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

Matcher _throwsFormat(String needle) => throwsA(
  isA<FormatException>().having((e) => e.message, 'message', contains(needle)),
);

void main() {
  group('validateTransferableDescriptor', () {
    test('returns the same object when __blocks matches expectedTag', () {
      final descriptor = <String, dynamic>{
        '__blocks': 'example-iot/device-link',
        'endpoint': 'wss://iot.example.com/thing-4417',
      };

      final validated = validateTransferableDescriptor(
        descriptor,
        expectedTag: 'example-iot/device-link',
      );

      expect(validated, same(descriptor));
    });

    test('rejects a tag differing from expectedTag', () {
      expect(
        () => validateTransferableDescriptor(<String, dynamic>{
          '__blocks': 'other/tag',
        }, expectedTag: 'example-iot/device-link'),
        _throwsFormat(
          "expected tag 'example-iot/device-link', got 'other/tag'",
        ),
      );
    });

    test('rejects a tag differing only in case', () {
      expect(
        () => validateTransferableDescriptor(<String, dynamic>{
          '__blocks': 'Example-IoT/Device-Link',
        }, expectedTag: 'example-iot/device-link'),
        _throwsFormat("got 'Example-IoT/Device-Link'"),
      );
    });

    test('rejects a missing __blocks field', () {
      expect(
        () => validateTransferableDescriptor(<String, dynamic>{
          'endpoint': 'wss://iot.example.com',
        }, expectedTag: 'example-iot/device-link'),
        _throwsFormat("expected a string '__blocks' tag"),
      );
    });

    test('rejects a non-string __blocks field', () {
      expect(
        () => validateTransferableDescriptor(<String, dynamic>{
          '__blocks': 42,
        }, expectedTag: 'example-iot/device-link'),
        _throwsFormat("expected a string '__blocks' tag"),
      );
    });

    test('rejects an empty __blocks field', () {
      expect(
        () => validateTransferableDescriptor(<String, dynamic>{
          '__blocks': '',
        }, expectedTag: 'example-iot/device-link'),
        _throwsFormat("expected a non-empty '__blocks' tag"),
      );
    });

    test('rejects a non-object descriptor', () {
      expect(
        () => validateTransferableDescriptor(
          'not-an-object',
          expectedTag: 'example-iot/device-link',
        ),
        _throwsFormat('expected a JSON object'),
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
          _throwsFormat("'example-iot/device-link'"),
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
          isA<FormatException>().having(
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
        _throwsFormat(
          "UnknownTransferable for 'example-iot/device-link' expected",
        ),
      );
    });
  });

  test('UnknownTransferable.fromJson keeps its own subject in every message', () {
    // Cross-language wording contract: these four strings are byte-identical in
    // the Swift and Kotlin runtimes, so the delegation must not leak the
    // validator's default subject.
    for (final json in <Object?>[
      'not-a-map',
      <String, dynamic>{'__blocks': 1},
      <String, dynamic>{'__blocks': ''},
      <String, dynamic>{'__blocks': 'other/tag'},
    ]) {
      expect(
        () => UnknownTransferable.fromJson(json, expectedTag: 'ex/tag'),
        throwsA(
          isA<FormatException>().having(
            (e) => e.message,
            'message',
            startsWith('UnknownTransferable'),
          ),
        ),
      );
    }
  });
}
