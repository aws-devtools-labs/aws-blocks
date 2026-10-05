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

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getProfile(userId: String): GetProfile.Result {
    val request = BlocksRequest(method = "api.getProfile", params = listOf(JsonPrimitive(userId)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetProfile {
    @Serializable
    public data class Result(
      public val name: String,
      public val bio: String? = null,
      public val age: Int? = null,
    )
  }
}

public val Blocks.api: Api
  get() = Api(client)
