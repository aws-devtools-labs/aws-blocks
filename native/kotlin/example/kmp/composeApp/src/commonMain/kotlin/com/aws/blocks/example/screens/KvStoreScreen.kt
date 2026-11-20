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
fun KvStoreScreen(api: Api, modifier: Modifier = Modifier) {
    var key by remember { mutableStateOf("test-key") }
    var value by remember { mutableStateOf("test-value") }
    var output by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
    ) {
        Text("KV Store", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(16.dp))

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

        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = {
                    scope.launch {
                        runCatching { api.setValue(key, value) }
                            .onSuccess { output = "Set: $key = $value" }
                            .onFailure { output = "Error: ${it.message}" }
                    }
                },
                modifier = Modifier.weight(1f)
            ) { Text("Set Value") }
            Button(
                onClick = {
                    scope.launch {
                        runCatching { api.getValue(key) }
                            .onSuccess { output = "Got: $key = $it" }
                            .onFailure { output = "Error: ${it.message}" }
                    }
                },
                modifier = Modifier.weight(1f)
            ) { Text("Get Value") }
        }

        Spacer(Modifier.height(16.dp))
        Text("Output:", style = MaterialTheme.typography.titleSmall)
        Text(output)
    }
}
