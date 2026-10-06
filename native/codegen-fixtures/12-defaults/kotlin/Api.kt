package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Int
import kotlin.String
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun createItem(): CreateItem.Result {
    val request = BlocksRequest(method = "api.createItem", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object CreateItem {
    @Serializable
    public data class Result(
      public val role: String = "viewer",
      public val active: Boolean = true,
      public val retries: Int = 3,
    )
  }
}

public val Blocks.api: Api
  get() = Api(client)
