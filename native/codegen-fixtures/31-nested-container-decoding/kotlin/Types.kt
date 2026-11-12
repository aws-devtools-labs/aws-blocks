package com.example.app

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.oidc.AnyProvider
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.Contextual
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

/**
 * A string enum that keeps a value this client was generated without as [Unknown].
 */
@Serializable(with = Level.Serializer::class)
public sealed class Level {
  /**
   * The value as it is sent on the wire.
   */
  public abstract val `value`: String

  public data object Low : Level() {
    override val `value`: String = "low"
  }

  public data object High : Level() {
    override val `value`: String = "high"
  }

  /**
   * A value this client was generated without, as the server sent it.
   */
  public data class Unknown(
    override val `value`: String,
  ) : Level()

  public companion object {
    /**
     * The known values, in the spec's order.
     */
    public val entries: List<Level> by lazy { listOf(Low, High) }

    /**
     * The case for [value]: a known one, else [Unknown].
     */
    public fun fromValue(`value`: String): Level = entries.firstOrNull { it.value == value } ?: Unknown(value)
  }

  public object Serializer : KSerializer<Level> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("com.example.app.Level", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, `value`: Level) {
      encoder.encodeString(value.value)
    }

    override fun deserialize(decoder: Decoder): Level = fromValue(decoder.decodeString())
  }
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
  public val fallback: OidcClient<AnyProvider>? = null,
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
  public val client: OidcClient<AnyProvider>,
)
