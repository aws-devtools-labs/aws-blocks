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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
 * `domain`/`path` from the request URL before a cookie is stored. Two rules Ktor leaves out are
 * added here: a cookie that arrived without a `Domain` is host-only and is not sent to
 * subdomains, and one that arrived without a `Path` applies to the directory of the request path
 * rather than to that path alone.
 *
 * `maxAge` is relative to the moment a cookie was received, which a rendered `Set-Cookie` header
 * does not carry, so the arrival time is persisted alongside each cookie.
 */
internal class PersistentCookiesStorage(
    private val store: KeyValueStore = encryptedKeyValueStore(STORE_NAME),
    private val clock: () -> Long = { getTimeMillis() },
) : CookiesStorage {

    private companion object {
        const val STORE_NAME = "cookies"

        /** The single key under which the whole jar is stored. */
        const val JAR_KEY = "jar"
    }

    /**
     * `hostOnly` defaults to true so a jar written before the flag existed is narrowed rather
     * than widened: the worst case is a cookie that stops being sent and a caller that signs in
     * again, where the opposite would keep sending it to subdomains.
     */
    @Serializable
    private data class Entry(val setCookie: String, val createdAt: Long, val hostOnly: Boolean = true)

    private class Stored(val cookie: Cookie, val createdAt: Long, val hostOnly: Boolean) {
        /**
         * Whether this cookie belongs on a request. Domain, path and `Secure` are Ktor's
         * [matches]; on top of that a cookie that arrived without a `Domain` attribute is
         * host-only and goes to that exact host, never to a subdomain of it.
         */
        fun matches(requestUrl: Url): Boolean {
            if (!cookie.matches(requestUrl)) return false
            return !hostOnly || requestUrl.host.equals(cookie.domain, ignoreCase = true)
        }
    }

    private val mutex = Mutex()
    private val cookies = mutableListOf<Stored>()
    private var loaded = false

    override suspend fun get(requestUrl: Url): List<Cookie> = mutex.withLock {
        load()
        if (removeExpired()) persist()
        cookies.filter { it.matches(requestUrl) }.map { it.cookie }
    }

    override suspend fun addCookie(requestUrl: Url, cookie: Cookie) {
        if (cookie.name.isBlank()) return
        mutex.withLock {
            load()
            // A cookie is host-only exactly when the server sent no `Domain`, which has to be
            // read before `fillDefaults` substitutes the request host for it.
            val hostOnly = cookie.domain.isNullOrBlank()
            val stored = cookie.withDefaultPath(requestUrl).fillDefaults(requestUrl)
            cookies.removeAll { it.cookie.name == stored.name && it.matches(requestUrl) }
            cookies += Stored(stored, clock(), hostOnly)
            removeExpired()
            persist()
        }
    }

    /**
     * Drops every cookie, in memory and in storage. The whole store is cleared rather than the
     * jar key alone, so cookies written by an earlier version of the library go too.
     */
    suspend fun clear() = mutex.withLock {
        cookies.clear()
        loaded = true
        store.clear()
    }

    override fun close() {}

    /** Reads the persisted jar on first use. */
    private suspend fun load() {
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
            cookies += Stored(parseServerSetCookieHeader(entry.setCookie), entry.createdAt, entry.hostOnly)
        }
        // Rewrite here rather than leaving the drop to the caller: the caller's own check finds
        // nothing left to remove, so expired entries would stay in storage until an unrelated write.
        if (removeExpired()) persist()
    }

    private suspend fun persist() {
        val entries = cookies.map { Entry(renderSetCookieHeader(it.cookie), it.createdAt, it.hostOnly) }
        store.put(JAR_KEY, BlocksJson.encodeToString(entries))
    }

    /**
     * Removes expired cookies, reporting whether anything was dropped. An expiry that has exactly
     * arrived counts as passed, so the `Max-Age=0` cookie a sign-out sends does not linger for the
     * millisecond it was received in.
     */
    private fun removeExpired(): Boolean {
        val now = clock()
        return cookies.removeAll { stored ->
            val expiresAt = stored.expiresAt() ?: return@removeAll false
            expiresAt <= now
        }
    }

    /**
     * Applies the path a cookie gets when it carries no usable `Path`: the directory of the
     * request path. [fillDefaults] would use the whole request path, which scopes the cookie to
     * the single endpoint that set it instead of the rest of the site.
     */
    private fun Cookie.withDefaultPath(requestUrl: Url): Cookie {
        if (path?.startsWith("/") == true) return this
        val requestPath = requestUrl.encodedPath
        val lastSlash = requestPath.lastIndexOf('/')
        return copy(path = if (lastSlash <= 0) "/" else requestPath.substring(0, lastSlash))
    }

    /**
     * A cookie with neither `Max-Age` nor `Expires` is a session cookie and has no expiry. It is
     * still persisted, so a restarted app resumes the session it had.
     */
    private fun Stored.expiresAt(): Long? =
        cookie.maxAge?.let { createdAt + it * 1000L } ?: cookie.expires?.timestamp
}
