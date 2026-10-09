package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Deprecated
import kotlin.DeprecationLevel
import kotlin.Nothing
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
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

  public suspend fun getBoard(): Board {
    val request = BlocksRequest(method = "api.getBoard", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun saveLayout(layout: Layout): Layout {
    val request = BlocksRequest(method = "api.saveLayout", params = listOf(BlocksJson.encodeToJsonElement(layout)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun groupNotes(groups: Map<String, List<Note>>, levels: List<Level>? = null): Map<String, List<Note>> {
    val args: List<JsonElement> = if (levels != null) listOf(buildJsonObject { groups.forEach { put(it.key, buildJsonArray { it.value.forEach { add(BlocksJson.encodeToJsonElement(it)) } }) } }, buildJsonArray { levels.forEach { add(BlocksJson.encodeToJsonElement(it)) } }) else listOf(buildJsonObject { groups.forEach { put(it.key, buildJsonArray { it.value.forEach { add(BlocksJson.encodeToJsonElement(it)) } }) } })
    val request = BlocksRequest(method = "api.groupNotes", params = args, id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun listFeeds(): List<RealtimeChannel<Note>> {
    val request = BlocksRequest(method = "api.listFeeds", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(ListSerializer(RealtimeChannelNoteSerializer), result)
  }

  @Deprecated(
    message = "OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.",
    level = DeprecationLevel.ERROR,
  )
  public suspend fun getLoginMenu(): Nothing = throw NotImplementedError("OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.")
}
