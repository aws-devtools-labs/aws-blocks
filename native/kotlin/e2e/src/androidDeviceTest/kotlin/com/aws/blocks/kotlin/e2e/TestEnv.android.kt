package com.aws.blocks.kotlin.e2e

import androidx.test.platform.app.InstrumentationRegistry
import org.junit.AssumptionViolatedException

/**
 * Instrumented tests run in a process Gradle does not launch, so there is no environment to read.
 * The values arrive as instrumentation arguments instead
 * (`-Pandroid.testInstrumentationRunnerArguments.BLOCKS_URL=…`, wired in `build.gradle.kts`).
 * `System.getenv` is still consulted so an `adb shell am instrument` run can set either.
 */
actual fun getEnv(name: String): String? =
    InstrumentationRegistry.getArguments().getString(name)?.takeIf { it.isNotBlank() }
        ?: System.getenv(name)

actual fun markSkipped(reason: String) {
    throw AssumptionViolatedException(reason)
}
