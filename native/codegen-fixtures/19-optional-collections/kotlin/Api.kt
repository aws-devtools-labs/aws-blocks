package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getUser(id: String): GetUser.Result {
    val request = BlocksRequest(method = "api.getUser", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun updateUser(input: UpdateUser.Input): UpdateUser.Result {
    val request = BlocksRequest(method = "api.updateUser", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetUser {
    @Serializable
    public data class Result(
      public val name: String,
      public val tags: List<String>,
      public val scores: List<Int>? = null,
      public val metadata: Map<String, String>? = null,
      public val nicknames: List<String?>? = null,
    )
  }

  public object UpdateUser {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    public data class Input(
      public val id: String,
      public val tags: List<String>? = null,
      public val metadata: Map<String, String>? = null,
    )
  }
}

public val Blocks.api: Api
  get() = Api(client)
