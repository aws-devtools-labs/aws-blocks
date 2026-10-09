package com.example.app.roundtrip

import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.AuthApi.SetAuthState
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * Fixture 18 mirrors the live `Auth` block's spec. `SetAuthState.Input` is discriminated by
 * `action`; its `confirmSignIn` arm is a hybrid: the arm's own properties (`session`) and a nested
 * union discriminated by `challenge` describe **one flat JSON object**, which is what the server
 * reads.
 */
class HybridArmRoundTripTest : FunSpec({

    val serializer = SetAuthState.Input.serializer()

    test("a hybrid arm writes its nested union's discriminator and fields flat, beside its own properties") {
        val input = SetAuthState.Input.ConfirmSignIn(
            session = "sess-1",
            challenge = SetAuthState.Input.ConfirmSignIn.Challenge.TotpSetup(sharedSecret = "S3CR3T", code = "123456"),
        )
        val wire = json("""{"action":"confirmSignIn","session":"sess-1","challenge":"totpSetup","sharedSecret":"S3CR3T","code":"123456"}""")
        BlocksJson.encodeToJsonElement(serializer, input) shouldBe wire
        BlocksJson.decodeFromJsonElement(serializer, wire) shouldBe input
    }

    test("each challenge of the hybrid arm round-trips") {
        val cases = listOf(
            SetAuthState.Input.ConfirmSignIn.Challenge.Code("1234") to """"challenge":"code","code":"1234"""",
            SetAuthState.Input.ConfirmSignIn.Challenge.NewPassword("pw") to """"challenge":"newPassword","newPassword":"pw"""",
            SetAuthState.Input.ConfirmSignIn.Challenge.FirstFactor("PASSWORD") to """"challenge":"firstFactor","firstFactor":"PASSWORD"""",
        )
        for ((challenge, fields) in cases) {
            val input = SetAuthState.Input.ConfirmSignIn(session = "s", challenge = challenge)
            val wire = json("""{"action":"confirmSignIn","session":"s",$fields}""")
            BlocksJson.encodeToJsonElement(serializer, input) shouldBe wire
            BlocksJson.decodeFromJsonElement(serializer, wire) shouldBe input
        }
    }

    test("a plain discriminated arm is unchanged: `action` and its properties") {
        val wire = json("""{"action":"signIn","username":"ana","password":"pw"}""")
        val input = SetAuthState.Input.SignIn(username = "ana", password = "pw")
        BlocksJson.encodeToJsonElement(serializer, input) shouldBe wire
        BlocksJson.decodeFromJsonElement(serializer, wire) shouldBe input
        BlocksJson.encodeToJsonElement(serializer, SetAuthState.Input.SignOut) shouldBe json("""{"action":"signOut"}""")
    }
})
