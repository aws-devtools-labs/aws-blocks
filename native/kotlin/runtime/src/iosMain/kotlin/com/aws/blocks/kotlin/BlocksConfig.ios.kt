package com.aws.blocks.kotlin

/**
 * iOS configuration, which is empty.
 *
 * Keychain items are scoped to the application's access group, so the OS already supplies the
 * per-application location the JVM target has to be handed.
 */
actual class BlocksPlatformConfig

internal actual fun defaultPlatformConfig(): BlocksPlatformConfig = BlocksPlatformConfig()
