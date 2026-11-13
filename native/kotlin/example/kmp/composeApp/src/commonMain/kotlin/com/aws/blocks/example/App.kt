package com.aws.blocks.example

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksConfig
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.example.screens.AuthScreen
import com.aws.blocks.example.screens.FileScreen
import com.aws.blocks.example.screens.KvStoreScreen
import com.aws.blocks.example.screens.RealtimeScreen
import com.aws.blocks.example.screens.TodoScreen
import com.aws.blocks.example.theme.AppTheme
import blocks.testapp.defaultServer
import blocks.testapp.api

/** Provider ids from the backend's `providers` (`aws-blocks/index.ts`). */
private val providers = listOf("google")

/**
 * Where the backend relays the sign-in result. It must match `oidc { relayTo }` in
 * `composeApp/build.gradle.kts` and the backend's `redirects.allowedRelayOrigins`.
 */
private const val RELAY_TO = "blocks.testapp://oidcRedirect"

@Composable
fun App() {
    // Every RPC call below runs on the HTTP client this owns. The application id is what gives the
    // desktop target somewhere to keep the session: without it the JVM holds cookies in memory and
    // a restart signs the user out. It is remembered because the DisposableEffect closes the engine
    // it owns, and `api` because the screens take it as a parameter and a new instance on each
    // recomposition would defeat skipping.
    val blocks = remember {
        Blocks(BlocksConfig(server = Blocks.defaultServer, applicationId = "com.aws.blocks.example.kmp"))
    }
    val api = remember { blocks.api }
    DisposableEffect(blocks) {
        onDispose { blocks.close() }
    }
    var selectedTab by remember { mutableStateOf(Tab.Auth) }

    // The client keeps sign-in state in memory, so it is owned here rather than by the Auth
    // tab: a per-tab client would be replaced on every visit, discarding the signed-in user.
    // The `Auth` block serves its sign-in routes at fixed paths, so the client is built locally.
    val oidcClient = remember { OidcClient.forAuth(blocks.client(), providers, RELAY_TO) }

    // The client starts out Loading. restore() asks the server, which verifies the session
    // cookie and answers for earlier launches too, and settles the client's authState.
    LaunchedEffect(Unit) {
        // A failure here leaves the client Loading, so the screen falls back to sign-in.
        runCatching { oidcClient.restore() }
    }

    AppTheme {
        Scaffold(
            bottomBar = {
                NavigationBar {
                    Tab.entries.forEach { tab ->
                        NavigationBarItem(
                            selected = selectedTab == tab,
                            onClick = { selectedTab = tab },
                            label = { Text(tab.label) },
                            icon = {}
                        )
                    }
                }
            }
        ) { innerPadding ->
            val modifier = Modifier.padding(innerPadding)
            when (selectedTab) {
                Tab.Auth -> AuthScreen(oidcClient, modifier)
                Tab.Todos -> TodoScreen(api, modifier)
                Tab.KvStore -> KvStoreScreen(api, modifier)
                Tab.Realtime -> RealtimeScreen(api, modifier)
                Tab.Files -> FileScreen(api, modifier)
            }
        }
    }
}
