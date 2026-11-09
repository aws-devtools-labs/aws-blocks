package com.aws.blocks.kotlin

/**
 * One jar for the process. Keychain items are scoped to the application's access group, so there
 * is a single location and every instance shares it — two jars over it would not interleave their
 * writes.
 */
private val sharedJar: PersistentCookiesStorage by lazy {
    PersistentCookiesStorage(platformKeyValueStore(COOKIE_STORE_NAME, applicationId = null))
}

internal actual fun cookieJar(applicationId: String?): PersistentCookiesStorage =
    sharedJar
