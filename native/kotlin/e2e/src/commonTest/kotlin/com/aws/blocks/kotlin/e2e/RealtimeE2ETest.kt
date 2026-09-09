package com.aws.blocks.kotlin.e2e

import blocks.e2e.Cursor
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotBeBlank
import io.kotest.matchers.string.shouldStartWith
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.time.Duration.Companion.seconds

class RealtimeE2ETest {

    private val api = createApi()

    @Test
    fun getChannelDescriptor() = runTest {
        val channel = api.realtimeGetChannel()
        channel.channel.shouldNotBeBlank()
        channel.wsUrl.shouldStartWith("ws")
        channel.token.shouldNotBeBlank()
    }

    @Test
    fun publishCursor() = runTest {
        val r = api.realtimePublish(
            cursor = Cursor(userId = "user-a", x = 10.0, y = 20.0, color = "#ff0000")
        )
        r.success.shouldBeTrue()
    }

    @Test
    fun subscribeAndReceive() = runTest {
        val ch = api.realtimeGetChannel("kotlin-test")

        val msg = withContext(Dispatchers.Default) {
            val deferred = async {
                ch.subscribe().first()
            }

            // Publish repeatedly until the subscriber receives the message.
            // The subscription may not be established yet (WebSocket handshake +
            // subscribe ack), so early publishes are lost — keep retrying.
            withTimeout(10.seconds) {
                while (deferred.isActive) {
                    api.realtimePublish(
                        channel = "kotlin-test",
                        cursor = Cursor(userId = "kotlin-sub", x = 42.0, y = 99.0, color = "#00ff00")
                    )
                    delay(100)
                }
                deferred.await()
            }
        }
        msg.userId shouldBe "kotlin-sub"
        msg.x shouldBe 42.0
    }

    @Test
    fun multiplePublishes() = runTest {
        for (i in 0 until 5) {
            val r = api.realtimePublish(
                cursor = Cursor(userId = "burst-$i", x = i.toDouble(), y = (i * 10).toDouble(), color = "#000")
            )
            r.success.shouldBeTrue()
        }
    }
}
