package com.example.app.roundtrip

import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api.GetNotification
import com.example.app.Api.UpdateAttributes
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

private val resultMap = MapSerializer(String.serializer(), UpdateAttributes.Result.serializer().nullable)

/**
 * Fixture 24: `UpdateAttributes.Result` is discriminated by the **boolean** `isUpdated`, and
 * `GetNotification.Result` by the string `type`. The wire format is the spec's: the discriminator
 * is the property the spec names, with the JSON type the spec gives it.
 */
class BooleanDiscriminatorRoundTripTest : FunSpec({

    val wire = json(
        """{"email":{"isUpdated":true},"phone":{"isUpdated":false,"nextStep":{"name":"CONFIRM","destination":"+1***"}},"name":null}""",
    )
    val decoded = mapOf(
        "email" to UpdateAttributes.Result.IsUpdatedTrue,
        "phone" to UpdateAttributes.Result.IsUpdatedFalse(UpdateAttributes.Result.IsUpdatedFalse.NextStep("CONFIRM", "+1***")),
        "name" to null,
    )

    test("a boolean discriminator decodes each variant from its JSON boolean") {
        BlocksJson.decodeFromJsonElement(resultMap, wire) shouldBe decoded
    }

    test("a boolean discriminator encodes each variant with its JSON boolean, so the result round-trips") {
        BlocksJson.encodeToJsonElement(resultMap, decoded) shouldBe wire
        BlocksJson.encodeToJsonElement(UpdateAttributes.Result.serializer(), UpdateAttributes.Result.IsUpdatedTrue) shouldBe
            json("""{"isUpdated":true}""")
    }

    test("a boolean discriminator sent as a string, or missing, matches no variant") {
        for (text in listOf("""{"isUpdated":"true"}""", """{"nextStep":{"name":"n","destination":"d"}}""", "true", "[]")) {
            shouldThrow<SerializationException> {
                BlocksJson.decodeFromJsonElement(UpdateAttributes.Result.serializer(), json(text))
            }
        }
    }

    test("a string discriminator reads and writes the spec's property, `type`") {
        val email = json("""{"type":"email","subject":"Hi","body":"Hello"}""")
        val sms = json("""{"type":"sms","message":"Code 1234"}""")
        val serializer = GetNotification.Result.serializer()
        BlocksJson.decodeFromJsonElement(serializer, email) shouldBe GetNotification.Result.Email("Hi", "Hello")
        BlocksJson.decodeFromJsonElement(serializer, sms) shouldBe GetNotification.Result.Sms("Code 1234")
        BlocksJson.encodeToJsonElement(serializer, GetNotification.Result.Email("Hi", "Hello")) shouldBe email
        BlocksJson.encodeToJsonElement(serializer, GetNotification.Result.Sms("Code 1234")) shouldBe sms
        BlocksJson.decodeFromJsonElement(serializer.nullable, json("null")) shouldBe null
    }
})
