package com.aws.blocks.kotlin

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import io.ktor.http.Cookie
import io.ktor.http.Url
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * The JVM has no sandbox and no per-application namespace, so the application supplies the
 * directory its storage lives in. Two applications that supply different directories must not
 * reach each other's sessions, which is what sharing one directory under `$HOME` used to do.
 */
class JvmStorageLocationTest {

    private val appA: File = Files.createTempDirectory("blocks-app-a").toFile()
    private val appB: File = Files.createTempDirectory("blocks-app-b").toFile()
    private val url = Url("https://example.com/")

    @AfterTest
    fun cleanUp() {
        appA.deleteRecursively()
        appB.deleteRecursively()
    }

    /** A jar as a freshly launched application would build one, so each call stands in for a launch. */
    private fun jarIn(location: File) = PersistentCookiesStorage(
        platformKeyValueStore("cookies", BlocksPlatformConfig(storageLocation = location)),
    )

    @Test
    fun `an application reads back the session it stored`() = runTest {
        jarIn(appA).addCookie(url, Cookie(name = "session", value = "a-session"))

        jarIn(appA).get(url).single().value shouldBe "a-session"
    }

    @Test
    fun `two applications with different locations do not share a session`() = runTest {
        jarIn(appA).addCookie(url, Cookie(name = "session", value = "a-session"))

        jarIn(appB).get(url).shouldBeEmpty()
    }

    @Test
    fun `a configured location holds the whole store, with no directory of our own inside it`() = runTest {
        jarIn(appA).addCookie(url, Cookie(name = "session", value = "a-session"))

        // The location the application supplies is already private to it, so the store names its
        // entries directly within it rather than carving out a namespace of our own.
        File(appA, "cookies").isDirectory shouldBe true
        File(appA, ".blocks").exists() shouldBe false
    }

    @Test
    fun `no configured location keeps the session in memory rather than guessing a directory`() = runTest {
        val jar = PersistentCookiesStorage(platformKeyValueStore("cookies", BlocksPlatformConfig()))
        jar.addCookie(url, Cookie(name = "session", value = "a-session"))

        // It works for as long as the process lives.
        jar.get(url).single().value shouldBe "a-session"

        // A second jar stands in for the next launch. Nothing was persisted, here or anywhere
        // else the library might have picked on the application's behalf.
        PersistentCookiesStorage(platformKeyValueStore("cookies", BlocksPlatformConfig()))
            .get(url)
            .shouldBeEmpty()
    }
}
