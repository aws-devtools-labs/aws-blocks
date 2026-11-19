// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.filebucket

import com.aws.blocks.kotlin.defaultHttpClient
import com.aws.blocks.kotlin.exceptions.FileTransferException
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.io.Buffer
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.Test
import kotlin.test.assertFailsWith

class FileTransferErrorTest {

    private fun clientAnswering(status: HttpStatusCode) = defaultHttpClient(
        MockEngine { respond(content = "", status = status) },
        cookiesStorage = AcceptAllCookiesStorage(),
    )

    private val url = "https://s3.example/presigned"

    @Test
    fun `a failed upload carries the HTTP status as a field`() = runTest {
        val handle = FileUploadHandle(url = url, httpClient = clientAnswering(HttpStatusCode.Forbidden))
        val e = assertFailsWith<FileTransferException> { handle.upload(ByteArray(3)) }
        e.statusCode shouldBe 403
        e.message shouldBe "Upload failed: HTTP 403"
    }

    @Test
    fun `a failed streaming upload carries the HTTP status as a field`() = runTest {
        val handle = FileUploadHandle(url = url, httpClient = clientAnswering(HttpStatusCode.Forbidden))
        val e = assertFailsWith<FileTransferException> { handle.uploadFrom(Buffer()) }
        e.statusCode shouldBe 403
        e.message shouldBe "Upload failed: HTTP 403"
    }

    @Test
    fun `a failed download carries the HTTP status as a field`() = runTest {
        val handle = FileDownloadHandle(url = url, httpClient = clientAnswering(HttpStatusCode.NotFound))
        val e = assertFailsWith<FileTransferException> { handle.download() }
        e.statusCode shouldBe 404
        e.message shouldBe "Download failed: HTTP 404"
    }

    @Test
    fun `a failed streaming download carries the HTTP status as a field`() = runTest {
        val handle = FileDownloadHandle(url = url, httpClient = clientAnswering(HttpStatusCode.NotFound))
        val e = assertFailsWith<FileTransferException> { handle.downloadTo(Buffer()) }
        e.statusCode shouldBe 404
        e.message shouldBe "Download failed: HTTP 404"
    }

    private fun clientFailing(failure: () -> Nothing) = defaultHttpClient(
        MockEngine { failure() },
        cookiesStorage = AcceptAllCookiesStorage(),
    )

    @Test
    fun `a file handle connection failure has no status and keeps its cause`() = runTest {
        val client = clientFailing { throw RuntimeException("Connection refused") }
        val upload = FileUploadHandle(url = url, httpClient = client)
        val download = FileDownloadHandle(url = url, httpClient = client)
        val failures = listOf(
            assertFailsWith<FileTransferException> { upload.upload(ByteArray(3)) },
            assertFailsWith<FileTransferException> { upload.uploadFrom(Buffer()) },
            assertFailsWith<FileTransferException> { download.download() },
            assertFailsWith<FileTransferException> { download.downloadTo(Buffer()) },
        )
        for (e in failures) {
            e.statusCode shouldBe null
            e.cause.shouldNotBeNull().message shouldBe "Connection refused"
        }
    }

    @Test
    fun `a cancellation passes through every file handle method`() = runTest {
        val client = clientFailing { throw CancellationException("cancelled") }
        val upload = FileUploadHandle(url = url, httpClient = client)
        val download = FileDownloadHandle(url = url, httpClient = client)
        assertFailsWith<CancellationException> { upload.upload(ByteArray(3)) }
        assertFailsWith<CancellationException> { upload.uploadFrom(Buffer()) }
        assertFailsWith<CancellationException> { download.download() }
        assertFailsWith<CancellationException> { download.downloadTo(Buffer()) }
    }
}
