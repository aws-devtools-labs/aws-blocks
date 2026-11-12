package com.example.app

import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * A string enum that keeps a value this client was generated without as [Unknown].
 */
@Serializable(with = Status.Serializer::class)
public sealed class Status {
  /**
   * The value as it is sent on the wire.
   */
  public abstract val `value`: String

  public data object Todo : Status() {
    override val `value`: String = "todo"
  }

  public data object InProgress : Status() {
    override val `value`: String = "in-progress"
  }

  public data object Done : Status() {
    override val `value`: String = "done"
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
    public val entries: List<Status> by lazy { listOf(Todo, InProgress, Done) }

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
public data class Task(
  public val id: String,
  public val status: Status,
  public val history: List<Status>,
  public val labels: Map<String, Labels>,
  public val priority: Priority? = null,
  public val source: Source? = null,
) {
  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Labels.Serializer::class)
  public sealed class Labels {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Red : Labels() {
      override val `value`: String = "red"
    }

    public data object Green : Labels() {
      override val `value`: String = "green"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Labels()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Labels> by lazy { listOf(Red, Green) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Labels = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Labels> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Labels", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Labels) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Labels = fromValue(decoder.decodeString())
    }
  }

  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Priority.Serializer::class)
  public sealed class Priority {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Low : Priority() {
      override val `value`: String = "low"
    }

    public data object High : Priority() {
      override val `value`: String = "high"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Priority()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Priority> by lazy { listOf(Low, High) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Priority = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Priority> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Priority", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Priority) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Priority = fromValue(decoder.decodeString())
    }
  }

  /**
   * A string enum that keeps a value this client was generated without as [UnknownValue].
   */
  @Serializable(with = Source.Serializer::class)
  public sealed class Source {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Web : Source() {
      override val `value`: String = "web"
    }

    public data object Unknown : Source() {
      override val `value`: String = "unknown"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class UnknownValue(
      override val `value`: String,
    ) : Source()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Source> by lazy { listOf(Web, Unknown) }

      /**
       * The case for [value]: a known one, else [UnknownValue].
       */
      public fun fromValue(`value`: String): Source = entries.firstOrNull { it.value == value } ?: UnknownValue(value)
    }

    public object Serializer : KSerializer<Source> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Source", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Source) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Source = fromValue(decoder.decodeString())
    }
  }
}
