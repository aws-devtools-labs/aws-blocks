package com.aws.blocks.kotlin.e2e

import blocks.e2e.DeliveredCode
import blocks.e2e.NativeSignInResult
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.exceptions.ApiException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotBeBlank
import kotlin.test.Test
import kotlinx.coroutines.test.runTest

/**
 * The email + password `Auth` block (`auth-basic`): sign-up confirms the email address with a
 * code, then auto sign-in signs the user in. Errors are asserted by their canonical `name`.
 */
class AuthBasicE2ETest {

    private val api = createApi()

    @Test
    fun signUpSendsCodeAndConfirmSignsIn() = runTest {
        if (!isLocalEndpoint()) {
            markSkipped(NEEDS_LOCAL_CODE)
            return@runTest
        }
        val username = uniqueUsername("basic")

        val signUp = api.basicSignUp(username, E2E_PASSWORD, "$username@example.com")
        signUp.isSignUpComplete.shouldBeFalse()

        val code = api.basicGetLastCode(username)
        code.shouldNotBeNull()
        code.purpose shouldBe DeliveredCode.Purpose.SignUp

        val confirmed = api.basicConfirmSignUp(username, code.code)
        confirmed.status shouldBe NativeSignInResult.Status.SignedIn
        confirmed.user?.username shouldBe username
        api.basicCheckAuth().shouldBeTrue()
    }

    @Test
    fun signIn() = runTest {
        val (username, password) = api.signInTestUser("basic")
        api.basicSignOut()

        val result = api.basicSignIn(username, password)
        result.status shouldBe NativeSignInResult.Status.SignedIn
        val user = result.user.shouldNotBeNull()
        user.username shouldBe username
        user.userId.shouldNotBeBlank()
        user.userSub.shouldNotBeBlank()
    }

    @Test
    fun checkAuthWhenSignedIn() = runTest {
        api.signInTestUser("basic")

        api.basicCheckAuth().shouldBeTrue()
    }

    @Test
    fun requireAuthWhenSignedIn() = runTest {
        val (username, _) = api.signInTestUser("basic")

        api.basicRequireAuth().username shouldBe username
    }

    @Test
    fun getCurrentUserWhenSignedIn() = runTest {
        val (username, _) = api.signInTestUser("basic")

        val current = api.basicGetCurrentUser()
        current.shouldNotBeNull()
        current.username shouldBe username
    }

    @Test
    fun signOut() = runTest {
        api.signInTestUser("basic")

        api.basicSignOut().success.shouldBeTrue()

        api.basicGetCurrentUser().shouldBeNull()
    }

    @Test
    fun checkAuthAfterSignOut() = runTest {
        api.signInTestUser("basic")
        api.basicSignOut()

        api.basicCheckAuth().shouldBeFalse()
    }

    @Test
    fun requireAuthWhenNotAuthenticatedThrowsNotAuthenticated() = runTest {
        api.signInTestUser("basic")
        api.basicSignOut()

        val e = shouldThrow<ApiException> { api.basicRequireAuth() }
        e.name shouldBe AuthErrorNames.NotAuthenticated
    }

    @Test
    fun requireAuthWithNoSessionThrowsNotAuthenticated() = runTest {
        BlocksClient.clearCookies()

        val e = shouldThrow<ApiException> { api.basicRequireAuth() }
        e.name shouldBe AuthErrorNames.NotAuthenticated
    }

    @Test
    fun wrongPasswordThrowsNotAuthorized() = runTest {
        val (username, _) = api.signInTestUser("basic")

        val e = shouldThrow<ApiException> { api.basicSignIn(username, "Wrong5678!") }
        e.name shouldBe AuthErrorNames.NotAuthorized
    }

    @Test
    fun weakPasswordThrowsInvalidPassword() = runTest {
        val username = uniqueUsername("weak")

        val e = shouldThrow<ApiException> { api.basicSignUp(username, "pass1234", "$username@example.com") }
        e.name shouldBe AuthErrorNames.InvalidPassword
    }

    @Test
    fun signInBeforeConfirmingThrowsUserNotConfirmed() = runTest {
        if (!isLocalEndpoint()) {
            markSkipped("leaves an unconfirmed user in the deployed pool, which Cognito emails a code for")
            return@runTest
        }
        val username = uniqueUsername("unconfirmed")
        api.basicSignUp(username, E2E_PASSWORD, "$username@example.com")

        val e = shouldThrow<ApiException> { api.basicSignIn(username, E2E_PASSWORD) }
        e.name shouldBe AuthErrorNames.UserNotConfirmed
    }

    @Test
    fun wrongCodeThrowsCodeMismatch() = runTest {
        if (!isLocalEndpoint()) {
            markSkipped(NEEDS_LOCAL_CODE)
            return@runTest
        }
        val username = uniqueUsername("badcode")
        api.basicSignUp(username, E2E_PASSWORD, "$username@example.com")
        val code = api.basicGetLastCode(username).shouldNotBeNull().code
        val wrong = if (code == "000000") "111111" else "000000"

        val e = shouldThrow<ApiException> { api.basicConfirmSignUp(username, wrong) }
        e.name shouldBe AuthErrorNames.CodeMismatch
    }

    @Test
    fun duplicateSignUpThrowsUsernameExists() = runTest {
        val (username, _) = api.signInTestUser("dup")

        val e = shouldThrow<ApiException> { api.basicSignUp(username, E2E_PASSWORD, "$username@example.com") }
        e.name shouldBe AuthErrorNames.UserAlreadyExists
    }
}
