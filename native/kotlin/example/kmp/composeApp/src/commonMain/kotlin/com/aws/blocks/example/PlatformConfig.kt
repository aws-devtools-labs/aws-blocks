package com.aws.blocks.example

import com.aws.blocks.kotlin.BlocksPlatformConfig

/**
 * Target-specific Blocks configuration for this app.
 *
 * Desktop has to be told where its stored session lives, because the JVM has no per-application
 * storage of its own — every process the user runs shares one home directory. Android and iOS are
 * handed a private location by the OS, so they configure nothing.
 */
expect fun platformConfig(): BlocksPlatformConfig
