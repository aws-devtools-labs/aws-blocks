package com.example.app

import kotlin.Boolean
import kotlin.Int
import kotlin.String
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A type whose name and keys are not identifiers
 */
@Serializable
public data class Sample_Type__x___(
  @SerialName("run { error(\"x\") } || id")
  public val run___error__x________id: String,
  @SerialName("${'$'}")
  public val __unnamed: String? = null,
  @SerialName("${'$'}{x}")
  public val __x_: String? = null,
  @SerialName("\\(y)")
  public val __y_: String? = null,
  @SerialName("*/")
  public val ___unnamed: String? = null,
  @SerialName("q\"uote")
  public val q_uote: String? = null,
  @SerialName("s'ingle")
  public val s_ingle: String? = null,
  @SerialName("semi;colon")
  public val semi_colon: String,
  @SerialName("back`tick")
  public val back_tick: String? = null,
  @SerialName("new\nline")
  public val new_line: String? = null,
  @SerialName("with space")
  public val with_space: Int,
  @SerialName("9lives")
  public val _9lives: Boolean? = null,
  public val kind: Kind? = null,
) {
  init {
    require(run___error__x________id.length >= 2) { "run { error(\"x\") } || id must be at least 2 characters" }
    require(semi_colon.length <= 10) { "semi;colon must be at most 10 characters" }
    require(with_space >= 1) { "with space must be >= 1" }
  }

  @Serializable
  public enum class Kind {
    @SerialName("a\"b")
    AB,
    @SerialName("c;d")
    CD,
    @SerialName("x`y")
    XY,
    @SerialName("new\nline")
    NewLine,
    @SerialName("${'$'}{x}")
    X,
    @SerialName("\\(z)")
    Z,
    @SerialName("*/")
    Unnamed,
    @SerialName("1st")
    _1st,
    @SerialName(" sp ace")
    SpAce,
  }
}
