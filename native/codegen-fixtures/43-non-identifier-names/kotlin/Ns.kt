@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.OptIn
import kotlin.String
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Ns(
  private val client: BlocksClient,
) {
  public suspend fun doAction(input: DoAction.Input): DoAction.Result {
    val request = BlocksRequest(method = "ns.do`Action", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object DoAction {
    @Serializable
    public data class Result(
      @SerialName("ok`")
      public val ok: Boolean,
    )

    @Serializable
    @JsonClassDiscriminator("ty pe")
    public sealed class Input {
      @Serializable
      @SerialName("cre\"ate")
      public data class CreAte(
        @SerialName("ti;tle")
        public val tiTle: String,
      ) : Input()

      @Serializable
      @SerialName("re`move")
      public data class ReMove(
        public val `${id}`: String,
      ) : Input()
    }
  }
}

public val Blocks.ns: Ns
  get() = Ns(client())
