package com.aws.blocks.kotlin.filebucket

import com.aws.blocks.kotlin.defaultHttpClient
import com.aws.blocks.kotlin.exceptions.FileTransferException
import io.kotest.matchers.shouldBe
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.test.runTest
import kotlinx.io.Buffer
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
}
