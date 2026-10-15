package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.TransferableException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.types.shouldBeSameInstanceAs
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

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
    fun `rejects an object whose __blocks tag differs from expectedTag`() {
        val exception = shouldThrow<TransferableException> {
            UnknownTransferable.fromJson(
                buildJsonObject { put("__blocks", "other/tag") },
                expectedTag = "example-iot/device-link",
            )
        }
        exception.message shouldContain "expected tag 'example-iot/device-link', got 'other/tag'"
    }

    @Test
    fun `rejects an object missing the __blocks field`() {
        val exception = shouldThrow<TransferableException> {
            UnknownTransferable.fromJson(
                buildJsonObject { put("endpoint", "wss://iot.example.com") },
                expectedTag = "example-iot/device-link",
            )
        }
        exception.message shouldContain "expected a string '__blocks' tag"
    }

    @Test
    fun `rejects an object whose __blocks is an empty string`() {
        val exception = shouldThrow<TransferableException> {
            UnknownTransferable.fromJson(
                buildJsonObject { put("__blocks", "") },
                expectedTag = "example-iot/device-link",
            )
        }
        exception.message shouldContain "expected a non-empty '__blocks' tag"
    }

    @Test
    fun `rejects an object whose __blocks is not a string`() {
        val exception = shouldThrow<TransferableException> {
            UnknownTransferable.fromJson(
                buildJsonObject { put("__blocks", 42) },
                expectedTag = "example-iot/device-link",
            )
        }
        exception.message shouldContain "expected a string '__blocks' tag"
    }

    @Test
    fun `rejects an object whose __blocks is JSON null`() {
        val exception = shouldThrow<TransferableException> {
            UnknownTransferable.fromJson(
                buildJsonObject { put("__blocks", JsonNull) },
                expectedTag = "example-iot/device-link",
            )
        }
        exception.message shouldContain "expected a string '__blocks' tag"
    }

    @Test
    fun `rejects a non-object descriptor`() {
        val exception = shouldThrow<TransferableException> {
            UnknownTransferable.fromJson(
                JsonPrimitive("not-an-object"),
                expectedTag = "example-iot/device-link",
            )
        }
        exception.message shouldContain "expected a JSON object descriptor"
    }

    @Test
    fun `names the expected tag in a rejection message`() {
        val exception = shouldThrow<TransferableException> {
            UnknownTransferable.fromJson(
                JsonPrimitive("not-an-object"),
                expectedTag = "example-iot/device-link",
            )
        }
        exception.message shouldContain "'example-iot/device-link'"
    }
}
