package com.aws.blocks.kotlin.e2e

import platform.Foundation.NSProcessInfo

actual fun getEnv(name: String): String? =
    NSProcessInfo.processInfo.environment[name] as? String
