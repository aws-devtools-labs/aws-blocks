package com.aws.blocks.kotlin

/**
 * Android configuration, which is empty.
 *
 * Storage lands inside the application's own sandbox, so the OS already supplies the
 * per-application location the JVM target has to be handed.
 */
actual class BlocksPlatformConfig

internal actual fun defaultPlatformConfig(): BlocksPlatformConfig = BlocksPlatformConfig()
