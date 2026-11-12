package com.example.app

import kotlin.Boolean
import kotlin.Double
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * A widget *&#47; with &#47;* "double" and 'single' quotes, $x ${y} and \( paren
 * second line
 *
 * @property id Identifier *&#47; end &#47;* start "q" 'q' $id ${id} \(id)
 * next
 * @property code Code matching a pattern with "quotes" and $
 * @property kind Kind *&#47; of widget, $ values
 * @property note$ Optional note; key and default hold special characters
 */
@Serializable
public data class Widget(
  public val id: String,
  public val code: String,
  public val kind: Kind,
  public val `note$`: String? = "a/b é ${'$'}x ${'$'}{y} \"q\" 'q' \\ \\(z) */ end",
  public val count: Int? = 7,
  public val limit: Int? = null,
  public val ratio: Double? = 1.5,
  public val scale: Double? = 3.0,
  public val flag: Boolean? = true,
) {
  init {
    require(code.matches(Regex("^a'b\"c\\${'$'}d[${'$'}{x}]+${'$'}"))) { "code must match pattern ^a'b\"c\\\$d[\${x}]+$" }
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

    public data object `Cost$` : Kind() {
      override val `value`: String = "cost${'$'}"
    }

    public data object `A$b` : Kind() {
      override val `value`: String = "a${'$'}b"
    }

    public data object `X$$y` : Kind() {
      override val `value`: String = "x${'$'}${'$'}y"
    }

    public data object `B$c` : Kind() {
      override val `value`: String = "b-${'$'}c"
    }

    public data object `D$e` : Kind() {
      override val `value`: String = "d_${'$'}e"
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
      public val entries: List<Kind> by lazy { listOf(`Cost$`, `A$b`, `X$$y`, `B$c`, `D$e`) }

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
