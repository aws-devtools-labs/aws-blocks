import 'package:package_config/package_config.dart';
import 'package:pub_semver/pub_semver.dart';

Version? languageVersionForPackage(
  PackageConfig packageConfig,
  String packageName,
) => _toVersion(packageConfig[packageName]?.languageVersion);

({bool found, Version? version}) languageVersionForUri(
  PackageConfig packageConfig,
  Uri target,
) {
  final package = packageConfig.packageOf(target);
  return (
    found: package != null,
    version: _toVersion(package?.languageVersion),
  );
}

Version? _toVersion(LanguageVersion? languageVersion) => languageVersion == null
    ? null
    : Version(languageVersion.major, languageVersion.minor, 0);
