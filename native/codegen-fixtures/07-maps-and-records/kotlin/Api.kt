package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Double
import kotlin.String
import kotlin.collections.Map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getScores(): Map<String, Double> {
    val request = BlocksRequest(method = "api.getScores", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun signUp(input: SignUp.Input): SignUp.Result {
    val request = BlocksRequest(method = "api.signUp", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object SignUp {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    public data class Input(
      public val username: String,
      public val password: String,
      public val attributes: Map<String, String> = emptyMap(),
    )
  }
}

public val Blocks.api: Api
  get() = Api(client)
