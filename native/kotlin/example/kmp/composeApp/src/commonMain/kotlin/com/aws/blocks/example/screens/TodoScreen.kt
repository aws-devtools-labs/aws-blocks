// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.example.screens

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
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
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
import blocks.testapp.Todo
import kotlinx.coroutines.launch

@Composable
fun TodoScreen(api: Api, modifier: Modifier = Modifier) {
    var title by remember { mutableStateOf("") }
    var priority by remember { mutableStateOf("") }
    var selectedSort by remember { mutableStateOf<ListTodos.SortBy?>(null) }
    var output by remember { mutableStateOf("") }
    var todos by remember { mutableStateOf<List<Todo>>(emptyList()) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
    ) {
        Text("Todos", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(16.dp))

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

        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                scope.launch {
                    runCatching {
                        api.createTodo(title, priority.toDoubleOrNull())
                    }.onSuccess {
                        output = "Created: ${it.title}"
                        title = ""
                        priority = ""
                    }.onFailure {
                        output = "Error: ${it.message}"
                    }
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text("Create Todo") }

        Spacer(Modifier.height(8.dp))
        Text("Sort by:", style = MaterialTheme.typography.bodyMedium)
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            RadioButton(selected = selectedSort == null, onClick = { selectedSort = null })
            Text("None")
            ListTodos.SortBy.entries.forEach { sort ->
                RadioButton(selected = selectedSort == sort, onClick = { selectedSort = sort })
                Text(sort.name.lowercase().replaceFirstChar { it.uppercase() })
            }
        }

        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                scope.launch {
                    runCatching {
                        api.listTodos(selectedSort)
                    }.onSuccess {
                        todos = it
                        output = "Got ${it.size} todos"
                    }.onFailure {
                        output = "Error: ${it.message}"
                    }
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text("List Todos") }

        Spacer(Modifier.height(16.dp))
        Text("Output:", style = MaterialTheme.typography.titleSmall)
        Text(output)

        Spacer(Modifier.height(8.dp))
        todos.forEach { todo ->
            Card(
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Checkbox(
                        checked = todo.completed,
                        onCheckedChange = { checked ->
                            scope.launch {
                                runCatching {
                                    api.updateTodo(todo.todoId, UpdateTodo.Updates(completed = checked))
                                }.onSuccess {
                                    output = "Updated: ${todo.title}"
                                }.onFailure {
                                    output = "Error: ${it.message}"
                                }
                            }
                        }
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(todo.title, style = MaterialTheme.typography.bodyLarge)
                        Text("Priority: ${todo.priority}", style = MaterialTheme.typography.bodySmall)
                    }
                    Button(
                        onClick = {
                            scope.launch {
                                runCatching {
                                    api.deleteTodo(todo.todoId)
                                }.onSuccess {
                                    output = "Deleted: ${todo.title}"
                                    todos = todos.filter { t -> t.todoId != todo.todoId }
                                }.onFailure {
                                    output = "Error: ${it.message}"
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error
                        )
                    ) { Text("Delete") }
                }
            }
        }
    }
}
