// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.realtime

import com.aws.blocks.kotlin.exceptions.RealtimeConnectionException
import com.aws.blocks.kotlin.exceptions.RealtimeSubscriptionEndedException
import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.timeout
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.websocket.CloseReason
import io.ktor.websocket.DefaultWebSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import io.ktor.websocket.readReason
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/**
 * Shares one WebSocket per URL between the subscriptions that use it. The URL carries the
 * connect token, so channels whose handles share an endpoint and a connect token share a
 * socket, whatever their channel tokens.
 *
 * The pool owns each socket's reader and keep-alive ping, so they run in [scope] rather than
 * in any one subscriber's coroutine: cancelling one subscriber doesn't stop delivery to the
 * others. When the last subscription to a channel on a socket ends and the socket stays open,
 * the pool sends `{"action":"unsubscribe","channel":...}` so the server stops delivering that
 * channel, as the web client does. A socket closes when its last subscription ends, which ends
 * its server-side subscriptions too, and a socket that fails or is closed by the server leaves
 * the pool at once, ending every subscription on it with [RealtimeConnectionException], so a
 * later subscribe opens a fresh one.
 *
 * @param sessionFactory opens a session for a URL instead of the channel's HTTP client
 * @param scope where readers and pings run
 * @param handshakeTimeout how long opening a socket can take before the collection fails with
 *   [RealtimeConnectionException]. It covers the whole connect and upgrade, which the open
 *   socket's own timeout no longer does. The default matches the Swift client.
 * @param pingInterval how often each socket sends `{"action":"ping"}` while it has a
 *   subscription. The server re-checks the socket's subscriptions only on this message (a
 *   protocol-level ping doesn't trigger it), and it also keeps the gateway's 10-minute idle
 *   timeout from closing the socket. The default matches the web client.
 */
