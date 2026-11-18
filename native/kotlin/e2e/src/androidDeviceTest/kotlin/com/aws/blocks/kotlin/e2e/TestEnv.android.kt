// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.e2e

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.AssumptionViolatedException

/**
 * Instrumented tests run in a process forked from zygote, not from a shell, so no environment
 * variable set alongside the test command can reach it. The values arrive as instrumentation
 * arguments instead (`-Pandroid.testInstrumentationRunnerArguments.BLOCKS_URL=…`, wired in
 * `build.gradle.kts`, or `-e BLOCKS_URL …` for a hand-run `am instrument`).
 */
actual fun getEnv(name: String): String? =
    InstrumentationRegistry.getArguments().getString(name)?.takeIf { it.isNotBlank() }

actual fun markSkipped(reason: String) {
    throw AssumptionViolatedException(reason)
}
