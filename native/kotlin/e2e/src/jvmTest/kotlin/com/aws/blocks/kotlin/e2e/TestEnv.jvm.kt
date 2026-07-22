package com.aws.blocks.kotlin.e2e

actual fun getEnv(name: String): String? =
    System.getProperty(name) ?: System.getenv(name)
