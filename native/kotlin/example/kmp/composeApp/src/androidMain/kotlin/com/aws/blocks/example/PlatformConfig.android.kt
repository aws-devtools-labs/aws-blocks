package com.aws.blocks.example

import com.aws.blocks.kotlin.BlocksPlatformConfig

/** Android storage lands in the app's own sandbox, so there is nothing to configure. */
actual fun platformConfig(): BlocksPlatformConfig = BlocksPlatformConfig()
