package com.example.app.roundtrip

import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api.GetEvent
import com.example.app.Status
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * Fixture 45: `GetEvent.Result` is a result union discriminated by `kind`, so it is open. An
 * object whose `kind` names no arm decodes to `UnknownValue` (an arm is tagged `unknown`), which
 * keeps the object and writes it back.
 */
class OpenUnionRoundTripTest : FunSpec({

    fun label(event: GetEvent.Result): String = when (event) {
        is GetEvent.Result.Moved -> "moved"
        is GetEvent.Result.Flagged -> "flagged"
        is GetEvent.Result.Unknown -> "arm tagged unknown"
        is GetEvent.Result.UnknownValue -> "unknown ${event.discriminator}"
    }

    test("an unknown arm decodes and round-trips") {
        val wire = json("""{"kind":"archived","by":"someone","at":{"day":3}}""")
        val event = BlocksJson.decodeFromJsonElement(GetEvent.Result.serializer(), wire)
        // An arm is tagged `unknown`, so the fallback is `UnknownValue`.
        event shouldBe GetEvent.Result.UnknownValue(wire.jsonObject)
        label(event) shouldBe "unknown archived"
        BlocksJson.encodeToJsonElement(GetEvent.Result.serializer(), event) shouldBe wire
    }

    test("an arm tagged unknown is a known arm") {
        val wire = json("""{"kind":"unknown","note":"n"}""")
        val event = BlocksJson.decodeFromJsonElement(GetEvent.Result.serializer(), wire)
        label(event) shouldBe "arm tagged unknown"
        BlocksJson.encodeToJsonElement(GetEvent.Result.serializer(), event) shouldBe wire
    }

    test("a known arm still decodes and writes its discriminator") {
        val wire = json("""{"kind":"moved","to":"done"}""")
        val event = BlocksJson.decodeFromJsonElement(GetEvent.Result.serializer(), wire)
        event shouldBe GetEvent.Result.Moved(Status.Done)
        BlocksJson.encodeToJsonElement(GetEvent.Result.serializer(), event) shouldBe wire
    }
})
