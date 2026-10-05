package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Int
import kotlin.String
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun search(query: Search.Query): Search.Result {
    val request = BlocksRequest(method = "api.search", params = listOf(BlocksJson.encodeToJsonElement(query)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getValue(): String? {
    val request = BlocksRequest(method = "api.getValue", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object Search {
    @Serializable
    public data class Result(
      public val count: Int,
    )

    @Serializable
    public sealed class Query {
      @Serializable
      @SerialName("variant1")
      public data object Variant1 : Query()

      @Serializable
      @SerialName("variant2")
      public data class Variant2(
        public val text: String,
        public val fuzzy: Boolean? = null,
      ) : Query()
    }
  }
}

public val Blocks.api: Api
  get() = Api(client)
