package com.example.app

import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public enum class Status {
  @SerialName("todo")
  Todo,
  @SerialName("in-progress")
  InProgress,
  @SerialName("done")
  Done,
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
  @Serializable
  public enum class Labels {
    @SerialName("red")
    Red,
    @SerialName("green")
    Green,
  }

  @Serializable
  public enum class Priority {
    @SerialName("low")
    Low,
    @SerialName("high")
    High,
  }

  @Serializable
  public enum class Source {
    @SerialName("web")
    Web,
    @SerialName("unknown")
    Unknown,
  }
}
