package com.example.app

import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * A string enum that keeps a value this client was generated without as [Unknown].
 */
@Serializable(with = Color.Serializer::class)
public sealed class Color {
  /**
   * The value as it is sent on the wire.
   */
  public abstract val `value`: String

  public data object Red : Color() {
    override val `value`: String = "red"
  }

  public data object Blue : Color() {
    override val `value`: String = "blue"
  }

  /**
   * A value this client was generated without, as the server sent it.
   */
  public data class Unknown(
    override val `value`: String,
  ) : Color()

  public companion object {
    /**
     * The known values, in the spec's order.
     */
    public val entries: List<Color> by lazy { listOf(Red, Blue) }

    /**
     * The case for [value]: a known one, else [Unknown].
     */
    public fun fromValue(`value`: String): Color = entries.firstOrNull { it.value == value } ?: Unknown(value)
  }

  public object Serializer : KSerializer<Color> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("com.example.app.Color", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, `value`: Color) {
      encoder.encodeString(value.value)
    }

    override fun deserialize(decoder: Decoder): Color = fromValue(decoder.decodeString())
  }
}

@Serializable
public enum class Mode {
  @SerialName("auto")
  Auto,
  @SerialName("manual")
  Manual,
}

/**
 * A string enum that keeps a value this client was generated without as [Unknown].
 */
@Serializable(with = Size.Serializer::class)
public sealed class Size {
  /**
   * The value as it is sent on the wire.
   */
  public abstract val `value`: String

  public data object Small : Size() {
    override val `value`: String = "small"
  }

  public data object Large : Size() {
    override val `value`: String = "large"
  }

  /**
   * A value this client was generated without, as the server sent it.
   */
  public data class Unknown(
    override val `value`: String,
  ) : Size()

  public companion object {
    /**
     * The known values, in the spec's order.
     */
    public val entries: List<Size> by lazy { listOf(Small, Large) }

    /**
     * The case for [value]: a known one, else [Unknown].
     */
    public fun fromValue(`value`: String): Size = entries.firstOrNull { it.value == value } ?: Unknown(value)
  }

  public object Serializer : KSerializer<Size> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("com.example.app.Size", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, `value`: Size) {
      encoder.encodeString(value.value)
    }

    override fun deserialize(decoder: Decoder): Size = fromValue(decoder.decodeString())
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
public data class Node(
  public val kind: Kind,
  public val children: List<Node>,
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

    public data object Leaf : Kind() {
      override val `value`: String = "leaf"
    }

    public data object Branch : Kind() {
      override val `value`: String = "branch"
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
      public val entries: List<Kind> by lazy { listOf(Leaf, Branch) }

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
}

@Serializable
public data class Task(
  public val id: String,
  public val status: Status,
  public val history: List<Status>,
  public val labels: Map<String, Labels>,
  public val priority: Priority? = null,
  public val source: Source? = null,
  public val phase: Phase? = null,
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
  @Serializable(with = Phase.Serializer::class)
  public sealed class Phase {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Companion : Phase() {
      override val `value`: String = "companion"
    }

    public data object Other : Phase() {
      override val `value`: String = "other"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Phase()

    public companion object Known {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Phase> by lazy { listOf(Companion, Other) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Phase = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Phase> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Phase", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Phase) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Phase = fromValue(decoder.decodeString())
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
