package com.aws.blocks.kotlin.e2e

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
import kotlinx.datetime.Clock

class AuthBasicE2ETest {

    private val api = createApi()
    private val suffix = Clock.System.now().toEpochMilliseconds().toString()
    private val username = "basicuser_$suffix"
    private val password = "pass1234"

    @Test
    fun signUpAndSignIn() = runTest {
        val r = api.basicSignUp(username, password)
        r.success.shouldBeTrue()

        val user = api.basicSignIn(username, password)
        user.username shouldBe username
        user.userId.shouldNotBeBlank()
    }

    @Test
    fun checkAuthWhenSignedIn() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)

        val authed = api.basicCheckAuth()
        authed.shouldBeTrue()
    }

    @Test
    fun requireAuthWhenSignedIn() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)

        val user = api.basicRequireAuth()
        user.username shouldBe username
    }

    @Test
    fun getCurrentUserWhenSignedIn() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)

        val current = api.basicGetCurrentUser()
        current.shouldNotBeNull()
        current.username shouldBe username
    }

    @Test
    fun signOut() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)
        val r = api.basicSignOut()
        r.success.shouldBeTrue()

        val afterSignOut = api.basicGetCurrentUser()
        afterSignOut.shouldBeNull()
    }

    @Test
    fun checkAuthAfterSignOut() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)
        api.basicSignOut()

        val authed = api.basicCheckAuth()
        authed.shouldBeFalse()
    }

    @Test
    fun requireAuthWhenNotAuthenticatedThrows() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)
        api.basicSignOut()

        shouldThrow<ApiException> { api.basicRequireAuth() }
    }

    @Test
    fun wrongPasswordThrows() = runTest {
        api.basicSignUp(username, password)

        shouldThrow<ApiException> { api.basicSignIn(username, "wrong5678") }
    }
}
