package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.TransferableException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.types.shouldBeSameInstanceAs
import kotlin.test.Test
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class TransferableDescriptorTest {

    @Test
    fun `returns the descriptor when __blocks matches expectedTag`() {
        val descriptor = buildJsonObject {
            put("__blocks", "example-iot/device-link")
            put("endpoint", "wss://iot.example.com/thing-4417")
        }

        validateTransferableDescriptor(
            descriptor,
            expectedTag = "example-iot/device-link",
        ) shouldBeSameInstanceAs descriptor
    }

    @Test
    fun `rejects a tag differing only in case`() {
        shouldThrow<TransferableException> {
            validateTransferableDescriptor(
                buildJsonObject { put("__blocks", "Example-IoT/Device-Link") },
                expectedTag = "example-iot/device-link",
            )
        }.message shouldContain "expected tag 'example-iot/device-link'"
    }

    @Test
    fun `rejects a tag padded with whitespace`() {
        shouldThrow<TransferableException> {
            validateTransferableDescriptor(
                buildJsonObject { put("__blocks", "  example-iot/device-link \t\n") },
                expectedTag = "example-iot/device-link",
            )
        }.message shouldContain "expected tag 'example-iot/device-link', got '  example-iot/device-link"
    }

    @Test
    fun `treats a whitespace-only tag as a mismatch rather than as empty`() {
        shouldThrow<TransferableException> {
            validateTransferableDescriptor(
                buildJsonObject { put("__blocks", " ") },
                expectedTag = "example-iot/device-link",
            )
        }.message shouldContain "expected tag 'example-iot/device-link', got ' '"
    }

    @Test
    fun `names the subject and the expected tag in all four rejections`() {
        val tag = "example-iot/device-link"
        val cases = listOf<Pair<JsonElement, String>>(
            JsonPrimitive("not-an-object") to
                "Transferable for '$tag' expected a JSON object descriptor",
            JsonObject(mapOf("__blocks" to JsonPrimitive(1))) to
                "Transferable for '$tag' expected a string '__blocks' tag",
            JsonObject(mapOf("__blocks" to JsonPrimitive(""))) to
                "Transferable for '$tag' expected a non-empty '__blocks' tag",
            JsonObject(mapOf("__blocks" to JsonPrimitive("other/tag"))) to
                "Transferable expected tag '$tag', got 'other/tag'",
        )
        for ((element, expected) in cases) {
            shouldThrow<TransferableException> {
                validateTransferableDescriptor(element, expectedTag = tag)
            }.message shouldBe expected
        }
    }

    @Test
    fun `rejects a descriptor with no __blocks key`() {
        shouldThrow<TransferableException> {
            validateTransferableDescriptor(
                buildJsonObject { put("endpoint", "wss://iot.example.com") },
                expectedTag = "example-iot/device-link",
            )
        }.message shouldBe "Transferable for 'example-iot/device-link' expected a string '__blocks' tag"
    }

    @Test
    fun `an empty expectedTag still rejects an empty wire tag`() {
        shouldThrow<TransferableException> {
            validateTransferableDescriptor(
                JsonObject(mapOf("__blocks" to JsonPrimitive(""))),
                expectedTag = "",
            )
        }.message shouldBe "Transferable for '' expected a non-empty '__blocks' tag"
    }
}
