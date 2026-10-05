package com.aws.blocks.example

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.example.screens.AuthScreen
import com.aws.blocks.example.screens.FileScreen
import com.aws.blocks.example.screens.KvStoreScreen
import com.aws.blocks.example.screens.RealtimeScreen
import com.aws.blocks.example.screens.TodoScreen
import com.aws.blocks.example.theme.AppTheme
import blocks.testapp.Api
import blocks.testapp.AuthApi
import blocks.testapp.AuthState

@Composable
fun App() {
    val auth = remember { AuthApi() }
    val api = remember { Api() }
    var selectedTab by remember { mutableStateOf(Tab.Auth) }

    // The client keeps sign-in state in memory, so it is owned here rather than by the Auth
    // tab: a per-tab client would be replaced on every visit, discarding the signed-in user.
    var oidcClient by remember { mutableStateOf<OidcClient?>(null) }
    var oidcError by remember { mutableStateOf<String?>(null) }

    // A client that has not signed in this launch reports no user, so the starting point comes
    // from the server, which verifies the session cookie and answers for earlier launches too.
    var restoredState by remember { mutableStateOf<AuthState?>(null) }

    LaunchedEffect(Unit) {
        // A failure here only means no session to restore, so the screen falls back to sign-in.
        runCatching { auth.getAuthState() }.onSuccess { restoredState = it }
        runCatching { auth.getClient() }
            .onSuccess { oidcClient = it }
            .onFailure { oidcError = it.message }
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
                Tab.Auth -> AuthScreen(oidcClient, oidcError, restoredState, modifier)
                Tab.Todos -> TodoScreen(api, modifier)
                Tab.KvStore -> KvStoreScreen(api, modifier)
                Tab.Realtime -> RealtimeScreen(api, modifier)
                Tab.Files -> FileScreen(api, modifier)
            }
        }
    }
}
