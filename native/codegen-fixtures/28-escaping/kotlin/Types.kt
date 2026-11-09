package com.example.app

import kotlin.Boolean
import kotlin.Double
import kotlin.Int
import kotlin.String
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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

  @Serializable
  public enum class Kind {
    @SerialName("cost${'$'}")
    `Cost$`,
    @SerialName("a${'$'}b")
    `A$b`,
    @SerialName("x${'$'}${'$'}y")
    `X$$y`,
    @SerialName("b-${'$'}c")
    `B$c`,
    @SerialName("d_${'$'}e")
    `D$e`,
  }
}
