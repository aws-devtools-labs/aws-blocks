// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.json

import io.kotest.matchers.shouldBe
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlin.test.Test

class BlocksJsonTest {

    @Serializable
    data class Simple(val name: String, val age: Int)

    @Serializable
    data class WithOptional(val name: String, val nickname: String? = null)

    @Test
    fun decodesRequiredFields() {
        val element = buildJsonObject {
            put("name", JsonPrimitive("Alice"))
            put("age", JsonPrimitive(30))
        }
        val result = BlocksJson.decodeFromJsonElement<Simple>(element)
        result shouldBe Simple("Alice", 30)
    }

    @Test
    fun ignoresUnknownKeys() {
        val element = buildJsonObject {
            put("name", JsonPrimitive("Alice"))
            put("age", JsonPrimitive(30))
            put("extra", JsonPrimitive("ignored"))
        }
        val result = BlocksJson.decodeFromJsonElement<Simple>(element)
        result shouldBe Simple("Alice", 30)
    }

    @Test
    fun decodesNullOptionalField() {
        val element = buildJsonObject {
            put("name", JsonPrimitive("Alice"))
            put("nickname", JsonNull)
        }
        val result = BlocksJson.decodeFromJsonElement<WithOptional>(element)
        result shouldBe WithOptional("Alice", null)
    }

    @Test
    fun decodesMissingOptionalField() {
        val element = buildJsonObject {
            put("name", JsonPrimitive("Alice"))
        }
        val result = BlocksJson.decodeFromJsonElement<WithOptional>(element)
        result shouldBe WithOptional("Alice", null)
    }
}
