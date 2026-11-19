// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import kotlinx.atomicfu.atomic
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class BlocksRequest(
    val method: String,
    val params: List<JsonElement>,
    val id: Int,
    @EncodeDefault val jsonrpc: String = "2.0"
) {
    companion object {
        private val counter = atomic(0)
        fun nextId(): Int = counter.incrementAndGet()
    }
}
