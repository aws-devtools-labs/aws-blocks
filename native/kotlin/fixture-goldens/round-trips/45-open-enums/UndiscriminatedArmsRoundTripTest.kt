// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.example.app.roundtrip

import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api.GetJob
import com.example.app.Failed
import com.example.app.Pending
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * Fixture 45: `GetJob.Result` is `Pending | Failed` with no discriminator, decoded by trying the
 * arms in turn. Their enums stay closed, so an object meant for `Failed` isn't taken by `Pending`.
 */
class UndiscriminatedArmsRoundTripTest : FunSpec({

    val serializer = GetJob.Result.serializer()

    test("an object for the second arm decodes to it, with its fields") {
        val wire = json("""{"state":"error","message":"boom"}""")
        val result = BlocksJson.decodeFromJsonElement(serializer, wire)
        result shouldBe GetJob.Result.Error(Failed.State.Error, "boom")
        BlocksJson.encodeToJsonElement(serializer, result) shouldBe wire
    }

    test("the first arm still decodes, including its list of enums") {
        val wire = json("""{"state":"loading","steps":["fetch","parse"]}""")
        BlocksJson.decodeFromJsonElement(serializer, wire) shouldBe
            GetJob.Result.Pending(Pending.State.Loading, listOf(Pending.Steps.Fetch, Pending.Steps.Parse))
    }

    test("a value neither arm declares matches no arm") {
        for (text in listOf("""{"state":"paused"}""", """{"state":"idle","steps":["later"]}""")) {
            shouldThrow<SerializationException> { BlocksJson.decodeFromJsonElement(serializer, json(text)) }
        }
    }
})
