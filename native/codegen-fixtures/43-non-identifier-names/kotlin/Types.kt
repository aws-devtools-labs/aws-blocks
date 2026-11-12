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
    `1st`,
    @SerialName(" sp ace")
    SpAce,
  }
}
