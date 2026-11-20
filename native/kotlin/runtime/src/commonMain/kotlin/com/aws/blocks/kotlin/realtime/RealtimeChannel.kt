// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.realtime

import com.aws.blocks.kotlin.defaultHttpClient
import com.aws.blocks.kotlin.exceptions.RealtimeChannelClosedException
import com.aws.blocks.kotlin.exceptions.RealtimeConnectionException
import com.aws.blocks.kotlin.exceptions.RealtimeException
import com.aws.blocks.kotlin.exceptions.RealtimeSubscriptionEndedException
import io.ktor.client.HttpClient
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class RealtimeChannel<T> internal constructor(
    val channel: String,
    val wsUrl: String,
    val token: String,
    private val deserializer: (JsonElement) -> T,
    // No cookie jar: the connect token on [wsUrl] is this channel's credential, and the jar
    // belongs to the Blocks instance, which `fromJson` has no path back to.
    private val httpClient: HttpClient = defaultHttpClient(),
    private val pool: WebSocketPool,
) {
    constructor(
        channel: String,
        wsUrl: String,
        token: String,
        deserializer: (JsonElement) -> T,
        httpClient: HttpClient = defaultHttpClient(),
    ) : this(channel, wsUrl, token, deserializer, httpClient, WebSocketPool.default)

    companion object {
        fun <T> fromJson(element: JsonElement, deserializer: (JsonElement) -> T): RealtimeChannel<T> {
            val obj = element.jsonObject
            val ch = obj["channel"]!!.jsonPrimitive.content
            val baseWsUrl = obj["wsUrl"]!!.jsonPrimitive.content
            val connectToken = obj["connectToken"]?.jsonPrimitive?.content
            val token = obj["token"]!!.jsonPrimitive.content
            val wsUrl = if (connectToken != null) "$baseWsUrl?token=$connectToken" else baseWsUrl
            return RealtimeChannel(channel = ch, wsUrl = wsUrl, token = token, deserializer = deserializer)
        }
    }

    private val closed = MutableStateFlow(false)

    /**
     * Subscribes to this channel. The returned flow is cold: each collection opens its own
     * subscription, joining this channel's shared WebSocket, and doesn't wait for the server
     * to confirm it, so a message published before the server has the subscription can be
     * missed.
     *
     * The flow completes normally only when the app ends it, by cancelling the collection or
     * by calling [close]. Every other end throws one error from [RealtimeException]:
     * - [RealtimeSubscriptionEndedException] when the server refuses the subscribe or ends it
     *   later. On `token_expired`, get the channel again from the API method that returned it
     *   and subscribe to the new handle. The client never repeats that call on its own.
     * - [RealtimeConnectionException] when the socket can't open, fails, or is closed by the
     *   server or the gateway. The client doesn't reconnect; get the channel again and
     *   subscribe to the new handle.
     *
     * A message the deserializer can't decode ends the flow with the deserializer's error.
     *
     * Messages wait in an unbounded buffer until the collector takes them, so a slow collector
     * never holds up other subscriptions on the shared socket. To bound it, apply `buffer` or
     * `conflate` to the returned flow.
     *
     * @throws RealtimeChannelClosedException when the channel is already closed
     */
    fun subscribe(): Flow<T> {
        if (closed.value) {
            throw RealtimeChannelClosedException()
        }

        return flow {
            val subscription = connectUnlessClosed() ?: return@flow
            try {
                coroutineScope {
                    val closeWatcher = launch(start = CoroutineStart.UNDISPATCHED) {
                        closed.first { it }
                        subscription.end()
                    }
                    try {
                        for (payload in subscription.messages) {
                            emit(deserializer(payload))
                        }
                    } finally {
                        closeWatcher.cancel()
                    }
                }
            } finally {
                withContext(NonCancellable) { pool.release(subscription) }
            }
        }
    }

    /**
     * Subscribes through the pool, or returns `null` when [close] runs first, including while
     * the socket is still opening, so a connecting collection completes normally.
     */
    private suspend fun connectUnlessClosed(): WebSocketPool.Subscription? {
        if (closed.value) return null
        // Set from the connect rather than returned through a Deferred: a coroutine cancelled
        // just as it returns drops its result, and the subscription would never be released.
        var subscription: WebSocketPool.Subscription? = null
        try {
            coroutineScope {
                val connect = launch { subscription = pool.subscribe(wsUrl, channel, token, httpClient) }
                val closeWatcher = launch(start = CoroutineStart.UNDISPATCHED) {
                    closed.first { it }
                    connect.cancel()
                }
                connect.join()
                closeWatcher.cancel()
            }
        } catch (e: Throwable) {
            subscription?.let { withContext(NonCancellable) { pool.release(it) } }
            throw e
        }
        if (closed.value) {
            subscription?.let { withContext(NonCancellable) { pool.release(it) } }
            return null
        }
        return subscription
    }

    /**
     * Closes the channel. Every active collection of [subscribe] completes normally, and a
     * later [subscribe] throws [RealtimeChannelClosedException].
     */
    fun close() {
        closed.value = true
    }
}
