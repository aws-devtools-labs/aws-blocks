// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:blocks_runtime/src/version.dart';

const String blocksRuntimeVersion = packageVersion;

/// The user agent token for this runtime, e.g. `aws-blocks-dart/0.1.3`.
/// Keep the `aws-blocks` prefix: rows without it do not appear in reporting.
const String blocksUserAgentToken = 'aws-blocks-dart/$blocksRuntimeVersion';
