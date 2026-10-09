package com.aws.blocks.kotlin.e2e

import blocks.e2e.Api
import blocks.e2e.Api.CognitoSignIn
import blocks.e2e.AuthenticatedUser
import com.aws.blocks.kotlin.json.BlocksJson
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlin.test.Test
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * `unknown`-typed values generate as `JsonElement`. `AuthenticatedUser.claims`
 * (`Record<string, unknown>`, optional and nullable) is the generated `Map<String, JsonElement>?`
 * these tests exercise: it must compile in a `@Serializable` class and carry any JSON value.
 */
class UnknownValuesE2ETest {

    private fun user(claims: Map<String, JsonElement>?) = AuthenticatedUser(
        userSub = "sub-1",
        groups = listOf(AuthenticatedUser.Groups.Users),
        attributes = mapOf("email" to "a@example.com", "phone_number" to null),
        signInProvider = AuthenticatedUser.SignInProvider.Password,
        claims = claims,
        userId = "user-1",
        username = "alice",
    )

    @Test
    fun claimsOfEveryJsonKindRoundTrip() {
        val claims: Map<String, JsonElement> = mapOf(
            "iss" to JsonPrimitive("https://idp.example.com"),
            "exp" to JsonPrimitive(1_767_225_600),
            "ratio" to JsonPrimitive(0.5),
            "email_verified" to JsonPrimitive(true),
            "amr" to buildJsonArray { add(JsonPrimitive("pwd")); add(JsonPrimitive("mfa")) },
            "address" to buildJsonObject { put("country", "NZ"); put("postal_code", JsonNull) },
            "nickname" to JsonNull,
        )
        val original = user(claims)

        val encoded = BlocksJson.encodeToJsonElement(original)
        encoded.jsonObject["claims"] shouldBe JsonObject(claims)

        val decoded = BlocksJson.decodeFromJsonElement<AuthenticatedUser>(encoded)
        decoded shouldBe original
        decoded.claims.shouldNotBeNull()["exp"] shouldBe JsonPrimitive(1_767_225_600)
    }

    @Test
    fun absentAndNullClaimsDecodeAsNull() {
        val wire = BlocksJson.encodeToJsonElement(user(claims = null)).jsonObject
        val absent = buildJsonObject { wire.filterKeys { it != "claims" }.forEach { (k, v) -> put(k, v) } }
        val explicitNull = buildJsonObject {
            absent.forEach { (k, v) -> put(k, v) }
            put("claims", JsonNull)
        }

        BlocksJson.decodeFromJsonElement<AuthenticatedUser>(absent).claims.shouldBeNull()
        BlocksJson.decodeFromJsonElement<AuthenticatedUser>(explicitNull).claims.shouldBeNull()
    }

    /** A user pool's `AuthenticatedUser`, as the server sends it, decodes through the generated class. */
    @Test
    fun cognitoUserFromTheServerDecodes() = runTest {
        if (!isLocalEndpoint()) {
            markSkipped(NEEDS_LOCAL_CODE)
            return@runTest
        }
        val api: Api = createApi()
        val username = uniqueUsername("claims")
        api.cognitoSignUp(username, E2E_PASSWORD, "$username@example.com")
        val code = api.cognitoGetLastCode(username).shouldNotBeNull()
        api.cognitoConfirmSignUp(username, code.code)

        val signedIn = api.cognitoSignIn(username, E2E_PASSWORD).shouldBeInstanceOf<CognitoSignIn.Result.SignedIn>()
        signedIn.user.username shouldBe username
        // Pool users carry no claims (only direct-OIDC users do), so the field is absent on the wire.
        signedIn.user.claims.shouldBeNull()
        api.cognitoGetCurrentUser().shouldNotBeNull().userSub shouldBe signedIn.user.userSub
        api.cognitoSignOut()
    }
}
