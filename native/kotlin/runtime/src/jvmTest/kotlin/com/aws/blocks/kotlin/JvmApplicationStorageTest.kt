package com.aws.blocks.kotlin

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.ktor.http.Cookie
import io.ktor.http.Url
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * The JVM has no sandbox and no per-application namespace, so an application identifies itself and
 * the runtime derives a directory from it. Two applications with different ids must not reach each
 * other's sessions, which is what sharing one directory under `$HOME` used to do.
 */
class JvmApplicationStorageTest {

    private val root: File = Files.createTempDirectory("blocks-home").toFile()
    private val url = Url("https://example.com/")

    @AfterTest
    fun cleanUp() {
        root.deleteRecursively()
    }

    /**
     * A jar as a freshly launched application would build one, so each call stands in for a launch.
     *
     * Pinned to a key beside the entries. What this test is about is which directory an id resolves
     * to, and left on the default it would reach the machine's real secret store on every run.
     */
    private fun jarFor(applicationId: String) =
        cookieJarIn(applicationStorageDirectory(applicationId, root)) { FileKeyCustody(it) }

    @Test
    fun `an application reads back the session it stored`() = runTest {
        jarFor("com.example.one").addCookie(url, Cookie(name = "session", value = "a-session"))

        jarFor("com.example.one").get(url).single().value shouldBe "a-session"
    }

    @Test
    fun `two applications with different ids do not share a session`() = runTest {
        jarFor("com.example.one").addCookie(url, Cookie(name = "session", value = "a-session"))

        jarFor("com.example.two").get(url).shouldBeEmpty()
    }

    @Test
    fun `an id names a directory of its own beneath the blocks directory`() = runTest {
        jarFor("com.example.one").addCookie(url, Cookie(name = "session", value = "a-session"))

        File(root, ".blocks/com.example.one/cookies").isDirectory shouldBe true
        // Releases before this one wrote the store straight into `.blocks`, which every Blocks
        // application on the machine therefore shared.
        File(root, ".blocks/cookies").exists() shouldBe false
    }

    @Test
    fun `a blank id counts as no id rather than naming a directory of its own`() = runTest {
        // An empty identifier identifies nothing -- an unset build property reaching us as "" should
        // not quietly create a directory nobody can trace back to an application.
        applicationStorageDirectoryOrNull("   ").shouldBeNull()

        // So the store it resolves to is the in-memory one, which forgets on the next launch.
        val jar = PersistentCookiesStorage(platformKeyValueStore("cookies", "   "))
        jar.addCookie(url, Cookie(name = "session", value = "a-session"))
        PersistentCookiesStorage(platformKeyValueStore("cookies", "   ")).get(url).shouldBeEmpty()
    }

    @Test
    fun `two id spellings that share a directory share a key`() = runTest {
        // `app`, ` app` and `.app` all reduce to the same directory, so one is standing in for a
        // relaunched process that supplied a slightly-differently-whitespaced id. The alias must
        // come from the already-normalized directory name, not the raw id: with the raw id, each
        // spelling would mint its own key under any OS secret store, and only one could read what
        // the directory holds. Pinned here against an alias-keyed custody that stands in for a
        // real OS store.
        val keyedByAlias = mutableMapOf<String, ByteArray>()
        val custodyFor: (Path) -> KeyCustody = { AliasedCustody(keyedByAlias) }

        forgetCookieJars()
        cookieJarIn(applicationStorageDirectory("app", root), custodyFor)
            .addCookie(url, Cookie(name = "session", value = "a-session"))

        forgetCookieJars()
        cookieJarIn(applicationStorageDirectory(" app", root), custodyFor)
            .get(url).single().value shouldBe "a-session"

        // Only one key minted — both spellings resolved to the same alias.
        keyedByAlias.size shouldBe 1
    }

    /** Stands in for a real OS secret store: keys indexed by alias, state shared across instances. */
    private class AliasedCustody(private val held: MutableMap<String, ByteArray>) : KeyCustody {
        override val tier = KeyTier.OS
        override fun load(alias: String): ByteArray? = held[alias]
        override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray =
            held.getOrPut(alias) { key }
        override fun delete(alias: String) { held.remove(alias) }
    }

    @Test
    fun `no id keeps the session in memory rather than guessing a directory`() = runTest {
        val jar = PersistentCookiesStorage(platformKeyValueStore("cookies", applicationId = null))
        jar.addCookie(url, Cookie(name = "session", value = "a-session"))

        // It works for as long as the process lives.
        jar.get(url).single().value shouldBe "a-session"

        // A second jar stands in for the next launch. Nothing was persisted, here or anywhere
        // else the library might have picked on the application's behalf.
        PersistentCookiesStorage(platformKeyValueStore("cookies", applicationId = null))
            .get(url)
            .shouldBeEmpty()
    }
}
