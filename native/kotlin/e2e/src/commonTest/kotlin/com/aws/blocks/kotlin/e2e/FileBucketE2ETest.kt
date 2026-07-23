package com.aws.blocks.kotlin.e2e

import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldHaveAtLeastSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotBeBlank
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.Test

class FileBucketE2ETest {

    private val api = createApi()
    private val prefix = "test_kotlin_${Clock.System.now().toEpochMilliseconds()}"

    @Test
    fun uploadAndDownloadViaHandles() = runTest {
        val handle = api.fileCreateUploadHandle("$prefix/hello.txt")
        handle.url.shouldNotBeBlank()
        handle.upload("hello from kotlin".encodeToByteArray())

        val download = api.fileGetHandle("$prefix/hello.txt")
        val bytes = download.download()
        bytes.decodeToString() shouldBe "hello from kotlin"
    }

    @Test
    fun binaryDataRoundTrip() = runTest {
        val data = ByteArray(256) { it.toByte() }
        val handle = api.fileCreateUploadHandle("$prefix/binary.bin")
        handle.upload(data)

        val download = api.fileGetHandle("$prefix/binary.bin")
        val bytes = download.download()
        bytes.size shouldBe 256
        bytes shouldBe data
    }

    @Test
    fun serverSidePutAndGet() = runTest {
        api.filePut("$prefix/server.txt", "server-side")
        val file = api.fileGet("$prefix/server.txt")
        file.shouldNotBeNull()
        file.body shouldBe "server-side"
    }

    @Test
    fun deleteFile() = runTest {
        api.filePut("$prefix/del.txt", "temp")
        api.fileDelete("$prefix/del.txt")
        val deleted = api.fileGet("$prefix/del.txt")
        deleted.shouldBeNull()
    }

    @Test
    fun scanWithPrefix() = runTest {
        api.filePut("$prefix/scan/a.txt", "a")
        api.filePut("$prefix/scan/b.txt", "b")
        val scanned = api.fileScan("$prefix/scan/")
        scanned.shouldHaveAtLeastSize(2)
    }

    @Test
    fun largeFile() = runTest {
        val data = ByteArray(100_000) { (it % 256).toByte() }
        val handle = api.fileCreateUploadHandle("$prefix/large.bin")
        handle.upload(data)

        val download = api.fileGetHandle("$prefix/large.bin")
        val bytes = download.download()
        bytes.size shouldBe 100_000
    }
}
