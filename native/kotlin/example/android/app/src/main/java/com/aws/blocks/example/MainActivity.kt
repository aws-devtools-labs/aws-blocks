package com.aws.blocks.example

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import blocks.testapp.Api
import blocks.testapp.Api.ListTodos
import blocks.testapp.Api.UpdateTodo
import blocks.testapp.AuthApi
import blocks.testapp.AuthState
import blocks.testapp.Todo
import com.aws.blocks.kotlin.oidc.OidcAuthState
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.example.ui.theme.BlocksKotlinExampleTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    val auth = AuthApi()
    val api = Api()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            BlocksKotlinExampleTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
                    Column(
                        modifier = Modifier
                            .padding(innerPadding)
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState())
                    ) {
                        OidcAuth(auth = auth)
                        Spacer(modifier = Modifier.height(16.dp))
                        CursorTracker(api = api)
                        Spacer(modifier = Modifier.height(16.dp))
                        TodoSection(api = api)
                        Spacer(modifier = Modifier.height(16.dp))
                        CookieStore(api = api)
                        Spacer(modifier = Modifier.height(16.dp))
                        KvStore(api = api)
                        Spacer(modifier = Modifier.height(16.dp))
                        FileTransferSection(api = api)
                    }
                }
            }
        }
    }
}

