package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.json.BlocksJson
import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.client.plugins.cookies.fillDefaults
import io.ktor.client.plugins.cookies.matches
import io.ktor.http.Cookie
import io.ktor.http.Url
import io.ktor.http.parseServerSetCookieHeader
import io.ktor.http.renderSetCookieHeader
import io.ktor.util.date.getTimeMillis
import kotlinx.atomicfu.locks.SynchronizedObject
import kotlinx.atomicfu.locks.synchronized
import kotlinx.serialization.Serializable

/**
 * The cookie jar shared by every client in the process. Two clients built for the same backend
 * hold the same session, and a single instance means one lock and one on-disk copy of the jar.
 */
internal val sharedCookiesStorage: PersistentCookiesStorage by lazy { PersistentCookiesStorage() }

/**
 * A [CookiesStorage] that keeps cookies in memory and mirrors the whole jar to [store] under a
 * single key, so every persisted state is written in one operation.
 *
 * Matching and expiry follow the cookie rules Ktor already implements: [matches] decides whether
 * a stored cookie belongs on a request (domain, path and `Secure`), and [fillDefaults] resolves
 * `domain`/`path` from the request URL before a cookie is stored.
 *
 * `maxAge` is relative to the moment a cookie was received, which a rendered `Set-Cookie` header
 * does not carry, so the arrival time is persisted alongside each cookie.
 */
internal class PersistentCookiesStorage(
    private val store: KeyValueStore = encryptedKeyValueStore(STORE_NAME),
    private val clock: () -> Long = { getTimeMillis() },
) : CookiesStorage, SynchronizedObject() {

    private companion object {
        const val STORE_NAME = "cookies"

        /** The single key under which the whole jar is stored. */
        const val JAR_KEY = "jar"
    }

    @Serializable
    private data class Entry(val setCookie: String, val createdAt: Long)

    private class Stored(val cookie: Cookie, val createdAt: Long)

    private val cookies = mutableListOf<Stored>()
    private var loaded = false

    override suspend fun get(requestUrl: Url): List<Cookie> = synchronized(this) {
        load()
        if (removeExpired()) persist()
        cookies.filter { it.cookie.matches(requestUrl) }.map { it.cookie }
    }

    override suspend fun addCookie(requestUrl: Url, cookie: Cookie) {
        if (cookie.name.isBlank()) return
        synchronized(this) {
            load()
            val stored = cookie.fillDefaults(requestUrl)
            cookies.removeAll { it.cookie.name == stored.name && it.cookie.matches(requestUrl) }
            cookies += Stored(stored, clock())
            removeExpired()
            persist()
        }
    }

    /** Drops every cookie, in memory and on disk. */
    fun clear() = synchronized(this) {
        cookies.clear()
        loaded = true
        store.remove(JAR_KEY)
    }

    override fun close() {}

    /** Reads the persisted jar on first use. */
    private fun load() {
        if (loaded) return
        loaded = true
        val serialized = store.get(JAR_KEY) ?: return
        val entries = try {
            BlocksJson.decodeFromString<List<Entry>>(serialized)
        } catch (_: Exception) {
            // A jar that cannot be read leaves the caller unauthenticated, which is recoverable
            // by signing in again; failing here would instead break every request.
            return
        }
        entries.forEach { entry ->
            cookies += Stored(parseServerSetCookieHeader(entry.setCookie), entry.createdAt)
        }
        removeExpired()
    }

    private fun persist() {
        val entries = cookies.map { Entry(renderSetCookieHeader(it.cookie), it.createdAt) }
        store.put(JAR_KEY, BlocksJson.encodeToString(entries))
    }

    /** Removes expired cookies, reporting whether anything was dropped. */
    private fun removeExpired(): Boolean {
        val now = clock()
        return cookies.removeAll { stored ->
            val expiresAt = stored.expiresAt() ?: return@removeAll false
            expiresAt < now
        }
    }

    /**
     * A cookie with neither `Max-Age` nor `Expires` is a session cookie and has no expiry. It is
     * still persisted, so a restarted app resumes the session it had.
     */
    private fun Stored.expiresAt(): Long? =
        cookie.maxAge?.let { createdAt + it * 1000L } ?: cookie.expires?.timestamp
}
