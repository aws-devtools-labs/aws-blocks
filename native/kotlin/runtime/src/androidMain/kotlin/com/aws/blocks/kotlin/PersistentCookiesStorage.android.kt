package com.aws.blocks.kotlin

/**
 * One jar for the process. Android storage is the application's own sandbox, so there is a single
 * location and every instance shares it — two jars over it would not interleave their writes.
 */
private val sharedJar: PersistentCookiesStorage by lazy {
    PersistentCookiesStorage(platformKeyValueStore(COOKIE_STORE_NAME, BlocksPlatformConfig()))
}

internal actual fun cookieJar(platformConfig: BlocksPlatformConfig): PersistentCookiesStorage =
    sharedJar
