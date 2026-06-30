@file:OptIn(ExperimentalSerializationApi::class)

package com.aws.blocks.kotlin.json

import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlin.test.Test
import kotlin.test.assertFailsWith

/**
 * Runtime decode coverage for a status-discriminated result union with a nested
 * discriminated union in an arm — the shape the Cognito `signIn` /
 * `confirmSignIn` RPC methods produce.
 *
 * The sealed classes below mirror a representative slice of the generated
 * golden `native/codegen-fixtures/23-cognito-nested-unions/kotlin/Api.kt`
 * (`Result` + a couple of its nested `NextStep` arms). The golden-file test
 * (`CodegenFixturesTest`) guards that the generator *emits* that code; this
 * test guards that it *behaves* correctly at runtime — `@JsonClassDiscriminator`
 * routing at BOTH the outer (`status`) and nested (`name`) levels, a nested
 * enum field, round-trip, and a clear error on an unknown discriminant. If the
 * generator output changes, regenerate the golden and update this mirror.
 */
class StatusDiscriminatorDecodeTest {

    @Serializable
    data class CognitoUser(val userSub: String, val groups: List<String>)

    @Serializable
    @JsonClassDiscriminator("status")
    sealed class Result {
        @Serializable
        @SerialName("signedIn")
        data class SignedIn(val user: CognitoUser) : Result()

        @Serializable
        @SerialName("continueSignIn")
        data class ContinueSignIn(val nextStep: NextStep) : Result() {
            @Serializable
            @JsonClassDiscriminator("name")
            sealed class NextStep {
                @Serializable
                @SerialName("CONFIRM_SIGN_IN_WITH_TOTP_CODE")
                data class ConfirmSignInWithTotpCode(val session: String) : NextStep()

                @Serializable
                @SerialName("CONTINUE_SIGN_IN_WITH_MFA_SELECTION")
                data class ContinueSignInWithMfaSelection(
                    val session: String,
                    val allowedMFATypes: List<AllowedMFATypes>,
                ) : NextStep() {
                    @Serializable
                    enum class AllowedMFATypes {
                        @SerialName("SMS") Sms,
                        @SerialName("TOTP") Totp,
                        @SerialName("EMAIL") Email,
                    }
                }
            }
        }
    }

    @Test
    fun decodesSignedInArm() {
        val json = """{"status":"signedIn","user":{"userSub":"s","groups":["admins"]}}"""
        val result = BlocksJson.decodeFromString<Result>(json)
        val signedIn = result.shouldBeInstanceOf<Result.SignedIn>()
        signedIn.user.userSub shouldBe "s"
        signedIn.user.groups shouldBe listOf("admins")
    }

    @Test
    fun decodesNestedNextStepArm() {
        val json = """{"status":"continueSignIn","nextStep":{"name":"CONFIRM_SIGN_IN_WITH_TOTP_CODE","session":"sess-1"}}"""
        val result = BlocksJson.decodeFromString<Result>(json)
        val outer = result.shouldBeInstanceOf<Result.ContinueSignIn>()
        val inner = outer.nextStep.shouldBeInstanceOf<Result.ContinueSignIn.NextStep.ConfirmSignInWithTotpCode>()
        inner.session shouldBe "sess-1"
    }

    @Test
    fun decodesNestedArmWithEnumList() {
        val json =
            """{"status":"continueSignIn","nextStep":{"name":"CONTINUE_SIGN_IN_WITH_MFA_SELECTION","session":"s","allowedMFATypes":["SMS","TOTP"]}}"""
        val result = BlocksJson.decodeFromString<Result>(json)
        val outer = result.shouldBeInstanceOf<Result.ContinueSignIn>()
        val inner = outer.nextStep.shouldBeInstanceOf<Result.ContinueSignIn.NextStep.ContinueSignInWithMfaSelection>()
        inner.allowedMFATypes shouldBe listOf(
            Result.ContinueSignIn.NextStep.ContinueSignInWithMfaSelection.AllowedMFATypes.Sms,
            Result.ContinueSignIn.NextStep.ContinueSignInWithMfaSelection.AllowedMFATypes.Totp,
        )
    }

    @Test
    fun nestedRoundTrips() {
        val original: Result = Result.ContinueSignIn(
            Result.ContinueSignIn.NextStep.ConfirmSignInWithTotpCode(session = "sess-2"))
        val encoded = BlocksJson.encodeToString(original)
        (encoded.contains("\"status\":\"continueSignIn\"")) shouldBe true
        (encoded.contains("\"name\":\"CONFIRM_SIGN_IN_WITH_TOTP_CODE\"")) shouldBe true
        BlocksJson.decodeFromString<Result>(encoded) shouldBe original
    }

    @Test
    fun unknownOuterStatusThrows() {
        assertFailsWith<Exception> {
            BlocksJson.decodeFromString<Result>("""{"status":"bogus"}""")
        }
    }

    @Test
    fun unknownNestedNameThrows() {
        assertFailsWith<Exception> {
            BlocksJson.decodeFromString<Result>("""{"status":"continueSignIn","nextStep":{"name":"NOPE"}}""")
        }
    }
}
