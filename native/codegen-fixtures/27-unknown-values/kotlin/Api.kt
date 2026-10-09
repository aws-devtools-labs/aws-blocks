package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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

  public suspend fun echo(payload: JsonElement): JsonElement {
    val request = BlocksRequest(method = "api.echo", params = listOf(payload), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun store(entry: Entry): Entry {
    val request = BlocksRequest(method = "api.store", params = listOf(BlocksJson.encodeToJsonElement(entry)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun collect(
    items: List<JsonElement>,
    metadata: Map<String, JsonElement>,
    maybe: JsonElement?,
    holes: List<JsonElement?>,
    sparse: Map<String, JsonElement?>,
    extra: JsonElement? = null,
  ): List<JsonElement> {
    val args: List<JsonElement> = if (extra != null) listOf(buildJsonArray { items.forEach { add(it) } }, buildJsonObject { metadata.forEach { put(it.key, it.value) } }, maybe ?: JsonNull, buildJsonArray { holes.forEach { add(it ?: JsonNull) } }, buildJsonObject { sparse.forEach { put(it.key, it.value ?: JsonNull) } }, extra) else listOf(buildJsonArray { items.forEach { add(it) } }, buildJsonObject { metadata.forEach { put(it.key, it.value) } }, maybe ?: JsonNull, buildJsonArray { holes.forEach { add(it ?: JsonNull) } }, buildJsonObject { sparse.forEach { put(it.key, it.value ?: JsonNull) } })
    val request = BlocksRequest(method = "api.collect", params = args, id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }
}
