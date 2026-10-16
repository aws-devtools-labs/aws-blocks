package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.filebucket.FileUploadHandle
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun relay(feed: RealtimeChannel<Note>): String {
    val request = BlocksRequest(method = "api.relay", params = listOf(feed.toJson()), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun relayIfAny(room: String, feed: RealtimeChannel<Note>? = null): String {
    val args: List<JsonElement> = if (feed != null) listOf(JsonPrimitive(room), feed.toJson()) else listOf(JsonPrimitive(room))
    val request = BlocksRequest(method = "api.relayIfAny", params = args, id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun relayOrNull(feed: RealtimeChannel<Note>?): String {
    val request = BlocksRequest(method = "api.relayOrNull", params = listOf(feed?.toJson() ?: JsonNull), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun relayAll(feeds: List<RealtimeChannel<Note>>, byRoom: Map<String, RealtimeChannel<Note>>): String {
    val request = BlocksRequest(method = "api.relayAll", params = listOf(buildJsonArray { feeds.forEach { add(it.toJson()) } }, buildJsonObject { byRoom.forEach { put(it.key, it.value.toJson()) } }), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun relayInline(feed: RealtimeChannel<RelayInline.Feed>): String {
    val request = BlocksRequest(method = "api.relayInline", params = listOf(feed.toJson()), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun share(download: FileDownloadHandle, upload: FileUploadHandle): String {
    val request = BlocksRequest(method = "api.share", params = listOf(download.toJson(), upload.toJson()), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun forward(bundle: Bundle): String {
    val request = BlocksRequest(method = "api.forward", params = listOf(BlocksJson.encodeToJsonElement(bundle)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object RelayInline {
    @Serializable
    public data class Feed(
      public val text: String,
    )
  }
}
