package com.example.app

import com.aws.blocks.kotlin.json.BlocksJson
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test

/**
 * Wire coverage for the golden `native/codegen-fixtures/43-non-identifier-names/kotlin/`, which
 * this source set compiles as is. The golden's identifiers differ from the spec's keys, so each
 * key must reach the wire through its `@SerialName`: a payload with every key decodes, and
 * encodes back to the same JSON.
 */
class NonIdentifierNamesGoldenTest {

    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    @Test
    fun recordKeysRoundTrip() {
        val payload = """
            {
              "run { error(\"x\") } || id": "ab",
              "${'$'}": "dollar",
              "${'$'}{x}": "template",
              "\\(y)": "interpolation",
              "*/": "comment",
              "q\"uote": "quote",
              "s'ingle": "single",
              "semi;colon": "semi",
              "back`tick": "tick",
              "new\nline": "newline",
              "with space": 3,
              "9lives": true,
              "kind": " sp ace"
            }
        """.trimIndent()

        val decoded = BlocksJson.decodeFromString(SampleTypeX.serializer(), payload)

        decoded.`run { error("x") } || id` shouldBe "ab"
        decoded.`$` shouldBe "dollar"
        decoded.`${x}` shouldBe "template"
        decoded.y shouldBe "interpolation"
        decoded.unnamed shouldBe "comment"
        decoded.`q"uote` shouldBe "quote"
        decoded.`s'ingle` shouldBe "single"
        decoded.semiColon shouldBe "semi"
        decoded.backTick shouldBe "tick"
        decoded.newLine shouldBe "newline"
        decoded.`with space` shouldBe 3
        decoded.`9lives` shouldBe true
        decoded.kind shouldBe SampleTypeX.Kind.SpAce
        json(BlocksJson.encodeToString(SampleTypeX.serializer(), decoded)) shouldBe json(payload)
    }

    @Test
    fun enumValuesRoundTrip() {
        val values = mapOf(
            "a\"b" to SampleTypeX.Kind.AB,
            "c;d" to SampleTypeX.Kind.CD,
            "x`y" to SampleTypeX.Kind.XY,
            "new\nline" to SampleTypeX.Kind.NewLine,
            "\${x}" to SampleTypeX.Kind.X,
            "\\(z)" to SampleTypeX.Kind.Z,
            "*/" to SampleTypeX.Kind.Unnamed,
            "1st" to SampleTypeX.Kind.`1st`,
            " sp ace" to SampleTypeX.Kind.SpAce,
        )
        for ((wire, constant) in values) {
            val encoded = BlocksJson.encodeToString(SampleTypeX.Kind.serializer(), constant)
            json(encoded) shouldBe kotlinx.serialization.json.JsonPrimitive(wire)
            BlocksJson.decodeFromString(SampleTypeX.Kind.serializer(), encoded) shouldBe constant
        }
    }

    @Test
    fun discriminatedUnionRoundTrips() {
        val create = """{ "ty pe": "cre\"ate", "ti;tle": "hello" }"""
        val remove = """{ "ty pe": "re`move", "${'$'}{id}": "42" }"""
        val serializer = Ns.DoAction.Input.serializer()

        val created = BlocksJson.decodeFromString(serializer, create)
        val removed = BlocksJson.decodeFromString(serializer, remove)

        created shouldBe Ns.DoAction.Input.CreAte(tiTle = "hello")
        removed shouldBe Ns.DoAction.Input.ReMove(`${id}` = "42")
        json(BlocksJson.encodeToString(serializer, created)) shouldBe json(create)
        json(BlocksJson.encodeToString(serializer, removed)) shouldBe json(remove)
    }

    @Test
    fun resultKeyRoundTrips() {
        val payload = """{ "ok`": true }"""
        val serializer = Ns.DoAction.Result.serializer()

        val decoded = BlocksJson.decodeFromString(serializer, payload)

        decoded.ok shouldBe true
        json(BlocksJson.encodeToString(serializer, decoded)) shouldBe json(payload)
    }
}
