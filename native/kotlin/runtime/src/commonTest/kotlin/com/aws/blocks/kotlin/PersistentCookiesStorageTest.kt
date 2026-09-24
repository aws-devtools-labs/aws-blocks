package com.aws.blocks.kotlin

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.ktor.http.Cookie
import io.ktor.http.Url
import io.ktor.util.date.GMTDate
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

class PersistentCookiesStorageTest {

    private class InMemoryKeyValueStore : KeyValueStore {
        val data = mutableMapOf<String, String>()
        override fun put(key: String, value: String) { data[key] = value }
        override fun get(key: String): String? = data[key]
        override fun remove(key: String) { data.remove(key) }
    }

    private val store = InMemoryKeyValueStore()
    private var now = 1_000_000L
    private val cookiesStorage = PersistentCookiesStorage(store) { now }

    @Test
    fun addAndRetrieveCookie() = runTest {
        val url = Url("https://example.com/path")
        val cookie = Cookie(name = "session", value = "abc123")

        cookiesStorage.addCookie(url, cookie)

        val result = cookiesStorage.get(url)
        result shouldHaveSize 1
        result[0].name shouldBe "session"
        result[0].value shouldBe "abc123"
    }

    @Test
    fun filtersByHost() = runTest {
        val url1 = Url("https://example.com/path")
        val url2 = Url("https://other.com/path")

        cookiesStorage.addCookie(url1, Cookie(name = "a", value = "1"))
        cookiesStorage.addCookie(url2, Cookie(name = "b", value = "2"))

        val result = cookiesStorage.get(url1)
        result shouldHaveSize 1
        result[0].name shouldBe "a"
    }

    @Test
    fun overwritesCookieWithSameName() = runTest {
        val url = Url("https://example.com/path")

        cookiesStorage.addCookie(url, Cookie(name = "session", value = "old"))
        cookiesStorage.addCookie(url, Cookie(name = "session", value = "new"))

        val result = cookiesStorage.get(url)
        result shouldHaveSize 1
        result[0].value shouldBe "new"
    }

    @Test
    fun returnsEmptyForUnknownHost() = runTest {
        val url = Url("https://unknown.com/path")
        cookiesStorage.get(url).shouldBeEmpty()
    }

    @Test
    fun scopesCookieToItsPath() = runTest {
        cookiesStorage.addCookie(
            Url("https://example.com/admin"),
            Cookie(name = "scoped", value = "1", path = "/admin"),
        )

        cookiesStorage.get(Url("https://example.com/admin/users")) shouldHaveSize 1
        cookiesStorage.get(Url("https://example.com/public")).shouldBeEmpty()
    }

    @Test
    fun sendsDomainCookieToSubdomain() = runTest {
        cookiesStorage.addCookie(
            Url("https://example.com/"),
            Cookie(name = "shared", value = "1", domain = "example.com"),
        )

        cookiesStorage.get(Url("https://api.example.com/")) shouldHaveSize 1
        cookiesStorage.get(Url("https://example.com.attacker.test/")).shouldBeEmpty()
    }

    @Test
    fun withholdsSecureCookieFromPlainHttp() = runTest {
        cookiesStorage.addCookie(
            Url("https://example.com/"),
            Cookie(name = "secure", value = "1", secure = true),
        )

        cookiesStorage.get(Url("http://example.com/")).shouldBeEmpty()
        cookiesStorage.get(Url("https://example.com/")) shouldHaveSize 1
    }

    @Test
    fun dropsCookieOnceMaxAgeHasPassed() = runTest {
        val url = Url("https://example.com/")
        cookiesStorage.addCookie(url, Cookie(name = "short", value = "1", maxAge = 60))

        cookiesStorage.get(url) shouldHaveSize 1

        now += 61_000L
        cookiesStorage.get(url).shouldBeEmpty()
    }

