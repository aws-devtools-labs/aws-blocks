@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Boolean
import kotlin.Int
import kotlin.OptIn
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

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

      @Serializable
      @JsonClassDiscriminator("kind")
      public sealed class Event {
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
