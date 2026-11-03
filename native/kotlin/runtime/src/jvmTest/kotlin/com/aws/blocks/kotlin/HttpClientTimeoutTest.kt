package com.aws.blocks.kotlin

import com.sun.net.httpserver.HttpServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.ktor.client.network.sockets.SocketTimeoutException
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.client.plugins.timeout
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.Executors
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlinx.coroutines.runBlocking

/** Runs against the real JVM engine (OkHttp), whose own defaults are 10 s. */
class HttpClientTimeoutTest {

    private val handlerPool = Executors.newCachedThreadPool()

    private val server: HttpServer =
        HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0).apply {
            executor = handlerPool
            createContext("/") { exchange ->
                val delayMillis = exchange.requestURI.query?.removePrefix("delay=")?.toLong() ?: 0L
                Thread.sleep(delayMillis)
                val body = "ok".toByteArray()
                exchange.sendResponseHeaders(200, body.size.toLong())
                exchange.responseBody.use { it.write(body) }
            }
            start()
        }

    private val baseUrl = "http://127.0.0.1:${server.address.port}/"

    private val client = defaultHttpClient(cookiesStorage = AcceptAllCookiesStorage())

    @AfterTest
    fun tearDown() {
        client.close()
        server.stop(0)
        handlerPool.shutdownNow()
    }

    @Test
    fun `a response slower than 10 s succeeds`() = runBlocking<Unit> {
        client.get("$baseUrl?delay=11000").bodyAsText() shouldBe "ok"
    }

    @Test
    fun `a per-request socket timeout still fails fast`() = runBlocking<Unit> {
        shouldThrow<SocketTimeoutException> {
            client.get("$baseUrl?delay=5000") { timeout { socketTimeoutMillis = 200 } }
        }
    }
}