    @Test
    fun dropsCookieOnceExpiresHasPassed() = runTest {
        val url = Url("https://example.com/")
        cookiesStorage.addCookie(
            url,
            Cookie(name = "dated", value = "1", expires = GMTDate(now + 60_000L)),
        )

        cookiesStorage.get(url) shouldHaveSize 1

        now += 61_000L
        cookiesStorage.get(url).shouldBeEmpty()
    }

    @Test
    fun removesExpiredCookieFromStorage() = runTest {
        val url = Url("https://example.com/")
        cookiesStorage.addCookie(url, Cookie(name = "short", value = "1", maxAge = 60))

        now += 61_000L
        cookiesStorage.get(url)

        // The jar is rewritten without the expired cookie rather than only filtered on read.
        val reloaded = PersistentCookiesStorage(store) { now }
        reloaded.get(url).shouldBeEmpty()
    }

    @Test
    fun persistsCookiesAcrossInstances() = runTest {
        val url = Url("https://example.com/path")
        cookiesStorage.addCookie(url, Cookie(name = "session", value = "abc123"))

        val reloaded = PersistentCookiesStorage(store) { now }
        val result = reloaded.get(url)

        result shouldHaveSize 1
        result[0].value shouldBe "abc123"
    }

    @Test
    fun persistsRemainingMaxAgeAcrossInstances() = runTest {
        val url = Url("https://example.com/")
        cookiesStorage.addCookie(url, Cookie(name = "short", value = "1", maxAge = 60))

        // maxAge is relative to when the cookie arrived, so a reloaded jar must not restart it.
        now += 61_000L
        PersistentCookiesStorage(store) { now }.get(url).shouldBeEmpty()
    }

    @Test
    fun writesTheWholeJarUnderASingleKey() = runTest {
        cookiesStorage.addCookie(Url("https://example.com/"), Cookie(name = "a", value = "1"))
        cookiesStorage.addCookie(Url("https://other.com/"), Cookie(name = "b", value = "2"))

        store.data.keys shouldHaveSize 1
    }

    @Test
    fun clearRemovesCookiesFromMemoryAndStorage() = runTest {
        val url = Url("https://example.com/path")
        cookiesStorage.addCookie(url, Cookie(name = "session", value = "abc123"))

        cookiesStorage.clear()

        cookiesStorage.get(url).shouldBeEmpty()
        store.data.keys.shouldBeEmpty()
        PersistentCookiesStorage(store) { now }.get(url).shouldBeEmpty()
    }

    @Test
    fun startsEmptyWhenStoredJarCannotBeRead() = runTest {
        val url = Url("https://example.com/path")
        cookiesStorage.addCookie(url, Cookie(name = "session", value = "abc123"))
        val key = store.data.keys.single()
        store.data[key] = "not json"

        val reloaded = PersistentCookiesStorage(store) { now }
        reloaded.get(url).shouldBeEmpty()

        // A jar that could not be read is replaced rather than left in place.
        reloaded.addCookie(url, Cookie(name = "session", value = "fresh"))
        reloaded.get(url).single().value shouldBe "fresh"
    }

    @Test
    fun ignoresCookieWithBlankName() = runTest {
        val url = Url("https://example.com/")
        cookiesStorage.addCookie(url, Cookie(name = "", value = "1"))

        cookiesStorage.get(url).shouldBeEmpty()
        store.data[JAR_KEY_FOR_TEST].shouldBeNull()
    }

    @Test
    fun keepsSessionCookieWithNoExpiry() = runTest {
        val url = Url("https://example.com/")
        cookiesStorage.addCookie(url, Cookie(name = "session", value = "1"))

        now += 365L * 24 * 60 * 60 * 1000
        cookiesStorage.get(url) shouldHaveSize 1
        store.data[JAR_KEY_FOR_TEST].shouldNotBeNull()
    }

    private companion object {
        const val JAR_KEY_FOR_TEST = "jar"
    }
}
