package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksServer
import kotlin.Deprecated
import kotlin.DeprecationLevel
import kotlin.Nothing

public class LegacyAuth(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  @Deprecated(
    message = "OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.",
    level = DeprecationLevel.ERROR,
  )
  public suspend fun getClient(): Nothing = throw NotImplementedError("OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block to enable this method.")
}
