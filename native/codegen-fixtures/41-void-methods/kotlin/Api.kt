package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun ping() {
    val request = BlocksRequest(method = "api.ping", params = emptyList(), id = BlocksRequest.nextId())
    client.execute(request)
  }

  public suspend fun remember(note: String, tag: String? = null) {
    val args: List<JsonElement> = if (tag != null) listOf(JsonPrimitive(note), JsonPrimitive(tag)) else listOf(JsonPrimitive(note))
    val request = BlocksRequest(method = "api.remember", params = args, id = BlocksRequest.nextId())
    client.execute(request)
  }

  public suspend fun count(): Int {
    val request = BlocksRequest(method = "api.count", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }
}

public val Blocks.api: Api
  get() = Api(client())
