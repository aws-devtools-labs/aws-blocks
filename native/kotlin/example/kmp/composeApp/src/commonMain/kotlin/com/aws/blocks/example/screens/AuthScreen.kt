package com.aws.blocks.example.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import blocks.testapp.AuthState
import com.aws.blocks.kotlin.oidc.OidcAuthState
import com.aws.blocks.kotlin.oidc.OidcClient
import kotlinx.coroutines.launch

/**
 * Signs in through the backend's configured identity providers.
 *
 * The same code drives every target: Android opens Custom Tabs, iOS presents an
 * `ASWebAuthenticationSession`, and desktop opens the system browser and receives the
 * redirect on a loopback address.
 *
 * [client] is supplied by the caller, which owns it for the app's lifetime: it holds the
 * signed-in user in memory, so recreating it per screen would drop the session. [restoredState]
 * is the server's view of the session cookie, used until the client has a sign-in of its own.
 */
@Composable
fun AuthScreen(
    client: OidcClient?,
    loadError: String?,
    restoredState: AuthState?,
    modifier: Modifier = Modifier
) {
    var output by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
    ) {
        Text("Auth", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(16.dp))

        if (client == null) {
            Text(loadError?.let { "Error: $it" } ?: "Loading providers...")
        } else {
            val authState by client.authState.collectAsState()
            // Loading means the client has not signed in or out yet, so it has no opinion and
            // the restored session stands in. Signing in or out gives it one, and it wins.
            val username = when (val state = authState) {
                is OidcAuthState.SignedIn -> state.user.username
                OidcAuthState.SignedOut -> null
                OidcAuthState.Loading -> restoredState
                    ?.takeIf { it.state == AuthState.State.SignedIn }
                    ?.user
                    ?.username
            }

            if (username != null) {
                Text("Signed in as: $username")
                Spacer(Modifier.height(8.dp))
                Button(onClick = {
                    scope.launch {
                        runCatching { client.signOut() }
                            .onSuccess { output = "Signed out" }
                            .onFailure { output = "Error: ${it.message}" }
                    }
                }) { Text("Sign Out") }
            } else {
                client.providers.forEach { provider ->
                    Button(
                        onClick = {
                            scope.launch {
                                runCatching { client.signIn(provider) }
                                    .onSuccess { output = "Signed in as: ${it.username}" }
                                    .onFailure { output = "Error: ${it.message}" }
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("Sign in with $provider") }
                    Spacer(Modifier.height(8.dp))
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("Output:", style = MaterialTheme.typography.titleSmall)
        Text(output)
    }
}
