package com.aws.blocks.example

import com.aws.blocks.kotlin.BlocksPlatformConfig

/** iOS Keychain items are scoped to the app, so there is nothing to configure. */
actual fun platformConfig(): BlocksPlatformConfig = BlocksPlatformConfig()
