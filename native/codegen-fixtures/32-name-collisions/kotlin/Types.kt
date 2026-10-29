@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import kotlin.Double
import kotlin.OptIn
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

@Serializable
public enum class Kind {
  @SerialName("x")
  X,
  @SerialName("y")
  Y,
}

@Serializable
public data class Cart(
  public val id: String,
  public val item: Item,
  public val items: List<Items>,
  public val tags: Map<String, Tags>,
  public val tagsValue: TagsValue,
) {
  @Serializable
  public data class Item(
    public val sku: String,
  )

  @Serializable
  public data class Items(
    public val sku: String,
    public val qty: Double,
  )

  @Serializable
  public data class Tags(
    public val label: String,
  )

  @Serializable
  public data class TagsValue(
    public val weight: Double,
  )
}

@Serializable
public data class Order(
  public val status: Status,
) {
  @Serializable
  public enum class Status {
    @SerialName("pending")
    Pending,
    @SerialName("shipped")
    Shipped,
  }
}

@Serializable
public data class Ticket(
  public val status: Status,
  public val kind: Kind,
  public val kinds: List<Kinds>,
  public val payload: Payload,
  public val payloads: List<Payloads>,
) {
  @Serializable
  public enum class Kind {
    @SerialName("bug")
    Bug,
    @SerialName("task")
    Task,
  }

  @Serializable
  public enum class Kinds {
    @SerialName("urgent")
    Urgent,
    @SerialName("later")
    Later,
  }

  @Serializable
  public enum class Status {
    @SerialName("open")
    Open,
    @SerialName("closed")
    Closed,
  }

  @Serializable
  @JsonClassDiscriminator("type")
  public sealed class Payload {
    @Serializable
    @SerialName("text")
    public data class Text(
      public val body: String,
    ) : Payload()

    @Serializable
    @SerialName("count")
    public data class Count(
      public val total: Double,
    ) : Payload()
  }

  @Serializable
  @JsonClassDiscriminator("format")
  public sealed class Payloads {
    @Serializable
    @SerialName("plain")
    public data class Plain(
      public val raw: String,
    ) : Payloads()

    @Serializable
    @SerialName("rich")
    public data class Rich(
      public val html: String,
    ) : Payloads()
  }
}
