@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.OptIn
import kotlin.String
import kotlin.collections.Map
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun updateAttributes(attributes: Map<String, String>): Map<String, UpdateAttributes.Result?> {
    val request = BlocksRequest(method = "api.updateAttributes", params = listOf(buildJsonObject { attributes.forEach { put(it.key, it.value) } }), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getNotification(id: String): GetNotification.Result? {
    val request = BlocksRequest(method = "api.getNotification", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object UpdateAttributes {
    @Serializable(with = Result.ResultSerializer::class)
    public sealed class Result {
      /**
       * Reads and writes [Result] with its discriminator `isUpdated` as the JSON value
       * the spec gives it.
       */
      public object ResultSerializer : KSerializer<Result> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Result")

        override fun serialize(encoder: Encoder, `value`: Result) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Result can only be written as JSON")
          val element = when (value) {
            is IsUpdatedTrue -> buildJsonObject {
              put("isUpdated", JsonPrimitive(true))
            }
            is IsUpdatedFalse -> buildJsonObject {
              put("isUpdated", JsonPrimitive(false))
              output.json.encodeToJsonElement(IsUpdatedFalse.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          if (element is JsonObject) {
            val fields = JsonObject(element - "isUpdated")
            when (element["isUpdated"]) {
              JsonPrimitive(true) -> return IsUpdatedTrue
              JsonPrimitive(false) -> return input.json.decodeFromJsonElement(IsUpdatedFalse.serializer(), fields)
              else -> {}
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected an object with \"isUpdated\": true; or an object with \"isUpdated\": false")
        }
      }

      @Serializable
      @SerialName("true")
      public data object IsUpdatedTrue : Result()

      @Serializable
      @SerialName("false")
      public data class IsUpdatedFalse(
        public val nextStep: IsUpdatedFalse.NextStep,
      ) : Result() {
        @Serializable
        public data class NextStep(
          public val name: String,
          public val destination: String,
        )
      }
    }
  }

  public object GetNotification {
    @Serializable
    @JsonClassDiscriminator("type")
    public sealed class Result {
      @Serializable
      @SerialName("email")
      public data class Email(
        public val subject: String,
        public val body: String,
      ) : Result()

      @Serializable
      @SerialName("sms")
      public data class Sms(
        public val message: String,
      ) : Result()
    }
  }
}
