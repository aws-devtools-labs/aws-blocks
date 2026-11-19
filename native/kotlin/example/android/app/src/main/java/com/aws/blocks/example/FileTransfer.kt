// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.example

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import blocks.testapp.Api
import kotlinx.coroutines.launch

private sealed class DownloadedContent {
    data class ImageContent(val bytes: ByteArray) : DownloadedContent()
    data class TextContent(val text: String) : DownloadedContent()
    data class Binary(val size: Int) : DownloadedContent()
}

@Composable
fun FileTransferSection(api: Api) {
    var path by remember { mutableStateOf("test/hello.txt") }
    var status by remember { mutableStateOf("") }
    var downloadedContent by remember { mutableStateOf<DownloadedContent?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var selectedFileUri by remember { mutableStateOf<Uri?>(null) }

    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri -> selectedFileUri = uri }

    Column(modifier = Modifier.padding(16.dp)) {
        Text(text = "File Storage", style = MaterialTheme.typography.headlineMedium)

        TextField(
            value = path,
            onValueChange = { path = it },
            label = { Text("File Path") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Upload section
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(onClick = { filePickerLauncher.launch("*/*") }) {
                Text("Choose File")
            }
            Button(
                onClick = {
                    val uri = selectedFileUri
                    if (uri == null) {
                        status = "Error: No file selected"
                        return@Button
                    }
                    if (path.isBlank()) {
                        status = "Error: Enter a file path"
                        return@Button
                    }
                    scope.launch {
                        status = "Uploading..."
                        status = runCatching {
                            val contentType = context.contentResolver.getType(uri)
                            val inputStream = context.contentResolver.openInputStream(uri)
                                ?: error("Could not read file")
                            val bytes = inputStream.use { it.readBytes() }
                            val handle = api.getUploadUrl(path, contentType)
                            handle.upload(bytes)
                            "Uploaded ${bytes.size} bytes to $path"
                        }.getOrElse { "Error: ${it.message}" }
                    }
                }
            ) {
                Text("Upload")
            }
        }

        if (selectedFileUri != null) {
            Text(
                text = "Selected: ${selectedFileUri?.lastPathSegment ?: "file"}",
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(top = 4.dp)
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Download section
        Button(
            onClick = {
                if (path.isBlank()) {
                    status = "Error: Enter a file path"
                    return@Button
                }
                scope.launch {
                    status = "Downloading..."
                    downloadedContent = null
                    val result = runCatching {
                        val handle = api.getDownloadUrl(path)
                        val bytes = handle.download()
                        val lower = path.lowercase()
                        when {
                            lower.endsWith(".png") || lower.endsWith(".jpg") ||
                            lower.endsWith(".jpeg") || lower.endsWith(".gif") ||
                            lower.endsWith(".webp") -> DownloadedContent.ImageContent(bytes)

                            lower.endsWith(".txt") || lower.endsWith(".json") ||
                            lower.endsWith(".md") || lower.endsWith(".csv") ->
                                DownloadedContent.TextContent(String(bytes))

                            else -> DownloadedContent.Binary(bytes.size)
                        }
                    }
                    result.onSuccess { content ->
                        downloadedContent = content
                        status = when (content) {
                            is DownloadedContent.ImageContent -> "Downloaded image (${content.bytes.size} bytes)"
                            is DownloadedContent.TextContent -> "Downloaded text (${content.text.length} chars)"
                            is DownloadedContent.Binary -> "Downloaded ${content.size} bytes"
                        }
                    }
                    result.onFailure { status = "Error: ${it.message}" }
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Download")
        }

        Spacer(modifier = Modifier.height(16.dp))
        Text(text = "File Output:")
        Text(text = status)

        // Preview area
        when (val content = downloadedContent) {
            is DownloadedContent.ImageContent -> {
                val bitmap = remember(content.bytes) {
                    BitmapFactory.decodeByteArray(content.bytes, 0, content.bytes.size)
                }
                if (bitmap != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = "Downloaded image",
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 200.dp),
                        contentScale = ContentScale.Fit
                    )
                }
            }
            is DownloadedContent.TextContent -> {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = content.text,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxWidth()
                )
            }
            is DownloadedContent.Binary, null -> {}
        }
    }
}
