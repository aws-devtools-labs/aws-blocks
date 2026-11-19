// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.e2e

import org.opentest4j.TestAbortedException

actual fun getEnv(name: String): String? =
    System.getProperty(name) ?: System.getenv(name)

actual fun markSkipped(reason: String) {
    throw TestAbortedException(reason)
}
