package com.example.app

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.Contextual
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public enum class Level {
  @SerialName("low")
  Low,
  @SerialName("high")
  High,
}

@Serializable
public data class Board(
  public val title: String,
  public val channels:
      List<@Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>,
  public val tagFeeds:
      List<@Serializable(with = RealtimeChannelListStringSerializer::class) RealtimeChannel<List<String>>>? = null,
  public val feedsByRoom:
      Map<String, @Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>,
  public val downloads:
      List<@Serializable(with = FileDownloadHandleSerializer::class) FileDownloadHandle>,
  public val layout: Layout,
)

@Serializable
public data class Layout(
  public val tagsByUser: Map<String, List<String>>,
  public val scoresByUser: Map<String, List<Int>>? = null,
  public val notesByTag: Map<String, List<Note>>,
  public val pages: List<Map<String, Note>>,
  public val grid: List<List<Note>>,
  public val matrix: List<List<Int>>,
  public val levels: List<Level>,
  public val levelsByUser: Map<String, List<Level>>? = null,
  public val nestedLevels: Map<String, Map<String, Level>>,
  public val maybeNotes: List<Note?>,
)

@Serializable
public data class LoginMenu(
  public val primary: SignInOption,
  public val options: List<SignInOption>,
  @Contextual
  public val fallback: OidcClient? = null,
)

@Serializable
public data class Note(
  public val id: String,
  public val body: String,
)

@Serializable
public data class SignInOption(
  public val label: String,
  @Contextual
  public val client: OidcClient,
)
