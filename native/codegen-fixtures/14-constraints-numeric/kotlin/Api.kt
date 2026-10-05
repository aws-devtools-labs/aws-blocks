package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Double
import kotlin.Int
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun setScore(input: SetScore.Input): SetScore.Result {
    val request = BlocksRequest(method = "api.setScore", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object SetScore {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    public data class Input(
      public val score: Double,
      public val level: Int,
      public val step: Double,
    ) {
      init {
        require(score >= 0.0) { "score must be >= 0.0" }
        require(score <= 100.0) { "score must be <= 100.0" }
        require(level > 0) { "level must be > 0" }
        require(step % 0.5 == 0.0) { "step must be a multiple of 0.5" }
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client)
