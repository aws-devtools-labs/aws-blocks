package com.example.app

import kotlin.Double
import kotlinx.serialization.Serializable

@Serializable
public data class Point(
  public val x: Double,
  public val y: Double,
)
