package com.aws.blocks.kotlin

import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.http.Cookie
import io.ktor.http.Url
import io.ktor.http.parseServerSetCookieHeader
import io.ktor.http.renderSetCookieHeader

internal class PersistentCookiesStorage(
    private val store: KeyValueStore = encryptedKeyValueStore("cookies")
) : CookiesStorage {

    override suspend fun addCookie(requestUrl: Url, cookie: Cookie) {
        val key = "${requestUrl.host}|${cookie.name}"
        store.put(key, renderSetCookieHeader(cookie))
    }

    override suspend fun get(requestUrl: Url): List<Cookie> {
        val prefix = "${requestUrl.host}|"
        return store.getAll()
            .filter { (key, _) -> key.startsWith(prefix) }
            .mapNotNull { (_, value) -> parseServerSetCookieHeader(value) }
    }

    fun clear() {
        store.getAll().keys.forEach { store.remove(it) }
    }

    override fun close() {}
}
