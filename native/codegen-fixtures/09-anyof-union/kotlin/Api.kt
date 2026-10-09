package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.IllegalArgumentException
import kotlin.Int
import kotlin.String
import kotlin.Throwable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

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

    @Serializable(with = Query.QuerySerializer::class)
    public sealed class Query {
      /**
       * Reads and writes [Query] as the bare JSON value of its variant. It has no discriminator, so a
       * value decodes to the first variant, in spec order, whose JSON shape it has.
       */
      public object QuerySerializer : KSerializer<Query> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Query")

        override fun serialize(encoder: Encoder, `value`: Query) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Query can only be written as JSON")
          val element = when (value) {
            is Variant1 -> output.json.encodeToJsonElement<String>(value.value)
            is Variant2 -> output.json.encodeToJsonElement(Variant2.serializer(), value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Query {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Query can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonPrimitive && element.isString) {
            try {
              return Variant1(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject && "text" in element) {
            try {
              return input.json.decodeFromJsonElement(Variant2.serializer(), element)
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Query matches this JSON value; expected a string; or an object with \"text\"", failure)
        }
      }

      public data class Variant1(
        public val `value`: String,
      ) : Query()

      @Serializable
      public data class Variant2(
        public val text: String,
        public val fuzzy: Boolean? = null,
      ) : Query()
    }
  }
}
