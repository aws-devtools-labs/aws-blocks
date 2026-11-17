// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import io.ktor.client.plugins.logging.Logger
import java.util.logging.Level

internal actual fun platformLogger(): Logger = object : Logger {
    private val javaLogger = java.util.logging.Logger.getLogger("BlocksHttp")

    override fun log(message: String) {
        javaLogger.log(Level.INFO, message)
    }
}
