package com.example.app

import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
public data class Entry(
  public val payload: JsonElement,
  public val optionalPayload: JsonElement? = null,
  public val nullablePayload: JsonElement?,
  public val metadata: Map<String, JsonElement>,
  public val tags: List<JsonElement>,
  public val sparse: Map<String, JsonElement?>,
  public val claims: Map<String, JsonElement>? = null,
)
