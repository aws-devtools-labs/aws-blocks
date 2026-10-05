@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Double
import kotlin.OptIn
import kotlin.String
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun doAction(input: DoAction.Input): DoAction.Result {
    val request = BlocksRequest(method = "api.doAction", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object DoAction {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    @JsonClassDiscriminator("type")
    public sealed class Input {
      @Serializable
      @SerialName("add")
      public data class Add(
        public val `value`: Double,
      ) : Input()

      @Serializable
      @SerialName("remove")
      public data class Remove(
        public val id: String,
      ) : Input()
    }
  }
}

public val Blocks.api: Api
  get() = Api(client)
