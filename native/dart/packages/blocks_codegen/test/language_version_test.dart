import 'package:blocks_codegen/src/language_version.dart';
import 'package:package_config/package_config.dart';
import 'package:pub_semver/pub_semver.dart';
import 'package:test/test.dart';

void main() {
  final config = PackageConfig([
    Package(
      'blocks_codegen',
      Uri.parse('file:///workspace/blocks_codegen/'),
      languageVersion: LanguageVersion(3, 11),
    ),
    Package(
      'input_package',
      Uri.parse('file:///workspace/input_package/'),
      languageVersion: LanguageVersion(3, 13),
    ),
    Package('no_version', Uri.parse('file:///workspace/no_version/')),
  ]);

  test('selects and converts the requested package language version', () {
    expect(
      languageVersionForPackage(config, 'input_package'),
      Version(3, 13, 0),
    );
  });

  test('returns null for an absent package or language version', () {
    expect(languageVersionForPackage(config, 'absent'), isNull);
    expect(languageVersionForPackage(config, 'no_version'), isNull);
  });

  test('maps a target URI and distinguishes an absent target', () {
    expect(
      languageVersionForUri(
        config,
        Uri.file('/workspace/input_package/lib/client.dart'),
      ),
      (found: true, version: Version(3, 13, 0)),
    );
    expect(languageVersionForUri(config, Uri.file('/outside/client.dart')), (
      found: false,
      version: null,
    ));
  });
}
