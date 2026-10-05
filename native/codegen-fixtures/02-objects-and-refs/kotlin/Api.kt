package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Int
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getTodo(id: String): Todo {
    val request = BlocksRequest(method = "api.getTodo", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun createTodo(input: CreateTodo.Input): Todo {
    val request = BlocksRequest(method = "api.createTodo", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object CreateTodo {
    @Serializable
    public data class Input(
      public val title: String,
      public val priority: Int,
    )
  }
}

public val Blocks.api: Api
  get() = Api(client)
