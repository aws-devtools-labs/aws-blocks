// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

/// Writes [message] to standard error.
void writeSessionWarning(String message) => stderr.writeln(message);
