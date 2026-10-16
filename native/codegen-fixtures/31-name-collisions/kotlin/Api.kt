@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Boolean
import kotlin.Double
import kotlin.OptIn
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun getCart(): Cart {
    val request = BlocksRequest(method = "api.getCart", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getOrder(): Order {
    val request = BlocksRequest(method = "api.getOrder", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getTicket(): Ticket {
    val request = BlocksRequest(method = "api.getTicket", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getKind(): Kind {
    val request = BlocksRequest(method = "api.getKind", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun putItems(item: PutItems.Item, items: List<PutItems.Items>): PutItems.Result {
    val request = BlocksRequest(method = "api.putItems", params = listOf(BlocksJson.encodeToJsonElement(item), buildJsonArray { items.forEach { add(BlocksJson.encodeToJsonElement(it)) } }), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getFeeds(): GetFeeds.Result {
    val request = BlocksRequest(method = "api.getFeeds", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun act(): Act.Result {
    val request = BlocksRequest(method = "api.act", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun check(result: Check.Result_2): Check.Result {
    val request = BlocksRequest(method = "api.check", params = listOf(BlocksJson.encodeToJsonElement(result)), id = BlocksRequest.nextId())
    val result_2 = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result_2)
  }

  public object PutItems {
    @Serializable
    public data class Result(
      public val item: Result.Item,
      public val items: List<Result.Items>,
    ) {
      @Serializable
      public data class Item(
        public val count: Double,
      )

      @Serializable
      public data class Items(
        public val sku: String,
      )
    }

    @Serializable
    public data class Item(
      public val sku: String,
    )

    @Serializable
    public data class Items(
      public val sku: String,
      public val qty: Double,
    )
  }

  public object GetFeeds {
    @Serializable
    public data class Result(
      @Serializable(with = RealtimeChannelApiGetFeedsResultFeedSerializer::class)
      public val feed: RealtimeChannel<Result.Feed>,
      public val feeds:
          List<@Serializable(with = RealtimeChannelApiGetFeedsResultFeedsSerializer::class) RealtimeChannel<Result.Feeds>>,
    ) {
      @Serializable
      public data class Feed(
        public val text: String,
      )

      @Serializable
      public data class Feeds(
        public val count: Double,
      )
    }
  }

  public object Act {
    @Serializable
    @JsonClassDiscriminator("action")
    public sealed class Result {
      @Serializable
      @SerialName("pick")
      public data class Pick(
        public val item: Pick.Item,
        public val items: List<Pick.Items>,
      ) : Result() {
        @Serializable
        public data class Item(
          public val sku: String,
        )

        @Serializable
        public data class Items(
          public val qty: Double,
        )
      }

      @Serializable
      @SerialName("skip")
      public data class Skip(
        public val reason: String,
      ) : Result()
    }
  }

  public object Check {
    @Serializable
    public data class Result(
      public val passed: Boolean,
    )

    @Serializable
    public data class Result_2(
      public val input: String,
    )
  }
}
