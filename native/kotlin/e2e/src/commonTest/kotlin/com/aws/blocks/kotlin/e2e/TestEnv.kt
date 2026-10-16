package com.aws.blocks.kotlin.e2e

expect fun getEnv(name: String): String?

/**
 * Marks the running test as skipped, with [reason] in the report.
 *
 * JVM: throws JUnit's `TestAbortedException`, so the test is reported as **skipped**, not
 * passed. Kotlin/Native has no runtime skip: the iOS actual prints `SKIPPED: <reason>` and
 * returns, so the caller must `return@runTest` straight after calling it.
 */
expect fun markSkipped(reason: String)
