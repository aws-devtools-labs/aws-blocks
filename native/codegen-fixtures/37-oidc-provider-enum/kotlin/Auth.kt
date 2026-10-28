package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.oidc.OidcProvider
import kotlin.String

public class Auth(
  private val client: BlocksClient,
) {
  public suspend fun getClient(): OidcClient<GetClient.Provider> {
    val request = BlocksRequest(method = "auth.getClient", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return OidcClient.fromJson(result, client, "blocks-fixture://auth")
  }

  public object GetClient {
    public enum class Provider(
      override val providerName: String,
    ) : OidcProvider {
      Google("google"),
      Github("github"),
      MySso("my-sso"),
      LoginGov("login.gov"),
      ;
    }
  }
}

public val Blocks.auth: Auth
  get() = Auth(client())
