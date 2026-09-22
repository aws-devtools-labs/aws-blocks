import 'package:blocks_runtime/src/version.dart';

/// Semver of this AWS Blocks Dart runtime library.
const String blocksRuntimeVersion = packageVersion;

/// The user agent token for this runtime, e.g. `aws-blocks-dart/0.1.3`.
/// Keep the `aws-blocks` prefix: rows without it do not appear in reporting.
const String blocksUserAgentToken = 'aws-blocks-dart/$blocksRuntimeVersion';
