package com.aws.blocks.kotlin.e2e

import blocks.e2e.Api
import blocks.e2e.NativeSignInResult
import com.aws.blocks.kotlin.BlocksServer
import io.ktor.http.Url
import kotlin.random.Random
import kotlinx.datetime.Clock

private val blocksUrl: String =
    getEnv("BLOCKS_URL")?.takeIf { it.isNotBlank() }
        ?: "http://localhost:3001/aws-blocks/api"

private val server = BlocksServer(name = "e2e", url = blocksUrl)

fun createApi(): Api = Api(server = server)

fun e2eServer(): BlocksServer = server

/**
 * True when the suite targets the local native-bindings dev server rather than a deployed
 * backend. Locally, `Auth` hands every verification code to the backend (`basicGetLastCode`);
 * deployed, Cognito emails it, so flows that need the code run only locally.
 */
fun isLocalEndpoint(): Boolean =
    Url(blocksUrl).host in setOf("localhost", "127.0.0.1", "0.0.0.0", "::1")

/**
 * Canonical `Auth` error names (the `name` the server puts on a JSON-RPC error), from the
 * mapping table in `packages/auth-common/src/errors.ts` (`AuthErrors`).
 */
object AuthErrorNames {
    const val NotAuthenticated = "NotAuthenticatedException"
    const val NotAuthorized = "NotAuthorizedException"
    const val UserAlreadyExists = "UsernameExistsException"
    const val UserNotConfirmed = "UserNotConfirmedException"
    const val InvalidPassword = "InvalidPasswordException"
    const val CodeMismatch = "CodeMismatchException"
}

/** A password that satisfies `Auth`'s default policy (≥ 8, upper, lower, digit, symbol). */
const val E2E_PASSWORD = "Passw0rd!"

/**
 * The pre-provisioned, confirmed user a deployed backend signs in instead of signing up
 * (seeded by `test-apps/native-bindings/aws-blocks/scripts/seed-cognito-user.ts`).
 * Defaults match that script; override with `COGNITO_TEST_USERNAME` / `COGNITO_TEST_PASSWORD`.
 */
fun returningUser(): Pair<String, String> =
    (getEnv("COGNITO_TEST_USERNAME")?.takeIf { it.isNotBlank() } ?: "e2e-returning-user") to
        (getEnv("COGNITO_TEST_PASSWORD")?.takeIf { it.isNotBlank() } ?: "Returning1Pass!")

/** A username no other test (or earlier run) has used. */
fun uniqueUsername(label: String): String =
    "${label}_kotlin_${Clock.System.now().toEpochMilliseconds()}_${Random.nextInt(1_000, 9_999)}"

/**
 * Sign up [username] on the email + password block, read the emailed code back from the local
 * dev server, and confirm it. Auto sign-in leaves the user signed in. Local dev server only.
 */
suspend fun Api.signUpAndConfirm(username: String, password: String = E2E_PASSWORD): NativeSignInResult {
    basicSignUp(username, password, "$username@example.com")
    val code = basicGetLastCode(username)
        ?: error("No verification code was delivered to $username — is BLOCKS_URL the local dev server?")
    return basicConfirmSignUp(username, code.code)
}

/**
 * Leave a user signed in on the email + password block and return their username and
 * password: a fresh, confirmed user on the local dev server, the pre-provisioned
 * [returningUser] on a deployed backend.
 */
suspend fun Api.signInTestUser(label: String): Pair<String, String> {
    if (isLocalEndpoint()) {
        val username = uniqueUsername(label)
        val result = signUpAndConfirm(username)
        check(result.status == NativeSignInResult.Status.SignedIn) { "Auto sign-in did not complete: $result" }
        return username to E2E_PASSWORD
    }
    val (username, password) = returningUser()
    val result = basicSignIn(username, password)
    check(result.status == NativeSignInResult.Status.SignedIn) { "Sign-in did not complete: $result" }
    return username to password
}

/** Why a test that needs an emailed verification code does not run against a deployed backend. */
const val NEEDS_LOCAL_CODE =
    "needs the emailed verification code, which only the local dev server hands back (Cognito emails it)"
