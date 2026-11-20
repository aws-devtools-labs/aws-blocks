// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.realtime

import com.aws.blocks.kotlin.defaultHttpClient
import com.aws.blocks.kotlin.exceptions.RealtimeChannelClosedException
import com.aws.blocks.kotlin.exceptions.RealtimeConnectionException
import com.aws.blocks.kotlin.exceptions.RealtimeSubscriptionEndedException
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respondError
import io.ktor.client.plugins.HttpTimeoutCapability
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.http.HttpStatusCode
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketExtension
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.readText
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeChannelTest {

    /**
     * Minimal in-memory [WebSocketSession] whose [incoming] channel is fed by the
     * test. Only the members [RealtimeChannel]/[WebSocketPool] touch are functional.
     */
    private class FakeWebSocketSession(
        val inbound: Channel<Frame> = Channel(Channel.UNLIMITED),
    ) : WebSocketSession {
        private val outbound = Channel<Frame>(Channel.UNLIMITED)
        private val sentFrames = mutableListOf<Frame>()

        override var masking: Boolean = false
        override var maxFrameSize: Long = Long.MAX_VALUE
        override val incoming: ReceiveChannel<Frame> = inbound
        override val outgoing: SendChannel<Frame> = outbound
        override val extensions: List<WebSocketExtension<*>> = emptyList()
        override val coroutineContext: CoroutineContext = EmptyCoroutineContext

        override suspend fun flush() {}

        @Deprecated("Use cancel() instead.", level = DeprecationLevel.ERROR)
        override fun terminate() {}

        fun sent(): List<Frame> {
            while (true) sentFrames += outbound.tryReceive().getOrNull() ?: break
            return sentFrames
        }

        fun sentTexts(): List<String> = sent().filterIsInstance<Frame.Text>().map { it.readText() }

        fun pings(): Int = sentTexts().count { it == PING }

        fun unsubscribes(): List<String> = sentTexts()
            .map { Json.parseToJsonElement(it).jsonObject }
            .filter { it["action"]!!.jsonPrimitive.content == "unsubscribe" }
            .map { it.toString() }

        val closed: Boolean get() = sent().any { it is Frame.Close }

        /** Closes `outgoing` the way Ktor does when the server closes the socket. */
        fun closeOutgoing(cause: Throwable) {
            outbound.close(cause)
        }

        fun receive(text: String) {
            inbound.trySend(Frame.Text(text))
        }
    }

    /** A pool whose sockets are fakes and whose readers and pings run on the test's scheduler. */
    private class Harness(scope: CoroutineScope) {
        val sessions = mutableListOf<FakeWebSocketSession>()
        var connectFailure: Throwable? = null

        /** When set, opening a socket waits on this until it completes, like an unanswered upgrade. */
        var handshake: CompletableDeferred<Unit>? = null
        var handshakesStarted = 0

        val pool = WebSocketPool(
            sessionFactory = {
                connectFailure?.let { throw it }
                handshakesStarted++
                handshake?.await()
                FakeWebSocketSession().also { sessions += it }
            },
            scope = scope,
        )

        val session: FakeWebSocketSession get() = sessions.last()

        fun <T> channel(name: String = "c", deserializer: (JsonElement) -> T): RealtimeChannel<T> =
            RealtimeChannel(
                channel = name,
                wsUrl = "wss://example/rt",
                // Each channel has its own token, as the server issues them; the socket is shared by URL.
                token = "tok-$name",
                deserializer = deserializer,
                pool = pool,
            )

        fun channel(name: String = "c"): RealtimeChannel<String> = channel(name) { userId(it) }
    }

    private companion object {
        const val PING = """{"action":"ping"}"""

        fun userId(element: JsonElement): String =
            element.jsonObject["userId"]!!.jsonPrimitive.content

        fun message(channel: String, userId: String) =
            """{"type":"message","channel":"$channel","data":{"userId":"$userId"}}"""
    }

    /** The first cause that isn't the recovered copy described on [causes]. */
    private fun platformCause(error: Throwable): Throwable? =
        generateSequence(error.cause) { it.cause }.firstOrNull { it !is RealtimeConnectionException }

    /**
     * The messages of [error]'s causes. On the JVM, coroutines can rethrow a copy of an
     * exception with a recovered stack trace whose cause is the original, so a test can't
     * compare the cause by identity or by depth.
     */
    private fun causes(error: Throwable): List<String?> =
        generateSequence(error.cause) { it.cause }.map { it.message }.toList()

    /** Collects [flow] into a list, keeping how it ended. */
    private fun <T> TestScope.collecting(flow: Flow<T>): Pair<MutableList<T>, Deferred<Throwable?>> {
        val received = mutableListOf<T>()
        val end = async {
            try {
                flow.collect { received += it }
                null
            } catch (e: Throwable) {
                e
            }
        }
        return received to end
    }

    private fun TestScope.channelFedWith(vararg frames: String): RealtimeChannel<String> {
        val inbound = Channel<Frame>(Channel.UNLIMITED)
        for (text in frames) inbound.trySend(Frame.Text(text))
        val pool = WebSocketPool(sessionFactory = { FakeWebSocketSession(inbound) }, scope = backgroundScope)
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

    @Test
    fun `subscribing to a closed channel throws RealtimeChannelClosedException`() = runTest {
        val channel = channelFedWith()
        channel.close()
        assertFailsWith<RealtimeChannelClosedException> { channel.subscribe() }
    }

    @Test
    fun `collecting sends a subscribe with the channel and its token`() = runTest {
        val h = Harness(backgroundScope)
        val (_, end) = collecting(h.channel().subscribe())
        runCurrent()

        val subscribe = Json.parseToJsonElement(h.session.sentTexts().single()).jsonObject
        subscribe["action"]!!.jsonPrimitive.content shouldBe "subscribe"
        subscribe["channel"]!!.jsonPrimitive.content shouldBe "c"
        subscribe["token"]!!.jsonPrimitive.content shouldBe "tok-c"
        end.cancel()
    }

    @Test
    fun `messages for other channels are not delivered`() = runTest {
        val h = Harness(backgroundScope)
        val (received, end) = collecting(h.channel().subscribe())
        runCurrent()

        h.session.receive(message("other", "x"))
        h.session.receive("""{"type":"subscribe_success","channel":"c"}""")
        h.session.receive("not json")
        h.session.receive(message("c", "y"))
        runCurrent()

        received shouldBe listOf("y")
        end.isActive shouldBe true
        end.cancel()
    }

    @Test
    fun `an error frame for the channel ends it with RealtimeSubscriptionEndedException`() = runTest {
        val h = Harness(backgroundScope)
        val (received, end) = collecting(h.channel().subscribe())
        runCurrent()

        h.session.receive(message("c", "before"))
        h.session.receive(
            """{"type":"error","channel":"c","code":"token_expired","message":"Channel token expired"}""",
        )
        runCurrent()

        received shouldBe listOf("before")
        val error = end.await().shouldBeInstanceOf<RealtimeSubscriptionEndedException>()
        error.channel shouldBe "c"
        error.code shouldBe "token_expired"
        error.message shouldBe "Channel token expired"
    }

    @Test
    fun `a refused subscribe ends the flow with no code`() = runTest {
        val h = Harness(backgroundScope)
        val (_, end) = collecting(h.channel().subscribe())
        runCurrent()

        h.session.receive("""{"type":"error","channel":"c","message":"Unauthorized: invalid or expired token"}""")
        runCurrent()

        val error = end.await().shouldBeInstanceOf<RealtimeSubscriptionEndedException>()
        error.code shouldBe null
        error.message shouldBe "Unauthorized: invalid or expired token"
    }

    @Test
    fun `an error frame for one channel leaves other channels on the socket running`() = runTest {
        val h = Harness(backgroundScope)
        val (_, endedEnd) = collecting(h.channel("a").subscribe())
        val (received, otherEnd) = collecting(h.channel("b").subscribe())
        runCurrent()
        h.sessions.size shouldBe 1

        h.session.receive("""{"type":"error","channel":"a","code":"access_revoked","message":"revoked"}""")
        h.session.receive(message("b", "still-here"))
        runCurrent()

        endedEnd.await().shouldBeInstanceOf<RealtimeSubscriptionEndedException>().code shouldBe "access_revoked"
        received shouldBe listOf("still-here")
        otherEnd.isActive shouldBe true
        h.session.closed shouldBe false
        otherEnd.cancel()
    }

    @Test
    fun `an error frame with no channel ends every subscription on the socket`() = runTest {
        val h = Harness(backgroundScope)
        val (_, aEnd) = collecting(h.channel("a").subscribe())
        val (_, bEnd) = collecting(h.channel("b").subscribe())
        runCurrent()

        h.session.receive("""{"type":"error","message":"Invalid channel"}""")
        runCurrent()

        val error = aEnd.await().shouldBeInstanceOf<RealtimeConnectionException>()
        error.message shouldBe "Invalid channel"
        platformCause(error) shouldBe null
        bEnd.await().shouldBeInstanceOf<RealtimeConnectionException>()
        h.session.closed shouldBe true
        h.pool.connectionCount() shouldBe 0
    }

    @Test
    fun `a socket the server closes ends the flow and leaves the pool`() = runTest {
        val h = Harness(backgroundScope)
        val channel = h.channel()
        val (_, end) = collecting(channel.subscribe())
        runCurrent()

        h.session.inbound.trySend(Frame.Close(CloseReason(4001, "going away")))
        h.session.inbound.close()
        runCurrent()

        val error = end.await().shouldBeInstanceOf<RealtimeConnectionException>()
        error.message shouldBe "Realtime connection closed (code 4001: going away)"
        platformCause(error) shouldBe null
        h.pool.connectionCount() shouldBe 0

        // A later subscribe opens a fresh socket instead of joining the dead one.
        val (received, again) = collecting(channel.subscribe())
        runCurrent()
        h.sessions.size shouldBe 2
        h.session.receive(message("c", "fresh"))
        runCurrent()
        received shouldBe listOf("fresh")
        again.cancel()
    }

    @Test
    fun `a close with no close frame says only that the connection closed`() = runTest {
        val h = Harness(backgroundScope)
        val (_, end) = collecting(h.channel().subscribe())
        runCurrent()

        h.session.inbound.close()
        runCurrent()

        end.await().shouldBeInstanceOf<RealtimeConnectionException>().message shouldBe "Realtime connection closed"
    }

    @Test
    fun `error frames without a message get the default messages`() = runTest {
        val h = Harness(backgroundScope)
        val (_, ended) = collecting(h.channel("a").subscribe())
        runCurrent()
        h.session.receive("""{"type":"error","channel":"a","code":7,"message":""}""")
        runCurrent()

        val subscriptionError = ended.await().shouldBeInstanceOf<RealtimeSubscriptionEndedException>()
        subscriptionError.code shouldBe null
        subscriptionError.message shouldBe "The server ended the subscription to \"a\""

        val (_, failed) = collecting(h.channel("b").subscribe())
        runCurrent()
        h.session.receive("""{"type":"error"}""")
        runCurrent()

        failed.await().shouldBeInstanceOf<RealtimeConnectionException>().message shouldBe
            "The server reported a connection error"
    }

    @Test
    fun `channels with different tokens on one URL share one socket`() = runTest {
        val h = Harness(backgroundScope)
        val (aReceived, aEnd) = collecting(h.channel("a").subscribe())
        val (bReceived, bEnd) = collecting(h.channel("b").subscribe())
        runCurrent()

        h.sessions.size shouldBe 1
        h.session.sentTexts().map { Json.parseToJsonElement(it).jsonObject["token"]!!.jsonPrimitive.content } shouldBe
            listOf("tok-a", "tok-b")
        h.session.receive(message("b", "to-b"))
        h.session.receive(message("a", "to-a"))
        h.session.receive("""{"type":"message","data":{"userId":"no-channel"}}""")
        runCurrent()

        aReceived shouldBe listOf("to-a")
        bReceived shouldBe listOf("to-b")
        aEnd.cancel()
        bEnd.cancel()
    }

    @Test
    fun `a message frame with no payload reaches the deserializer as null`() = runTest {
        val h = Harness(backgroundScope)
        val (received, end) = collecting(h.channel { it.toString() }.subscribe())
        runCurrent()

        h.session.receive("""{"type":"message","channel":"c"}""")
        runCurrent()

        received shouldBe listOf("null")
        end.cancel()
    }

    @Test
    fun `a socket failure ends the flow with RealtimeConnectionException carrying the cause`() = runTest {
        val h = Harness(backgroundScope)
        val (_, end) = collecting(h.channel().subscribe())
        runCurrent()

        h.session.inbound.close(IllegalStateException("connection reset"))
        runCurrent()

        val error = end.await().shouldBeInstanceOf<RealtimeConnectionException>()
        error.message shouldBe "Realtime connection failed: connection reset"
        causes(error) shouldContain "connection reset"
        h.pool.connectionCount() shouldBe 0
    }

    @Test
    fun `a socket that cannot open ends the flow with RealtimeConnectionException`() = runTest {
        val h = Harness(backgroundScope)
        h.connectFailure = IllegalStateException("handshake refused")

        val error = assertFailsWith<RealtimeConnectionException> { h.channel().subscribe().toList() }

        causes(error) shouldContain "handshake refused"
        h.pool.connectionCount() shouldBe 0
    }

    @Test
    fun `a message that fails to decode ends the flow with the deserializer error`() = runTest {
        val h = Harness(backgroundScope)
        val channel = h.channel { throw SerializationException("bad cursor") }
        val (_, end) = collecting(channel.subscribe())
        runCurrent()

        h.session.receive(message("c", "x"))
        runCurrent()

        end.await().shouldBeInstanceOf<SerializationException>().message shouldBe "bad cursor"
        h.session.closed shouldBe true
        h.pool.connectionCount() shouldBe 0
    }

    @Test
    fun `close completes every active flow normally`() = runTest {
        val h = Harness(backgroundScope)
        val channel = h.channel()
        val (_, first) = collecting(channel.subscribe())
        val (_, second) = collecting(channel.subscribe())
        runCurrent()

        channel.close()
        runCurrent()

        first.await() shouldBe null
        second.await() shouldBe null
        h.session.closed shouldBe true
        h.pool.connectionCount() shouldBe 0
        assertFailsWith<RealtimeChannelClosedException> { channel.subscribe() }
    }

    @Test
    fun `close on one channel leaves another channel on the same socket running`() = runTest {
        val h = Harness(backgroundScope)
        val closing = h.channel("a")
        val (_, closedEnd) = collecting(closing.subscribe())
        val (received, otherEnd) = collecting(h.channel("b").subscribe())
        runCurrent()

        closing.close()
        h.session.receive(message("b", "still-here"))
        runCurrent()

        closedEnd.await() shouldBe null
        received shouldBe listOf("still-here")
        h.session.closed shouldBe false
        otherEnd.cancel()
    }

    @Test
    fun `cancelling the first subscriber keeps delivering to the others`() = runTest {
        val h = Harness(backgroundScope)
        val (_, firstEnd) = collecting(h.channel().subscribe())
        val (received, secondEnd) = collecting(h.channel().subscribe())
        runCurrent()

        firstEnd.cancel()
        runCurrent()
        h.session.receive(message("c", "after-cancel"))
        runCurrent()

        received shouldBe listOf("after-cancel")
        h.session.closed shouldBe false
        secondEnd.cancel()
    }

    @Test
    fun `the last collector of a channel leaving a shared socket sends an unsubscribe`() = runTest {
        val h = Harness(backgroundScope)
        val (_, aEnd) = collecting(h.channel("a").subscribe())
        val (received, bEnd) = collecting(h.channel("b").subscribe())
        runCurrent()

        aEnd.cancel()
        runCurrent()

        h.session.unsubscribes() shouldBe listOf("""{"action":"unsubscribe","channel":"a"}""")
        h.session.closed shouldBe false
        h.session.receive(message("b", "still-here"))
        runCurrent()
        received shouldBe listOf("still-here")
        bEnd.cancel()
    }

    @Test
    fun `no unsubscribe while another collector of the channel is on the socket`() = runTest {
        val h = Harness(backgroundScope)
        val channel = h.channel("a")
        val (_, first) = collecting(channel.subscribe())
        val (_, second) = collecting(channel.subscribe())
        val (_, other) = collecting(h.channel("b").subscribe())
        runCurrent()

        first.cancel()
        runCurrent()
        h.session.unsubscribes() shouldBe emptyList()

        second.cancel()
        runCurrent()
        h.session.unsubscribes() shouldBe listOf("""{"action":"unsubscribe","channel":"a"}""")
        other.cancel()
    }

    @Test
    fun `the last collector on the socket closes it without an unsubscribe`() = runTest {
        val h = Harness(backgroundScope)
        val (_, end) = collecting(h.channel().subscribe())
        runCurrent()

        end.cancel()
        runCurrent()

        h.session.unsubscribes() shouldBe emptyList()
        h.session.closed shouldBe true
    }

    @Test
    fun `close and a decode failure unsubscribe their channel from a shared socket`() = runTest {
        val h = Harness(backgroundScope)
        val closing = h.channel("a")
        val (_, closedEnd) = collecting(closing.subscribe())
        val (_, failedEnd) = collecting(h.channel("b") { throw SerializationException("bad") }.subscribe())
        val (_, otherEnd) = collecting(h.channel("c").subscribe())
        runCurrent()

        closing.close()
        h.session.receive(message("b", "x"))
        runCurrent()

        closedEnd.await() shouldBe null
        failedEnd.await().shouldBeInstanceOf<SerializationException>()
        h.session.unsubscribes() shouldBe listOf(
            """{"action":"unsubscribe","channel":"a"}""",
            """{"action":"unsubscribe","channel":"b"}""",
        )
        otherEnd.cancel()
    }

    @Test
    fun `a subscription the server ended sends no unsubscribe`() = runTest {
        val h = Harness(backgroundScope)
        val (_, ended) = collecting(h.channel("a").subscribe())
        val (_, other) = collecting(h.channel("b").subscribe())
        runCurrent()

        h.session.receive("""{"type":"error","channel":"a","code":"token_expired","message":"expired"}""")
        runCurrent()

        ended.await().shouldBeInstanceOf<RealtimeSubscriptionEndedException>()
        h.session.unsubscribes() shouldBe emptyList()
        h.session.closed shouldBe false
        other.cancel()
    }

    @Test
    fun `no unsubscribe after the socket closed`() = runTest {
        val h = Harness(backgroundScope)
        val channel = h.channel("a")
        val (_, aEnd) = collecting(channel.subscribe())
        val (_, bEnd) = collecting(h.channel("b").subscribe())
        runCurrent()

        h.session.inbound.close()
        runCurrent()
        aEnd.await().shouldBeInstanceOf<RealtimeConnectionException>()
        bEnd.await().shouldBeInstanceOf<RealtimeConnectionException>()
        channel.close()
        runCurrent()

        h.session.unsubscribes() shouldBe emptyList()
    }

    @Test
    fun `the WebSocket request has no socket timeout`() = runTest {
        var socketTimeout: Long? = -1
        val engine = MockEngine { request ->
            socketTimeout = request.getCapabilityOrNull(HttpTimeoutCapability)?.socketTimeoutMillis
            respondError(HttpStatusCode.Forbidden)
        }
        val channel = RealtimeChannel(
            channel = "c",
            wsUrl = "wss://example/rt",
            token = "tok",
            deserializer = { userId(it) },
            httpClient = defaultHttpClient(engine),
            pool = WebSocketPool(scope = backgroundScope),
        )

        // The engine runs on its own dispatcher, so connect in real time: under virtual time the
        // handshake timeout would fire before the engine sees the request.
        withContext(Dispatchers.Default) {
            assertFailsWith<RealtimeConnectionException> { channel.subscribe().toList() }
        }

        // The client's 60 s default would otherwise apply to the socket, which is quiet for
        // up to the 9-minute ping interval.
        socketTimeout shouldBe HttpTimeoutConfig.INFINITE_TIMEOUT_MS
    }

    @Test
    fun `a handshake with no answer fails after 30 seconds`() = runTest {
        val h = Harness(backgroundScope)
        h.handshake = CompletableDeferred()
        val (_, end) = collecting(h.channel().subscribe())

        advanceTimeBy(30.seconds - 1.milliseconds)
        runCurrent()
        end.isActive shouldBe true

        advanceTimeBy(1.milliseconds)
        runCurrent()
        val error = end.await().shouldBeInstanceOf<RealtimeConnectionException>()
        error.message shouldBe "Realtime connection failed: no handshake response within 30s"
        h.pool.connectionCount() shouldBe 0
    }

    @Test
    fun `the handshake timeout bounds the WebSocket upgrade through the HTTP client`() = runTest {
        // An engine that takes the request and never answers, as a server that leaves the
        // upgrade hanging. The open socket's own timeout is infinite, so only the handshake
        // timeout can end this. The engine runs on its own dispatcher, so this uses real time
        // and a short handshake timeout.
        val reached = CompletableDeferred<Unit>()
        val engine = MockEngine {
            reached.complete(Unit)
            awaitCancellation()
        }
        val channel = RealtimeChannel(
            channel = "c",
            wsUrl = "wss://example/rt",
            token = "tok",
            deserializer = { userId(it) },
            httpClient = defaultHttpClient(engine),
            pool = WebSocketPool(scope = backgroundScope, handshakeTimeout = 1.seconds),
        )

        val error = withContext(Dispatchers.Default) {
            withTimeout(10.seconds) {
                assertFailsWith<RealtimeConnectionException> { channel.subscribe().toList() }
            }
        }

        reached.isCompleted shouldBe true
        error.message shouldBe "Realtime connection failed: no handshake response within 1s"
    }

    @Test
    fun `close while the socket is opening completes the collection normally`() = runTest {
        val h = Harness(backgroundScope)
        h.handshake = CompletableDeferred()
        val channel = h.channel()
        val (_, end) = collecting(channel.subscribe())
        runCurrent()
        h.handshakesStarted shouldBe 1

        channel.close()
        runCurrent()

        end.await() shouldBe null
        h.pool.connectionCount() shouldBe 0
    }

    @Test
    fun `close as the handshake finishes completes normally and leaves no socket open`() = runTest {
        val h = Harness(backgroundScope)
        val handshake = CompletableDeferred<Unit>()
        h.handshake = handshake
        val channel = h.channel()
        val (_, end) = collecting(channel.subscribe())
        runCurrent()

        handshake.complete(Unit)
        channel.close()
        runCurrent()

        end.await() shouldBe null
        h.pool.connectionCount() shouldBe 0
        h.sessions.forEach { it.closed shouldBe true }
    }

    @Test
    fun `joining a socket whose outgoing is closing ends with RealtimeConnectionException`() = runTest {
        val h = Harness(backgroundScope)
        val (_, first) = collecting(h.channel("a").subscribe())
        runCurrent()

        // Ktor closes `outgoing` with a CancellationException before the reader sees `incoming` close.
        h.session.closeOutgoing(CancellationException("WebSocket session closed with code 1001"))
        val (_, second) = collecting(h.channel("b").subscribe())
        runCurrent()

        second.await().shouldBeInstanceOf<RealtimeConnectionException>()
        first.await().shouldBeInstanceOf<RealtimeConnectionException>()
        h.pool.connectionCount() shouldBe 0
    }

    @Test
    fun `pings every nine minutes while subscribed and stops after the last subscriber leaves`() = runTest {
        val h = Harness(backgroundScope)
        val job = launch { h.channel().subscribe().collect {} }
        runCurrent()
        val session = h.session
        session.pings() shouldBe 0

        advanceTimeBy(9.minutes - 1.milliseconds)
        runCurrent()
        session.pings() shouldBe 0

        advanceTimeBy(1.milliseconds)
        runCurrent()
        session.pings() shouldBe 1

        advanceTimeBy(9.minutes)
        runCurrent()
        session.pings() shouldBe 2

        job.cancel()
        runCurrent()
        advanceTimeBy(30.minutes)
        runCurrent()
        session.pings() shouldBe 2
        session.closed shouldBe true
        h.pool.connectionCount() shouldBe 0
    }

    @Test
    fun `an error frame after a ping ends the subscription`() = runTest {
        val h = Harness(backgroundScope)
        val (_, end) = collecting(h.channel().subscribe())
        runCurrent()

        advanceTimeBy(9.minutes)
        runCurrent()
        h.session.pings() shouldBe 1
        h.session.receive("""{"type":"error","channel":"c","code":"token_expired","message":"expired"}""")
        runCurrent()

        end.await().shouldBeInstanceOf<RealtimeSubscriptionEndedException>().code shouldBe "token_expired"
    }
}
