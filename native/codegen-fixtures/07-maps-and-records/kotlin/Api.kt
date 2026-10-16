package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Double
import kotlin.String
import kotlin.collections.Map
import kotlin.collections.Set
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

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

    @Serializable(with = Input.OpenRecordSerializer::class)
    public data class Input(
      public val username: String,
      public val password: String,
      public val attributes: Map<String, String> = emptyMap(),
    ) {
      @Serializable
      private data class OpenRecordFields(
        public val username: String,
        public val password: String,
        public val attributes: Map<String, String> = emptyMap(),
      )

      /**
       * Writes [attributes] flat into the JSON object, beside the properties (the wire shape of
       * `additionalProperties`), and reads every key that isn't a property back into it.
       */
      internal object OpenRecordSerializer : KSerializer<Input> {
        private val fieldKeys: Set<String> = setOf("username", "password")

        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Input")

        override fun serialize(encoder: Encoder, `value`: Input) {
          val output = encoder as JsonEncoder
          val fields = output.json.encodeToJsonElement(Input.OpenRecordFields.serializer(), Input.OpenRecordFields(value.username, value.password, value.attributes)).jsonObject
          val flat = buildJsonObject {
            for ((key, element) in fields) if (key != "attributes") put(key, element)
            fields["attributes"]?.jsonObject?.forEach { (key, element) -> if (key !in fieldKeys) put(key, element) }
          }
          output.encodeJsonElement(flat)
        }

        override fun deserialize(decoder: Decoder): Input {
          val input = decoder as JsonDecoder
          val flat = input.decodeJsonElement().jsonObject
          val nested = buildJsonObject {
            for ((key, element) in flat) if (key in fieldKeys) put(key, element)
            put("attributes", buildJsonObject { for ((key, element) in flat) if (key !in fieldKeys) put(key, element) })
          }
          val fields = input.json.decodeFromJsonElement(Input.OpenRecordFields.serializer(), nested)
          return Input(fields.username, fields.password, fields.attributes)
        }
      }
    }
  }
}