internal class WebSocketPool(
    private val sessionFactory: (suspend (String) -> WebSocketSession)? = null,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    private val pingInterval: Duration = DEFAULT_PING_INTERVAL,
    private val handshakeTimeout: Duration = DEFAULT_HANDSHAKE_TIMEOUT,
) {
    companion object {
        /** Matches the web client's `KEEP_ALIVE_MS`. */
        val DEFAULT_PING_INTERVAL: Duration = 9.minutes

        /** Matches the Swift client's `handshakeTimeout`. */
        val DEFAULT_HANDSHAKE_TIMEOUT: Duration = 30.seconds

        val default = WebSocketPool()

        private const val PING_MESSAGE = """{"action":"ping"}"""

        private fun unsubscribeMessage(channel: String): String = buildJsonObject {
            put("action", "unsubscribe")
            put("channel", channel)
        }.toString()
    }

    private val mutex = Mutex()
    private val connections = mutableMapOf<String, Connection>()

    class Connection(val url: String, val session: WebSocketSession) {
        val subscriptions = mutableListOf<Subscription>()
        var dead = false
        var jobs: List<Job> = emptyList()
    }

    /**
     * One collection of a channel's flow. [messages] carries the payload of each message for
     * [channel]; it closes with the error that ended the subscription, or normally when the
     * app ended it.
     *
     * The buffer is unbounded on purpose. One reader serves every channel on the socket, so
     * a bounded buffer could only either suspend that reader when one collector falls behind,
     * which would stall the other channels and hold up the error frames that end a
     * subscription, or drop messages without telling the app. The Dart and Swift clients
     * buffer their streams the same way. An app that wants a bound applies it to the flow
     * it collects, for example with `buffer(capacity, BufferOverflow.DROP_OLDEST)` or
     * `conflate()`.
     */
    class Subscription(val channel: String) {
        private val events = Channel<JsonElement>(Channel.UNLIMITED)
        val messages: ReceiveChannel<JsonElement> get() = events
        var connection: Connection? = null

        fun deliver(payload: JsonElement) {
            events.trySend(payload)
        }

        /** Ends the subscription, normally when [cause] is `null`. A later end is ignored. */
        fun end(cause: Throwable? = null) {
            events.close(cause)
        }
    }

    /**
     * Joins or opens the socket for [wsUrl], then subscribes to [channel] on it with
     * [channelToken].
     * Messages and errors for the channel arrive on the returned subscription's
     * [Subscription.messages]. Pass it to [release] when the collection ends.
     *
     * @throws RealtimeConnectionException when the socket can't be opened or the subscribe
     *   can't be sent
     */
    suspend fun subscribe(
        wsUrl: String,
        channel: String,
        channelToken: String,
        httpClient: HttpClient,
    ): Subscription {
        val subscription = Subscription(channel)
        val connection = join(wsUrl, subscription, httpClient)
        val subscribeMessage = buildJsonObject {
            put("action", "subscribe")
            put("channel", channel)
            put("token", channelToken)
        }.toString()
        try {
            connection.session.send(Frame.Text(subscribeMessage))
        } catch (e: Throwable) {
            // A socket that is closing can close `outgoing` with a CancellationException before
            // the reader sees `incoming` close. Only a cancelled caller rethrows it; otherwise
            // the socket is going away, and the collector gets a RealtimeConnectionException.
            if (e is CancellationException && !currentCoroutineContext().isActive) {
                withContext(NonCancellable) { release(subscription) }
                throw e
            }
            val error = connectionFailed(e)
            withContext(NonCancellable) {
                fail(connection, error)
                release(subscription)
            }
            throw error
        }
        return subscription
    }

    private suspend fun join(url: String, subscription: Subscription, httpClient: HttpClient): Connection {
        mutex.withLock {
            connections[url]?.let { existing ->
                existing.attach(subscription)
                return existing
            }
        }

        val session = try {
            // withTimeoutOrNull rather than withTimeout: a TimeoutCancellationException is a
            // CancellationException, and the catch below would pass it on as a silent cancel.
            withTimeoutOrNull(handshakeTimeout) {
                sessionFactory?.invoke(url) ?: httpClient.webSocketSession(url) {
                    // The client's socket timeout is for request/response calls. A realtime
                    // socket is quiet for up to the ping interval, and the Darwin engine applies
                    // this value as the WebSocket request's timeout interval, so turn it off
                    // here. That also removes the engine's bound on the handshake, which
                    // handshakeTimeout replaces.
                    timeout { socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS }
                }
            } ?: throw RealtimeConnectionException(
                "Realtime connection failed: no handshake response within $handshakeTimeout",
            )
        } catch (e: RealtimeConnectionException) {
            throw e
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            throw connectionFailed(e)
        }

        // Not cancellable, so a session opened above is either pooled or closed.
        return withContext(NonCancellable) { adopt(url, session, subscription) }
    }

    private suspend fun adopt(url: String, session: WebSocketSession, subscription: Subscription): Connection {
        mutex.withLock {
            connections[url]?.let { existing ->
                existing.attach(subscription)
                scope.launch { closeQuietly(session) }
                return existing
            }
            val connection = Connection(url, session)
            connection.attach(subscription)
            connections[url] = connection
            connection.jobs = listOf(
                scope.launch { read(connection) },
                scope.launch { ping(connection) },
            )
            return connection
        }
    }

    private fun Connection.attach(subscription: Subscription) {
        subscriptions += subscription
        subscription.connection = this
    }

    /**
     * Ends [subscription]'s share of its socket. When it was the last subscription to its
     * channel and the socket stays open, sends an `unsubscribe` for the channel. The socket
     * closes when its last subscription is released. Releasing twice, or after the socket
     * failed, does nothing.
     */
    suspend fun release(subscription: Subscription) {
        subscription.end()
        val connection = subscription.connection ?: return
        mutex.withLock {
            val wasActive = connection.subscriptions.remove(subscription)
            if (connection.dead) return
            if (connection.subscriptions.isNotEmpty()) {
                if (wasActive && connection.subscriptions.none { it.channel == subscription.channel }) {
                    // Queued while holding the lock, so it stays ahead of a later subscribe to
                    // the same channel. trySend fails when the socket is closing, and then the
                    // server drops the subscription when the socket goes. It also fails when the
                    // session's outgoing buffer (8 frames) is full. That loss is accepted: the
                    // server keeps delivering the channel, and the pool drops those messages
                    // because no subscription is left to route them to. Sending from a launched
                    // coroutine instead would lose the ordering against a later subscribe.
                    connection.session.outgoing.trySend(Frame.Text(unsubscribeMessage(subscription.channel)))
                }
                return
            }
            connection.dead = true
            if (connections[connection.url] === connection) connections.remove(connection.url)
            connection.jobs.forEach { it.cancel() }
        }
        scope.launch { closeQuietly(connection.session) }
    }

    /** Takes [connection] out of the pool and ends every subscription on it with [error]. */
    private suspend fun fail(connection: Connection, error: RealtimeConnectionException) {
        val ended = mutex.withLock {
            if (connection.dead) return
            connection.dead = true
            if (connections[connection.url] === connection) connections.remove(connection.url)
            connection.subscriptions.toList()
        }
        ended.forEach { it.end(error) }
        connection.jobs.forEach { it.cancel() }
        scope.launch { closeQuietly(connection.session) }
    }

    private suspend fun read(connection: Connection) {
        val error = try {
            var ended: RealtimeConnectionException? = null
            var closeFrame: CloseReason? = null
            for (frame in connection.session.incoming) {
                when (frame) {
                    is Frame.Text -> ended = dispatch(connection, frame.readText())
                    // A session that isn't a DefaultWebSocketSession passes the close frame on.
                    is Frame.Close -> closeFrame = frame.readReason()
                    else -> {}
                }
                if (ended != null) break
            }
            ended ?: RealtimeConnectionException(closedMessage(closeFrame ?: closeReason(connection.session)))
        } catch (e: CancellationException) {
            if (!currentCoroutineContext().isActive) throw e
            connectionFailed(e)
        } catch (e: Throwable) {
            connectionFailed(e)
        }
        fail(connection, error)
    }

    /**
     * Routes one text frame. Returns the error that ends the whole socket, for an error frame
     * that names no channel, or `null` to keep reading.
     */
    private suspend fun dispatch(connection: Connection, text: String): RealtimeConnectionException? {
        val frame = try {
            Json.parseToJsonElement(text) as? JsonObject
        } catch (e: Exception) {
            null
        } ?: return null
        val type = frame.string("type")
        val channel = frame.string("channel")
        when (type) {
            "message" -> {
                if (channel == null) return null
                // AWS API Gateway emits the body under `data`; the mock/dev
                // server uses `payload`. Accept both. With neither, the
                // deserializer gets null and decides.
                val payload = frame["data"]?.takeUnless { it is JsonNull } ?: frame["payload"] ?: JsonNull
                subscriptionsFor(connection, channel).forEach { it.deliver(payload) }
            }
            "error" -> {
                val message = frame.string("message")?.takeIf { it.isNotEmpty() }
                if (channel == null) {
                    return RealtimeConnectionException(message ?: "The server reported a connection error")
                }
                val error = RealtimeSubscriptionEndedException(
                    channel = channel,
                    code = frame.string("code"),
                    message = message ?: "The server ended the subscription to \"$channel\"",
                )
                // The server has already dropped this channel's subscription, so take these
                // out of the socket now: their release sends no unsubscribe.
                val ended = mutex.withLock {
                    connection.subscriptions.filter { it.channel == channel }
                        .also { connection.subscriptions.removeAll(it) }
                }
                ended.forEach { it.end(error) }
            }
        }
        return null
    }

    private suspend fun subscriptionsFor(connection: Connection, channel: String?): List<Subscription> =
        mutex.withLock { connection.subscriptions.filter { it.channel == channel } }

    private suspend fun ping(connection: Connection) {
        while (true) {
            delay(pingInterval)
            try {
                connection.session.send(Frame.Text(PING_MESSAGE))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                fail(connection, connectionFailed(e))
                return
            }
        }
    }

    private suspend fun closeReason(session: WebSocketSession): CloseReason? =
        (session as? DefaultWebSocketSession)?.closeReason?.let { deferred ->
            withTimeoutOrNull(100.milliseconds) { deferred.await() }
        }

    private fun closedMessage(reason: CloseReason?): String = when {
        reason == null -> "Realtime connection closed"
        reason.message.isEmpty() -> "Realtime connection closed (code ${reason.code})"
        else -> "Realtime connection closed (code ${reason.code}: ${reason.message})"
    }

    private fun connectionFailed(cause: Throwable) =
        RealtimeConnectionException("Realtime connection failed: ${cause.message ?: cause}", cause)

    private suspend fun closeQuietly(session: WebSocketSession) {
        try {
            session.close()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // The socket is already gone.
        }
    }

    suspend fun connectionCount(): Int = mutex.withLock {
        connections.size
    }

    private fun JsonObject.string(name: String): String? =
        (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
}
