package com.aws.blocks.kotlin.realtime

import com.aws.blocks.kotlin.defaultHttpClient
import io.ktor.client.HttpClient
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlin.concurrent.Volatile
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class RealtimeChannel<T>(
    val channel: String,
    val wsUrl: String,
    val token: String,
    private val deserializer: (JsonElement) -> T,
    private val httpClient: HttpClient = defaultHttpClient(),
    private val pool: WebSocketPool = WebSocketPool.default
) {
    companion object {
        fun <T> fromJson(element: JsonElement, deserializer: (JsonElement) -> T): RealtimeChannel<T> {
            val obj = element.jsonObject
            val ch = obj["channel"]!!.jsonPrimitive.content
            val baseWsUrl = obj["wsUrl"]!!.jsonPrimitive.content
            val connectToken = obj["connectToken"]?.jsonPrimitive?.content
            val token = obj["token"]!!.jsonPrimitive.content
            val wsUrl = if (connectToken != null) "$baseWsUrl?token=$connectToken" else baseWsUrl
            return RealtimeChannel(channel = ch, wsUrl = wsUrl, token = token, deserializer = deserializer).also {
                it.wireWsUrl = baseWsUrl
                it.wireConnectToken = connectToken
            }
        }
    }

    /**
     * The descriptor's `wsUrl` and `connectToken` as the server sent them, before the connect
     * token went onto [wsUrl]. `null` for a channel built with the constructor. [toJson] writes these back.
     */
    private var wireWsUrl: String? = null
    private var wireConnectToken: String? = null

    /**
     * This channel's descriptor, as the server's `toJSON()` sends it and [fromJson] reads it:
     * `{ "__blocks": "realtime/channel", "channel", "wsUrl", "connectToken"?, "token" }`. A
     * generated client sends a channel parameter this way.
     */
    fun toJson(): JsonObject = buildJsonObject {
        put("__blocks", "realtime/channel")
        put("channel", channel)
        put("wsUrl", wireWsUrl ?: wsUrl)
        wireConnectToken?.let { put("connectToken", it) }
        put("token", token)
    }

    @Volatile
    private var closed = false

    fun subscribe(): Flow<T> {
        if (closed) {
            throw IllegalStateException("Channel is closed")
        }

        return flow {
            coroutineScope {
                val managed = pool.acquire(wsUrl, token, this, httpClient)

                val subscribeMsg = """{"action":"subscribe","channel":"$channel","token":"$token"}"""
                managed.session.send(Frame.Text(subscribeMsg))

                try {
                    managed.frames.mapNotNull { frame ->
                        val text = frame.readText()
                        val json = Json.parseToJsonElement(text)
                        val obj = json as? JsonObject ?: return@mapNotNull null
                        val type = obj["type"]?.let { (it as? JsonPrimitive)?.content }
                        if (type != "message") return@mapNotNull null
                        val msgChannel = obj["channel"]?.let { (it as? JsonPrimitive)?.content }
                        if (msgChannel != channel) return@mapNotNull null
                        // AWS API Gateway emits the body under `data`; the mock/dev
                        // server uses `payload`. Accept both.
                        val payload = obj["data"] ?: obj["payload"] ?: return@mapNotNull null
                        deserializer(payload)
                    }.collect { emit(it) }
                } finally {
                    pool.release(wsUrl, token)
                }
            }
        }
    }

    fun close() {
        closed = true
    }
}
