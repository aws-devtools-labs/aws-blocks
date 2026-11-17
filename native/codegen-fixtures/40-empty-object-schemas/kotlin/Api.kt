package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getOptions(options: Map<String, JsonElement>, extra: Map<String, JsonElement>? = null): Map<String, JsonElement> {
    val args: List<JsonElement> = if (extra != null) listOf(buildJsonObject { options.forEach { put(it.key, it.value) } }, buildJsonObject { extra.forEach { put(it.key, it.value) } }) else listOf(buildJsonObject { options.forEach { put(it.key, it.value) } })
    val request = BlocksRequest(method = "api.getOptions", params = args, id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getSettings(settings: Map<String, JsonElement>): Map<String, JsonElement> {
    val request = BlocksRequest(method = "api.getSettings", params = listOf(buildJsonObject { settings.forEach { put(it.key, it.value) } }), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getEnvelope(): GetEnvelope.Result {
    val request = BlocksRequest(method = "api.getEnvelope", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetEnvelope {
    @Serializable
    public data class Result(
      public val id: String,
      public val meta: Map<String, JsonElement>,
      public val attachments: List<Map<String, JsonElement>>,
      public val settings: Map<String, JsonElement>? = null,
    )
  }
}

public val Blocks.api: Api
  get() = Api(client())
