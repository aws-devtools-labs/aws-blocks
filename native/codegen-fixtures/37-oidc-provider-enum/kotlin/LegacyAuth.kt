package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.oidc.AnyProvider
import com.aws.blocks.kotlin.oidc.OidcClient

public class LegacyAuth(
  private val client: BlocksClient,
) {
  public suspend fun getClient(): OidcClient<AnyProvider> {
    val request = BlocksRequest(method = "legacyAuth.getClient", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return OidcClient.fromJson(result, client, "blocks-fixture://auth")
  }
}

public val Blocks.legacyAuth: LegacyAuth
  get() = LegacyAuth(client())
