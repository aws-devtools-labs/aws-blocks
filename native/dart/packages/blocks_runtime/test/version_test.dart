import 'package:blocks_runtime/src/version.dart';
import 'package:test/test.dart';

/// The version constant is generated and committed, so the compiler checks nothing.
/// These tests guard the token format and the version constant.
void main() {
  group('blocksUserAgentToken', () {
    // The token format this library commits to: `aws-blocks-<lang>/<semver>` —
    // a bounded lowercase-alphanumeric language segment plus a strict semver.
    final grammar = RegExp(
      r'^aws-blocks-([a-z][a-z0-9]{0,15})/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]{1,20})?)$',
    );

    test('matches the expected token format', () {
      expect(
        grammar.hasMatch(blocksUserAgentToken),
        isTrue,
        reason:
            '$blocksUserAgentToken does not match the expected '
            'aws-blocks-<lang>/<semver> format',
      );
    });

    // Rows whose user agent does not contain `aws-blocks` do not appear in
    // reporting, so renaming the token would lose this library's traffic.
    test('keeps the aws-blocks prefix the warehouse filters on', () {
      expect(blocksUserAgentToken.contains('aws-blocks'), isTrue);
    });

    test('embeds the current version', () {
      expect(
        blocksUserAgentToken,
        equals('aws-blocks-dart/$blocksRuntimeVersion'),
      );
    });
  });

  group('blocksRuntimeVersion', () {
    test('is valid semver', () {
      final semver = RegExp(r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]{1,20})?$');
      expect(
        semver.hasMatch(blocksRuntimeVersion),
        isTrue,
        reason: '$blocksRuntimeVersion is not valid semver',
      );
    });

    // Guards against the generator emitting the `0.0.0` placeholder.
    test('is not a placeholder', () {
      expect(blocksRuntimeVersion, isNot(equals('0.0.0')));
    });
  });
}
