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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import blocks.testapp.Api
import kotlinx.coroutines.launch

@Composable
fun FileScreen(api: Api, modifier: Modifier = Modifier) {
    var path by remember { mutableStateOf("test/hello.txt") }
    var content by remember { mutableStateOf("Hello from KMP!") }
    var output by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
    ) {
        Text("File Storage", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(16.dp))

        TextField(
            value = path,
            onValueChange = { path = it },
            label = { Text("File Path") },
            modifier = Modifier.fillMaxWidth()
        )
        TextField(
            value = content,
            onValueChange = { content = it },
            label = { Text("Content to upload") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 3
        )

        Spacer(Modifier.height(8.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = {
                    if (path.isBlank()) {
                        output = "Error: Enter a file path"
                        return@Button
                    }
                    scope.launch {
                        output = "Uploading..."
                        runCatching {
                            val bytes = content.encodeToByteArray()
                            val handle = api.getUploadUrl(path, "text/plain")
                            handle.upload(bytes)
                            "Uploaded ${bytes.size} bytes to $path"
                        }.onSuccess { output = it }
                            .onFailure { output = "Error: ${it.message}" }
                    }
                },
                modifier = Modifier.weight(1f)
            ) { Text("Upload") }
            Button(
                onClick = {
                    if (path.isBlank()) {
                        output = "Error: Enter a file path"
                        return@Button
                    }
                    scope.launch {
                        output = "Downloading..."
                        runCatching {
                            val handle = api.getDownloadUrl(path)
                            val bytes = handle.download()
                            val lower = path.lowercase()
                            when {
                                lower.endsWith(".txt") || lower.endsWith(".json") ||
                                lower.endsWith(".md") || lower.endsWith(".csv") ->
                                    "Content:\n${bytes.decodeToString()}"
                                else -> "Downloaded ${bytes.size} bytes"
                            }
                        }.onSuccess { output = it }
                            .onFailure { output = "Error: ${it.message}" }
                    }
                },
                modifier = Modifier.weight(1f)
            ) { Text("Download") }
        }

        Spacer(Modifier.height(16.dp))
        Text("Output:", style = MaterialTheme.typography.titleSmall)
        Text(output)
    }
}
