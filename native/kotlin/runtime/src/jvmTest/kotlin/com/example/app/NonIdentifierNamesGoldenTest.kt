package com.example.app

import com.aws.blocks.kotlin.json.BlocksJson
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test

/**
 * Wire coverage for the golden `native/codegen-fixtures/29-non-identifier-names/kotlin/`, which
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

        val decoded = BlocksJson.decodeFromString(Sample_Type__x___.serializer(), payload)

        decoded.run___error__x________id shouldBe "ab"
        decoded.__unnamed shouldBe "dollar"
        decoded.__x_ shouldBe "template"
        decoded.__y_ shouldBe "interpolation"
        decoded.___unnamed shouldBe "comment"
        decoded.q_uote shouldBe "quote"
        decoded.s_ingle shouldBe "single"
        decoded.semi_colon shouldBe "semi"
        decoded.back_tick shouldBe "tick"
        decoded.new_line shouldBe "newline"
        decoded.with_space shouldBe 3
        decoded._9lives shouldBe true
        decoded.kind shouldBe Sample_Type__x___.Kind.SpAce
        json(BlocksJson.encodeToString(Sample_Type__x___.serializer(), decoded)) shouldBe json(payload)
    }

    @Test
    fun enumValuesRoundTrip() {
        val values = mapOf(
            "a\"b" to Sample_Type__x___.Kind.AB,
            "c;d" to Sample_Type__x___.Kind.CD,
            "x`y" to Sample_Type__x___.Kind.XY,
            "new\nline" to Sample_Type__x___.Kind.NewLine,
            "\${x}" to Sample_Type__x___.Kind.X,
            "\\(z)" to Sample_Type__x___.Kind.Z,
            "*/" to Sample_Type__x___.Kind.Unnamed,
            "1st" to Sample_Type__x___.Kind._1st,
            " sp ace" to Sample_Type__x___.Kind.SpAce,
        )
        for ((wire, constant) in values) {
            val encoded = BlocksJson.encodeToString(Sample_Type__x___.Kind.serializer(), constant)
            json(encoded) shouldBe kotlinx.serialization.json.JsonPrimitive(wire)
            BlocksJson.decodeFromString(Sample_Type__x___.Kind.serializer(), encoded) shouldBe constant
        }
    }

    @Test
    fun discriminatedUnionRoundTrips() {
        val create = """{ "ty pe": "cre\"ate", "ti;tle": "hello" }"""
        val remove = """{ "ty pe": "re`move", "${'$'}{id}": "42" }"""
        val serializer = Ns.DoAction.Input.serializer()

        val created = BlocksJson.decodeFromString(serializer, create)
        val removed = BlocksJson.decodeFromString(serializer, remove)

        created shouldBe Ns.DoAction.Input.Cre_ate(ti_tle = "hello")
        removed shouldBe Ns.DoAction.Input.Re_move(__id_ = "42")
        json(BlocksJson.encodeToString(serializer, created)) shouldBe json(create)
        json(BlocksJson.encodeToString(serializer, removed)) shouldBe json(remove)
    }

    @Test
    fun resultKeyRoundTrips() {
        val payload = """{ "ok`": true }"""
        val serializer = Ns.DoAction.Result.serializer()

        val decoded = BlocksJson.decodeFromString(serializer, payload)

        decoded.ok_ shouldBe true
        json(BlocksJson.encodeToString(serializer, decoded)) shouldBe json(payload)
    }
}
