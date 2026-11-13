package com.example.app

import kotlin.Boolean
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * A type whose name and keys are not identifiers
 */
@Serializable
public data class SampleTypeX(
  public val `run { error("x") } || id`: String,
  public val `$`: String? = null,
  public val `${x}`: String? = null,
  @SerialName("\\(y)")
  public val y: String? = null,
  @SerialName("*/")
  public val unnamed: String? = null,
  public val `q"uote`: String? = null,
  public val `s'ingle`: String? = null,
  @SerialName("semi;colon")
  public val semiColon: String,
  @SerialName("back`tick")
  public val backTick: String? = null,
  @SerialName("new\nline")
  public val newLine: String? = null,
  public val `with space`: Int,
  public val `9lives`: Boolean? = null,
  public val kind: Kind? = null,
) {
  init {
    require(`run { error("x") } || id`.length >= 2) { "run { error(\"x\") } || id must be at least 2 characters" }
    require(semiColon.length <= 10) { "semi;colon must be at most 10 characters" }
    require(`with space` >= 1) { "with space must be >= 1" }
  }

  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Kind.Serializer::class)
  public sealed class Kind {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object AB : Kind() {
      override val `value`: String = "a\"b"
    }

    public data object CD : Kind() {
      override val `value`: String = "c;d"
    }

    public data object XY : Kind() {
      override val `value`: String = "x`y"
    }

    public data object NewLine : Kind() {
      override val `value`: String = "new\nline"
    }

    public data object X : Kind() {
      override val `value`: String = "${'$'}{x}"
    }

    public data object Z : Kind() {
      override val `value`: String = "\\(z)"
    }

    public data object Unnamed : Kind() {
      override val `value`: String = "*/"
    }

    public data object `1st` : Kind() {
      override val `value`: String = "1st"
    }

    public data object SpAce : Kind() {
      override val `value`: String = " sp ace"
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
      public val entries: List<Kind> by
          lazy { listOf(AB, CD, XY, NewLine, X, Z, Unnamed, `1st`, SpAce) }

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
