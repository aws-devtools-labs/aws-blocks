@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import kotlin.Double
import kotlin.OptIn
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * A string enum that keeps a value this client was generated without as [Unknown].
 */
@Serializable(with = Kind.Serializer::class)
public sealed class Kind {
  /**
   * The value as it is sent on the wire.
   */
  public abstract val `value`: String

  public data object X : Kind() {
    override val `value`: String = "x"
  }

  public data object Y : Kind() {
    override val `value`: String = "y"
  }

  /**
   * A value this client was generated without, as the server sent it.
   */
  public data class Unknown(
    override val `value`: String,
  ) : Kind()

  public companion object {
    /**
     * The known values, in the spec's order.
     */
    public val entries: List<Kind> by lazy { listOf(X, Y) }

    /**
     * The case for [value]: a known one, else [Unknown].
     */
    public fun fromValue(`value`: String): Kind = entries.firstOrNull { it.value == value } ?: Unknown(value)
  }

  public object Serializer : KSerializer<Kind> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("com.example.app.Kind", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, `value`: Kind) {
      encoder.encodeString(value.value)
    }

    override fun deserialize(decoder: Decoder): Kind = fromValue(decoder.decodeString())
  }
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
  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Status.Serializer::class)
  public sealed class Status {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Pending : Status() {
      override val `value`: String = "pending"
    }

    public data object Shipped : Status() {
      override val `value`: String = "shipped"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Status()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Status> by lazy { listOf(Pending, Shipped) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Status = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Status> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Status", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Status) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Status = fromValue(decoder.decodeString())
    }
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
  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Kind.Serializer::class)
  public sealed class Kind {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Bug : Kind() {
      override val `value`: String = "bug"
    }

    public data object Task : Kind() {
      override val `value`: String = "task"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Kind()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Kind> by lazy { listOf(Bug, Task) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Kind = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Kind> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Kind", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Kind) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Kind = fromValue(decoder.decodeString())
    }
  }

  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Kinds.Serializer::class)
  public sealed class Kinds {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Urgent : Kinds() {
      override val `value`: String = "urgent"
    }

    public data object Later : Kinds() {
      override val `value`: String = "later"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Kinds()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Kinds> by lazy { listOf(Urgent, Later) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Kinds = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Kinds> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Kinds", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Kinds) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Kinds = fromValue(decoder.decodeString())
    }
  }

  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Status.Serializer::class)
  public sealed class Status {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Open : Status() {
      override val `value`: String = "open"
    }

    public data object Closed : Status() {
      override val `value`: String = "closed"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Status()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Status> by lazy { listOf(Open, Closed) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Status = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Status> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Status", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Status) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Status = fromValue(decoder.decodeString())
    }
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
