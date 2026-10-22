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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  /**
   * Gets *&#47; a widget &#47;* with "quotes" 'single' $x ${y} and \( paren
   * second line
   *
   * @param id Param *&#47; id &#47;* "q" 'q' $x ${y} \(z)
   * next
   * Result *&#47; widget &#47;* "q" 'q' $x ${y} \(z)
   * next
   */
  public suspend fun `get$x`(id: String): Widget {
    val request = BlocksRequest(method = "api.get${'$'}x", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  /**
   * Runs an action; tag values contain $
   */
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
    @JsonClassDiscriminator("action")
    public sealed class Input {
      @Serializable
      @SerialName("create${'$'}")
      public data class `Create$`(
        public val title: String,
      ) : Input()

      @Serializable
      @SerialName("re${'$'}move")
      public data class `Re$move`(
        public val id: String,
      ) : Input()
    }
  }
}

public val Blocks.api: Api
  get() = Api(client())
