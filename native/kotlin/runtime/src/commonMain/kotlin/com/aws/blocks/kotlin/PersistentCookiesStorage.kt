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

    /** What makes two cookies the same cookie rather than two of them. */
    private data class Identity(val name: String, val domain: String?, val path: String?)

    private class Stored(val cookie: Cookie, val createdAt: Long, val hostOnly: Boolean) {
        val identity get() = Identity(cookie.name, cookie.domain, cookie.path)

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

    /**
     * Cookies set or deleted while the jar could not be read. Each is newer than whatever storage
     * holds for it, so the stored copy is discarded when the jar is finally read.
     */
    private val changedWhileUnloaded = mutableSetOf<Identity>()

    /** Set when a write failed, so a later call retries it rather than dropping the jar. */
    private var writePending = false

    override suspend fun get(requestUrl: Url): List<Cookie> = mutex.withLock {
        val loadedJar = load()
        if (loadedJar && (removeExpired() || writePending)) persist()
        cookies.filter { it.matches(requestUrl) }.map { it.cookie }
    }

    override suspend fun addCookie(requestUrl: Url, cookie: Cookie) {
        if (cookie.name.isBlank()) return
        // A `Domain` has to be read before `fillDefaults` substitutes the request host for it.
        // Absent, the cookie is host-only; present, it may only widen the cookie to a domain the
        // responding host itself belongs to. One jar is shared by every client in the process, so
        // without that check a response from any host could store a cookie that later requests to
        // an unrelated host would send.
        val domain = cookie.domain?.takeUnless { it.isBlank() }
        if (domain != null && !requestUrl.host.isWithin(domain)) return
        mutex.withLock {
            val loadedJar = load()
            val hostOnly = domain == null
            val stored = cookie.withDefaultPath(requestUrl).fillDefaults(requestUrl)
            val entry = Stored(stored, clock(), hostOnly)
            cookies.removeAll { it.cookie.name == stored.name && it.matches(requestUrl) }
            cookies += entry
            // Record the change before expiry can drop it: a `Max-Age=0` cookie leaves nothing in
            // memory, and without this the sign-out it represents would be undone by a later load.
            if (!loadedJar) changedWhileUnloaded += entry.identity
            removeExpired()
            // Without a jar in hand there is nothing to add to: persisting would replace whatever
            // is in storage with this one cookie. Keep it in memory so the session still works.
            if (loadedJar) persist()
        }
    }

    /**
     * Drops every cookie, in memory and in storage. The whole store is cleared rather than the
     * jar key alone, so cookies written by an earlier version of the library go too.
     */
    suspend fun clear() = mutex.withLock {
        cookies.clear()
        changedWhileUnloaded.clear()
        loaded = true
        try {
            store.clear()
            writePending = false
        } catch (failure: Exception) {
            // Unlike a write on the request path, this is what the caller asked for, so report it.
            // Storage still holds the old jar; leave a write pending so the next call replaces it
            // with the empty one.
            writePending = true
            throw failure
        }
    }

    override fun close() {}

    /**
     * Reads the persisted jar on first use, reporting whether the jar is now in hand. False means
     * storage could not be read, which is temporary — a locked keychain, a failed decrypt — and
     * leaves the jar unloaded so a later call tries again and no write replaces what is stored.
     */
    private suspend fun load(): Boolean {
        if (loaded) return true
        val serialized = try {
            store.get(JAR_KEY)
        } catch (_: Exception) {
            return false
        }
        loaded = true
        // A jar that was read but cannot be interpreted will never become readable, so it counts
        // as empty: the caller signs in again and the next write replaces it. Decoding and parsing
        // are one attempt, so a jar that throws part-way through is discarded whole rather than
        // half-adopted, and anything already in memory is left alone.
        val restored = try {
            serialized?.let {
                BlocksJson.decodeFromString<List<Entry>>(it).map { entry ->
                    Stored(parseServerSetCookieHeader(entry.setCookie), entry.createdAt, entry.hostOnly)
                }
            }.orEmpty()
        } catch (_: Exception) {
            emptyList()
        }
        restored.forEach { if (it.identity !in changedWhileUnloaded) cookies += it }
        // Anything set or deleted while the jar was unreadable has not reached storage yet, so the
        // merged jar has to be written even when nothing expired.
        val unwritten = changedWhileUnloaded.isNotEmpty()
        changedWhileUnloaded.clear()
        // Rewrite here rather than leaving the drop to the caller: the caller's own check finds
        // nothing left to remove, so expired entries would stay in storage until an unrelated write.
        if (removeExpired() || unwritten) persist()
        return true
    }

    /**
     * Mirrors the jar to storage. A write that fails is recorded and retried later rather than
     * raised: this runs inside the request pipeline, and the cookie it carries is already in
     * memory, so failing here would fail a request the server has already answered.
     */
    private suspend fun persist() {
        val entries = cookies.map { Entry(renderSetCookieHeader(it.cookie), it.createdAt, it.hostOnly) }
        writePending = try {
            store.put(JAR_KEY, BlocksJson.encodeToString(entries))
            false
        } catch (_: Exception) {
            true
        }
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
     * Whether this host is covered by [domain] — the domain itself, or a subdomain of it. A
     * leading dot on the domain carries no meaning and is ignored.
     */
    private fun String.isWithin(domain: String): Boolean {
        val scope = domain.removePrefix(".").lowercase()
        val host = lowercase()
        return host == scope || host.endsWith(".$scope")
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
