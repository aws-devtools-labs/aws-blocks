package com.aws.blocks.kotlin.filebucket

import io.kotest.matchers.shouldBe
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.io.Buffer
import kotlin.test.Test

/**
 * The server signs a presigned upload's `Content-Type` in canonical form
 * (`type/subtype; name=value`). These tests pin that both upload paths send a
 * canonical descriptor value byte-for-byte, so the header matches the signature.
 */
class FileUploadHandleTest {

    private val canonicalTypes = listOf(
        "application/octet-stream",
        "text/plain; charset=utf-8",
        "text/plain; charset=UTF-8",
        "text/csv; charset=utf-8; header=present",
    )

    /** A handle whose requests are answered 200 and whose sent Content-Type is recorded. */
    private fun recordingHandle(contentType: String, sent: MutableList<String?>): FileUploadHandle {
        val engine = MockEngine { request ->
            sent += request.body.contentType?.toString() ?: request.headers[HttpHeaders.ContentType]
            respond("", HttpStatusCode.OK)
        }
        return FileUploadHandle("https://bucket.example.com/key?sig=1", contentType, HttpClient(engine))
    }

    @Test
    fun `upload sends a canonical Content-Type unchanged`() = runTest {
        for (contentType in canonicalTypes) {
            val sent = mutableListOf<String?>()
            recordingHandle(contentType, sent).upload(byteArrayOf(1, 2, 3))
            sent shouldBe listOf(contentType)
        }
    }

    @Test
    fun `uploadFrom sends a canonical Content-Type unchanged`() = runTest {
        for (contentType in canonicalTypes) {
            val sent = mutableListOf<String?>()
            val source = Buffer().apply { write(byteArrayOf(1, 2, 3)) }
            recordingHandle(contentType, sent).uploadFrom(source, contentLength = 3)
            sent shouldBe listOf(contentType)
        }
    }

    @Test
    fun `a non-canonical Content-Type is re-rendered in the canonical form the server signs`() = runTest {
        val rerendered = mapOf(
            "text/plain;charset=utf-8" to "text/plain; charset=utf-8",
            "text/plain;  charset=UTF-8" to "text/plain; charset=UTF-8",
        )
        for ((input, canonical) in rerendered) {
            val sent = mutableListOf<String?>()
            recordingHandle(input, sent).upload(byteArrayOf(1))
            sent shouldBe listOf(canonical)
        }
    }
}
