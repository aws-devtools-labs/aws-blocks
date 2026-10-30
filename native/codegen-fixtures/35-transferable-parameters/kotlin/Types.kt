package com.example.app

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.filebucket.FileUploadHandle
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.Serializable

@Serializable
public data class Bundle(
  @Serializable(with = RealtimeChannelNoteSerializer::class)
  public val feed: RealtimeChannel<Note>,
  public val files:
      List<@Serializable(with = FileDownloadHandleSerializer::class) FileDownloadHandle>,
  @Serializable(with = FileUploadHandleSerializer::class)
  public val upload: FileUploadHandle? = null,
)

@Serializable
public data class Note(
  public val id: String,
  public val body: String,
)
