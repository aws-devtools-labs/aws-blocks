package com.aws.blocks.kotlin.e2e

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.booleans.shouldBeTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.Test

class KvStoreE2ETest {

    private val api = createApi()
    private val prefix = "kv_kotlin_${Clock.System.now().toEpochMilliseconds()}"

    @Test
    fun basicRoundTrip() = runTest {
        val key = "${prefix}_a"
        val r = api.kvPut(key, "hello")
        r.success.shouldBeTrue()
        val v = api.kvGet(key)
        v shouldBe "hello"
    }

    @Test
    fun missingKeyReturnsNull() = runTest {
        val v = api.kvGet("${prefix}_nonexistent")
        v.shouldBeNull()
    }

    @Test
    fun overwrite() = runTest {
        val key = "${prefix}_b"
        api.kvPut(key, "first")
        api.kvPut(key, "second")
        val v = api.kvGet(key)
        v shouldBe "second"
    }

    @Test
    fun emptyStringValue() = runTest {
        val key = "${prefix}_empty"
        api.kvPut(key, "")
        val v = api.kvGet(key)
        v shouldBe ""
    }

    @Test
    fun unicode() = runTest {
        val key = "${prefix}_uni"
        api.kvPut(key, "日本語 🎉 émojis")
        val v = api.kvGet(key)
        v shouldBe "日本語 🎉 émojis"
    }

    @Test
    fun largeValue() = runTest {
        val key = "${prefix}_large"
        val large = "x".repeat(10_000)
        api.kvPut(key, large)
        val v = api.kvGet(key)
        v shouldBe large
    }

    @Test
    fun specialCharactersInKey() = runTest {
        val key = "${prefix}/slashes/and spaces!@#"
        api.kvPut(key, "ok")
        val v = api.kvGet(key)
        v shouldBe "ok"
    }

    @Test
    fun delete() = runTest {
        val key = "${prefix}_del"
        api.kvPut(key, "temp")
        api.kvDelete(key)
        val v = api.kvGet(key)
        v.shouldBeNull()
    }

    @Test
    fun parallelWritesAndReads() = runTest {
        val writes = (0 until 10).map { i ->
            async { api.kvPut("${prefix}_par_$i", "val_$i") }
        }
        writes.awaitAll().forEach { it.success.shouldBeTrue() }

        for (i in 0 until 10) {
            val v = api.kvGet("${prefix}_par_$i")
            v shouldBe "val_$i"
        }
    }
}
