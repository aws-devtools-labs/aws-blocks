package com.aws.blocks.kotlin.realtime

import io.kotest.matchers.shouldBe
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketExtension
import io.ktor.websocket.WebSocketSession
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.time.Duration.Companion.seconds

class RealtimeChannelTest {

    /**
     * Minimal in-memory [WebSocketSession] whose [incoming] channel is fed by the
     * test. Only the members [RealtimeChannel]/[WebSocketPool] touch are functional.
     */
    private class FakeWebSocketSession(
        private val inbound: ReceiveChannel<Frame>,
    ) : WebSocketSession {
        override var masking: Boolean = false
        override var maxFrameSize: Long = Long.MAX_VALUE
        override val incoming: ReceiveChannel<Frame> = inbound
        override val outgoing: SendChannel<Frame> = Channel(Channel.UNLIMITED)
        override val extensions: List<WebSocketExtension<*>> = emptyList()
        override val coroutineContext: CoroutineContext = EmptyCoroutineContext

        override suspend fun flush() {}

        @Deprecated("Use cancel() instead.", level = DeprecationLevel.ERROR)
        override fun terminate() {}
    }

    private fun userId(element: JsonElement): String =
        element.jsonObject["userId"]!!.jsonPrimitive.content

    private fun channelFedWith(vararg frames: String): RealtimeChannel<String> {
        val inbound = Channel<Frame>(Channel.UNLIMITED)
        for (text in frames) inbound.trySend(Frame.Text(text))
        val pool = WebSocketPool(sessionFactory = { FakeWebSocketSession(inbound) })
        return RealtimeChannel(
            channel = "c",
            wsUrl = "wss://example/rt",
            token = "tok",
            deserializer = { userId(it) },
            pool = pool,
        )
    }

    // AWS API Gateway broadcasts `{ type, channel, data }`; the mock/dev server
    // uses `{ type, channel, payload }`. The client must accept both.
    @Test
    fun subscribeReceivesAwsDataKey() = runTest {
        val channel = channelFedWith(
            """{"type":"message","channel":"c","data":{"userId":"aws-user"}}""",
        )
        val msg = withTimeout(3.seconds) { channel.subscribe().first() }
        msg shouldBe "aws-user"
    }

    @Test
    fun subscribeReceivesMockPayloadKey() = runTest {
        val channel = channelFedWith(
            """{"type":"message","channel":"c","payload":{"userId":"mock-user"}}""",
        )
        val msg = withTimeout(3.seconds) { channel.subscribe().first() }
        msg shouldBe "mock-user"
    }
}
