package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun setTags(input: SetTags.Input): SetTags.Result {
    val request = BlocksRequest(method = "api.setTags", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object SetTags {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    public data class Input(
      public val tags: List<String>,
    ) {
      init {
        require(tags.size >= 1) { "tags must have at least 1 items" }
        require(tags.size <= 10) { "tags must have at most 10 items" }
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client)
