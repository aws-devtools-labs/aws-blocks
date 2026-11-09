package com.aws.blocks.kotlin

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldMatch
import io.kotest.matchers.string.shouldNotContain
import java.io.File
import kotlin.test.Test

/**
 * The directory an application's stored data lives in is derived from its id, so two applications
 * cannot land on one directory the way every Blocks application sharing `~/.blocks` used to.
 */
class ApplicationStorageDirectoryTest {

    private val root = File("/home/someone")

    @Test
    fun `an id becomes a directory beneath the blocks directory`() {
        applicationStorageDirectory("com.example.myapp", root) shouldBe
            File("/home/someone/.blocks/com.example.myapp")
    }

    @Test
    fun `two ids do not share a directory`() {
        applicationStorageDirectory("com.example.one", root) shouldNotBe
            applicationStorageDirectory("com.example.two", root)
    }

    @Test
    fun `an id is reduced to characters a directory name can hold`() {
        val directory = applicationStorageDirectory("My App!/v2", root)

        directory.name shouldMatch Regex("[A-Za-z0-9._-]+")
        directory.parentFile shouldBe File("/home/someone/.blocks")
    }

    @Test
    fun `two ids that reduce to the same characters still get their own directory`() {
        // Without this, `My/App` and `My App` would both reduce to `My_App` and silently share a
        // session — the collision this whole mechanism exists to prevent, reintroduced by the
        // sanitising step itself.
        applicationStorageDirectory("My/App", root) shouldNotBe
            applicationStorageDirectory("My App", root)
    }

    @Test
    fun `an id that needs no reduction is used as written`() {
        // A reverse-DNS id is already safe, so it should read as itself on disk rather than
        // carrying a digest nobody can match back to the configured value.
        applicationStorageDirectory("com.example.myapp", root).name shouldBe "com.example.myapp"
    }

    @Test
    fun `a long id is capped`() {
        val directory = applicationStorageDirectory("com.example." + "x".repeat(400), root)

        (directory.name.length <= 160) shouldBe true
    }

    @Test
    fun `a leading dot does not hide the directory or escape the parent`() {
        val directory = applicationStorageDirectory("...", root)

        directory.name shouldNotContain "/"
        directory.canonicalPath.startsWith(File(root, ".blocks").canonicalPath) shouldBe true
    }
}
