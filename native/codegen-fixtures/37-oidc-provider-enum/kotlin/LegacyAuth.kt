package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import kotlin.Deprecated
import kotlin.DeprecationLevel
import kotlin.Nothing

public class LegacyAuth(
  private val client: BlocksClient,
) {
  @Deprecated(
    message = "OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.",
    level = DeprecationLevel.ERROR,
  )
  public suspend fun getClient(): Nothing = throw NotImplementedError("OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.")
}

public val Blocks.legacyAuth: LegacyAuth
  get() = LegacyAuth(client())
