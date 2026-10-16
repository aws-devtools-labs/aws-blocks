package com.aws.blocks.kotlin.e2e

import blocks.e2e.AuthCognitoApi
import blocks.e2e.AuthState
import com.aws.blocks.kotlin.json.BlocksJson
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlin.test.Test
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

/**
 * Sign-up attributes through the `Auth` block's state machine (`createApi()`), as the
 * Authenticator sends them. The `signUp` action is an open record: `username` and `password`
 * are its properties, and every other key is a user attribute, flat beside them on the wire
 * (`{"action":"signUp","username":…,"password":…,"email":…,"name":…}`). The server reads them
 * with a rest spread, so an attribute only reaches the user when it is sent flat.
 */
class AuthSignUpAttributesE2ETest {

    private val api = createApi()
    private val authApi = AuthCognitoApi(server = e2eServer())

    @Test
    fun signUpAttributesReachTheUser() = runTest {
        if (!isLocalEndpoint()) {
            markSkipped(NEEDS_LOCAL_CODE)
            return@runTest
        }
        val username = uniqueUsername("attrs")
        val email = "$username@example.com"

        val state = authApi.setAuthState(
            AuthCognitoApi.SetAuthState.Input.SignUp(
                username = username,
                password = E2E_PASSWORD,
                attributes = mapOf("email" to email, "name" to "Ada Lovelace"),
            ),
        )
        state.state shouldBe AuthState.State.ConfirmingSignUp

        val code = api.cognitoGetLastCode(username).shouldNotBeNull()
        api.cognitoConfirmSignUp(username, code.code).success shouldBe true
        api.cognitoSignIn(username, E2E_PASSWORD)

        val attributes = api.cognitoGetUserAttributes()
        attributes["email"] shouldBe email
        attributes["name"] shouldBe "Ada Lovelace"
        attributes.keys shouldNotContain "attributes"
        api.cognitoSignOut()
    }

    @Test
    fun signUpAttributesRoundTripFlat() {
        val signUp: AuthCognitoApi.SetAuthState.Input = AuthCognitoApi.SetAuthState.Input.SignUp(
            username = "ada",
            password = E2E_PASSWORD,
            attributes = mapOf("email" to "ada@example.com", "custom:team" to "engines"),
        )
        val wire = JsonObject(
            mapOf(
                "action" to JsonPrimitive("signUp"),
                "username" to JsonPrimitive("ada"),
                "password" to JsonPrimitive(E2E_PASSWORD),
                "email" to JsonPrimitive("ada@example.com"),
                "custom:team" to JsonPrimitive("engines"),
            ),
        )

        BlocksJson.encodeToJsonElement(signUp) shouldBe wire
        BlocksJson.decodeFromJsonElement<AuthCognitoApi.SetAuthState.Input>(wire) shouldBe signUp
    }
}
