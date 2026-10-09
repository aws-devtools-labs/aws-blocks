package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun getDoc(_id: String, int: Int? = null): Doc {
    val args: List<JsonElement> = if (int != null) listOf(JsonPrimitive(_id), JsonPrimitive(int)) else listOf(JsonPrimitive(_id))
    val request = BlocksRequest(method = "api.getDoc", params = args, id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun putExtras(extras: Extras): Extras {
    val request = BlocksRequest(method = "api.putExtras", params = listOf(BlocksJson.encodeToJsonElement(extras)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getLevel(): Level {
    val request = BlocksRequest(method = "api.getLevel", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }
}
