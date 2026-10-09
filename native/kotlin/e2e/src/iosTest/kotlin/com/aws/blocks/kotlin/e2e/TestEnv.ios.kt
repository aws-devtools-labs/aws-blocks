package com.aws.blocks.kotlin.e2e

import platform.Foundation.NSProcessInfo

actual fun getEnv(name: String): String? =
    NSProcessInfo.processInfo.environment[name] as? String

actual fun markSkipped(reason: String) {
    // Kotlin/Native's test runner has no runtime skip; print the reason so the run log shows it.
    println("SKIPPED: $reason")
}
