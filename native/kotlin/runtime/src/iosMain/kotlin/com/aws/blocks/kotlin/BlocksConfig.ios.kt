package com.aws.blocks.kotlin

/**
 * iOS configuration, which is empty.
 *
 * Keychain items are scoped to the application's access group, so the OS already supplies the
 * per-application location the JVM target has to be handed.
 */
actual class BlocksPlatformConfig {
    // There is nothing in here to differ, so every instance is the same configuration.
    // Without this, two of them compare unequal and anything keyed on the configuration
    // -- a `remember` in Compose, say -- rebuilds on every pass.
    override fun equals(other: Any?): Boolean = other is BlocksPlatformConfig

    override fun hashCode(): Int = 0
}

internal actual fun defaultPlatformConfig(): BlocksPlatformConfig = BlocksPlatformConfig()