@Composable
fun OidcAuth(auth: AuthApi) {
    var oidcClient by remember { mutableStateOf<OidcClient?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    // A client that has not signed in this launch reports no user, so the starting point comes
    // from the server, which verifies the session cookie and answers for earlier launches too.
    var restoredState by remember { mutableStateOf<AuthState?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        // A failure here only means no session to restore, so the screen falls back to sign-in.
        runCatching { auth.getAuthState() }.onSuccess { restoredState = it }
        oidcClient = runCatching { auth.getClient() }.getOrElse {
            error = it.message
            null
        }
    }

    val client = oidcClient
    if (client == null) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(text = "Auth", style = MaterialTheme.typography.headlineMedium)
            Text(text = error ?: "Loading...")
        }
        return
    }

    val authState by client.authState.collectAsState()

    Column(modifier = Modifier.padding(16.dp)) {
        Text(text = "Auth", style = MaterialTheme.typography.headlineMedium)

        // Loading means the client has not signed in or out yet, so it has no opinion and the
        // restored session stands in. Signing in or out gives it one, and it wins.
        val username = when (val state = authState) {
            is OidcAuthState.SignedIn -> state.user.username
            OidcAuthState.SignedOut -> null
            OidcAuthState.Loading -> restoredState
                ?.takeIf { it.state == AuthState.State.SignedIn }
                ?.user
                ?.username
        }

        if (username != null) {
            Text(text = "Signed in as: $username")
            Button(onClick = {
                scope.launch {
                    error = runCatching { client.signOut() }.exceptionOrNull()?.message
                }
            }) {
                Text("Sign Out")
            }
        } else {
            client.providers.forEach { provider ->
                Button(
                    onClick = {
                        scope.launch {
                            error = runCatching { client.signIn(provider) }.exceptionOrNull()?.message
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Sign in with $provider")
                }
                Spacer(modifier = Modifier.height(8.dp))
            }
        }

        if (error != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(text = "Error: $error", color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
fun KvStore(api: Api) {
    var key by remember { mutableStateOf("test-key") }
    var value by remember { mutableStateOf("test-value") }
    var response by remember { mutableStateOf(Result.success("")) }
    val scope = rememberCoroutineScope()

    Column(modifier = Modifier.padding(16.dp)) {
        Text(text = "KV Store", style = MaterialTheme.typography.headlineMedium)
        TextField(
            value = key,
            onValueChange = { key = it },
            label = { Text("Key") },
            modifier = Modifier.fillMaxWidth()
        )
        TextField(
            value = value,
            onValueChange = { value = it },
            label = { Text("Value") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = { scope.launch { response = runCatching { api.setValue(key, value).toString() } } },
                modifier = Modifier.weight(1f)
            ) {
                Text("Set Value")
            }
            Button(
                onClick = { scope.launch { response = runCatching { api.getValue(key).toString() } } },
                modifier = Modifier.weight(1f)
            ) {
                Text("Get Value")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))
        Text(text = "KV Output:")
        Text(text = response.responseValue())
    }
}

@Composable
fun CookieStore(api: Api) {
    var name by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    var response by remember { mutableStateOf(Result.success("")) }
    val scope = rememberCoroutineScope()

    Column(modifier = Modifier.padding(16.dp)) {
        Text(text = "Cookies", style = MaterialTheme.typography.headlineMedium)
        TextField(
            value = name,
            onValueChange = { name = it },
            label = { Text("Cookie Name") },
            modifier = Modifier.fillMaxWidth()
        )
        TextField(
            value = value,
            onValueChange = { value = it },
            label = { Text("Cookie Value") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = { scope.launch { response = runCatching { api.setCookie(name, value).toString() } } },
                modifier = Modifier.weight(1f)
            ) {
                Text("Set")
            }
            Button(
                onClick = { scope.launch { response = runCatching { api.getCookie(name) ?: "no cookie found" } } },
                modifier = Modifier.weight(1f)
            ) {
                Text("Get")
            }
            Button(
                onClick = { scope.launch { response = runCatching { api.deleteCookie(name).toString() } } },
                modifier = Modifier.weight(1f)
            ) {
                Text("Delete")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))
        Text(text = "Cookie Output:")
        Text(text = response.responseValue())
    }
}

@Composable
fun TodoSection(api: Api) {
    var title by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf("") }
    var selectedSort by remember { mutableStateOf<ListTodos.SortBy?>(null) }
    var response by remember { mutableStateOf(Result.success("")) }
    var todos by remember { mutableStateOf<List<Todo>>(emptyList()) }
    val scope = rememberCoroutineScope()

    Column(modifier = Modifier.padding(16.dp)) {
        Text(text = "Todos", style = MaterialTheme.typography.headlineMedium)
        TextField(
            value = title,
            onValueChange = { title = it },
            label = { Text("Title") },
            modifier = Modifier.fillMaxWidth()
        )
        TextField(
            value = priority,
            onValueChange = { priority = it },
            label = { Text("Priority (optional)") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))
        Button(
            onClick = {
                scope.launch {
                    response = runCatching {
                        api.createTodo(title, priority.toDoubleOrNull()).toString().also {
                            title = ""
                            priority = ""
                        }
                    }
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Create Todo")
        }

        Spacer(modifier = Modifier.height(8.dp))
        Text(text = "Sort by:", style = MaterialTheme.typography.bodyMedium)
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            RadioButton(
                selected = selectedSort == null,
                onClick = { selectedSort = null }
            )
            Text("None")
            ListTodos.SortBy.entries.forEach { sort ->
                RadioButton(
                    selected = selectedSort == sort,
                    onClick = { selectedSort = sort }
                )
                Text(sort.name.lowercase().replaceFirstChar { it.uppercase() })
            }
        }

        Spacer(modifier = Modifier.height(8.dp))
        Button(
            onClick = {
                scope.launch {
                    response = runCatching {
                        todos = api.listTodos(selectedSort)
                        "got ${todos.size} todos"
                    }
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("List Todos")
        }

        Spacer(modifier = Modifier.height(16.dp))
        Text(text = "Todo Output:")
        Text(text = response.responseValue())

        Spacer(modifier = Modifier.height(8.dp))
        todos.forEach { todo ->
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Checkbox(
                        checked = todo.completed,
                        onCheckedChange = { checked ->
                            scope.launch {
                                response = runCatching {
                                    val updates = UpdateTodo.Updates(completed = checked)
                                    api.updateTodo(todo.todoId, updates).toString()
                                }
                            }
                        }
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(text = todo.title, style = MaterialTheme.typography.bodyLarge)
                        Text(
                            text = "Priority: ${todo.priority}",
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                    Button(
                        onClick = {
                            scope.launch {
                                response = runCatching { api.deleteTodo(todo.todoId).toString() }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error
                        )
                    ) {
                        Text("Delete")
                    }
                }
            }
        }
    }
}

private fun Result<*>.responseValue(): String = when {
    this.isSuccess -> this.getOrThrow().toString()
    else -> "Error: ${this.exceptionOrNull()?.message}"
}
