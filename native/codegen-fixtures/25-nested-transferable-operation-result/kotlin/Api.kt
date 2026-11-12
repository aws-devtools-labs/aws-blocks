@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Boolean
import kotlin.Int
import kotlin.OptIn
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getSession(): GetSession.Result {
    val request = BlocksRequest(method = "api.getSession", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getOtherSession(): GetOtherSession.Result {
    val request = BlocksRequest(method = "api.getOtherSession", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetSession {
    @Serializable
    public data class Result(
      public val sessionId: String,
      @Serializable(with = RealtimeChannelApiGetSessionResultChannelSerializer::class)
      public val channel: RealtimeChannel<Result.Channel>,
      public val `inner`: Result.Inner,
      public val event: Result.Event,
      @Serializable(with = RealtimeChannelListStringSerializer::class)
      public val stringValues: RealtimeChannel<List<String>>,
      @Serializable(with = RealtimeChannelListIntSerializer::class)
      public val integerValues: RealtimeChannel<List<Int>>,
    ) {
      @Serializable
      public data class Channel(
        public val text: String,
      )

      @Serializable
      public data class Inner(
        @Serializable(with = RealtimeChannelApiGetSessionResultInnerChannelSerializer::class)
        public val channel: RealtimeChannel<Inner.Channel>,
      ) {
        @Serializable
        public data class Channel(
          public val count: Int,
        )
      }

      @Serializable(with = Event.EventSerializer::class)
      public sealed class Event {
        /**
         * Reads and writes [Event] with its discriminator `kind` as the JSON value
         * the spec gives it.
         */
        public object EventSerializer : KSerializer<Event> {
          override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Event")

          override fun serialize(encoder: Encoder, `value`: Event) {
            val output = encoder as? JsonEncoder ?: throw SerializationException("Event can only be written as JSON")
            val element = when (value) {
              is Message -> buildJsonObject {
                put("kind", JsonPrimitive("message"))
                output.json.encodeToJsonElement(Message.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
              }
              is Presence -> buildJsonObject {
                put("kind", JsonPrimitive("presence"))
                output.json.encodeToJsonElement(Presence.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
              }
              is Unknown -> value.json
            }
            output.encodeJsonElement(element)
          }

          override fun deserialize(decoder: Decoder): Event {
            val input = decoder as? JsonDecoder ?: throw SerializationException("Event can only be read from JSON")
            val element = input.decodeJsonElement()
            if (element is JsonObject) {
              val fields = JsonObject(element - "kind")
              when (element["kind"]) {
                JsonPrimitive("message") -> return input.json.decodeFromJsonElement(Message.serializer(), fields)
                JsonPrimitive("presence") -> return input.json.decodeFromJsonElement(Presence.serializer(), fields)
                else -> return Unknown(element)
              }
            }
            throw SerializationException("No variant of Event matches this JSON value; expected an object with \"kind\": \"message\"; or an object with \"kind\": \"presence\"")
          }
        }

        /**
         * An arm this client was generated without: the object as the server sent it.
         */
        public data class Unknown(
          public val json: JsonObject,
        ) : Event()

        @Serializable
        @SerialName("message")
        public data class Message(
          @Serializable(with = RealtimeChannelApiGetSessionResultEventMessageChannelSerializer::class)
          public val channel: RealtimeChannel<Message.Channel>,
        ) : Event() {
          @Serializable
          public data class Channel(
            public val body: String,
          )
        }

        @Serializable
        @SerialName("presence")
        public data class Presence(
          @Serializable(with = RealtimeChannelApiGetSessionResultEventPresenceChannelSerializer::class)
          public val channel: RealtimeChannel<Presence.Channel>,
        ) : Event() {
          @Serializable
          public data class Channel(
            public val online: Boolean,
          )
        }
      }
    }
  }

  public object GetOtherSession {
    @Serializable
    public data class Result(
      @Serializable(with = RealtimeChannelApiGetOtherSessionResultChannelSerializer::class)
      public val channel: RealtimeChannel<Result.Channel>,
    ) {
      @Serializable
      public data class Channel(
        public val count: Int,
      )
    }
  }
}

public val Blocks.api: Api
  get() = Api(client())
