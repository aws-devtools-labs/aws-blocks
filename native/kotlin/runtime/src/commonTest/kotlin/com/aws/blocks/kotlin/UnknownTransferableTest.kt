package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.TransferableException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeSameInstanceAs
import kotlin.test.Test
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class UnknownTransferableTest {

    @Test
    fun `accepts an object whose __blocks matches expectedTag`() {
        val descriptor = buildJsonObject {
            put("__blocks", "example-iot/device-link")
            put("endpoint", "wss://iot.example.com/thing-4417")
        }

        val unknown = UnknownTransferable.fromJson(descriptor, expectedTag = "example-iot/device-link")

        unknown.tag shouldBe "example-iot/device-link"
        unknown.descriptor shouldBeSameInstanceAs descriptor
    }

    @Test
    fun `keeps the four messages the Dart and Swift runtimes emit`() {
        val tag = "example-iot/device-link"
        val cases = listOf<Pair<JsonElement, String>>(
            JsonPrimitive("not-an-object") to
                "UnknownTransferable for '$tag' expected a JSON object descriptor",
            JsonObject(mapOf("__blocks" to JsonPrimitive(1))) to
                "UnknownTransferable for '$tag' expected a string '__blocks' tag",
            JsonObject(mapOf("__blocks" to JsonPrimitive(""))) to
                "UnknownTransferable for '$tag' expected a non-empty '__blocks' tag",
            JsonObject(mapOf("__blocks" to JsonPrimitive("other/tag"))) to
                "UnknownTransferable expected tag '$tag', got 'other/tag'",
        )
        for ((element, expected) in cases) {
            shouldThrow<TransferableException> {
                UnknownTransferable.fromJson(element, expectedTag = tag)
            }.message shouldBe expected
        }
    }
}
