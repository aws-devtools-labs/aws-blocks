package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Double
import kotlin.Int
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun echo(
    text: String,
    count: Int,
    score: Double,
    enabled: Boolean,
  ): Echo.Result {
    val request = BlocksRequest(method = "api.echo", params = listOf(JsonPrimitive(text), JsonPrimitive(count), JsonPrimitive(score), JsonPrimitive(enabled)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object Echo {
    @Serializable
    public data class Result(
      public val text: String,
      public val count: Int,
      public val score: Double,
      public val enabled: Boolean,
    )
  }
}

public val Blocks.api: Api
  get() = Api(client)
