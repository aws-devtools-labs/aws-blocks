// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.example.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import blocks.testapp.Api
import blocks.testapp.Cursor
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private val COLORS = listOf(
    Color(0xFFFF6B6B), Color(0xFF4ECDC4), Color(0xFF45B7D1), Color(0xFFF9CA24),
    Color(0xFF6C5CE7), Color(0xFFA29BFE), Color(0xFFFD79A8), Color(0xFF00B894),
)

private val userId = (1..6).map { ('a'..'z').random() }.joinToString("")
private val myColor = COLORS.random()

private data class RemoteCursor(
    val x: Float,
    val y: Float,
    val color: Color,
    val userId: String,
    val lastSeen: Long,
)

private fun colorFromHex(hex: String): Color {
    return try {
        Color(hex.removePrefix("#").toLong(16).toInt() or 0xFF000000.toInt())
    } catch (_: Exception) {
        Color.Gray
    }
}

private fun currentTimeMillis(): Long = kotlinx.datetime.Clock.System.now().toEpochMilliseconds()

@Composable
fun RealtimeScreen(api: Api, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    val remoteCursors = remember { mutableStateMapOf<String, RemoteCursor>() }
    var status by remember { mutableStateOf("Connecting...") }
    var channel by remember { mutableStateOf<RealtimeChannel<Cursor>?>(null) }
    var lastPublish by remember { mutableStateOf(0L) }
    var boxSize by remember { mutableStateOf(IntSize.Zero) }

    DisposableEffect(Unit) {
        val job = scope.launch {
            try {
                val ch = api.getCursorChannel()
                channel = ch
                status = "Connected as $userId"

                ch.subscribe()
                    .catch { e -> status = "Error: ${e.message}" }
                    .collect { msg ->
                        if (msg.userId != userId) {
                            remoteCursors[msg.userId] = RemoteCursor(
                                x = msg.x.toFloat(),
                                y = msg.y.toFloat(),
                                color = colorFromHex(msg.color),
                                userId = msg.userId,
                                lastSeen = currentTimeMillis(),
                            )
                        }
                    }
            } catch (e: Exception) {
                status = "Error: ${e.message}"
            }
        }

        onDispose {
            job.cancel()
            channel?.close()
        }
    }

    LaunchedEffect(Unit) {
        while (true) {
            delay(1000L)
            val now = currentTimeMillis()
            remoteCursors.entries.removeAll { now - it.value.lastSeen > 3000 }
        }
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
    ) {
        Text("Realtime Cursors", style = MaterialTheme.typography.headlineMedium)
        Text(status, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(8.dp))

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(8f / 3f)
                .background(Color(0xFFF8F9FA))
                .onSizeChanged { boxSize = it }
                .pointerInput(Unit) {
                    detectDragGestures { change, _ ->
                        change.consume()
                        val now = currentTimeMillis()
                        if (now - lastPublish < 50) return@detectDragGestures
                        lastPublish = now

                        val pos = change.position
                        val scaleX = 800.0 / size.width
                        val scaleY = 300.0 / size.height
                        scope.launch {
                            runCatching {
                                api.publishCursor(
                                    Cursor(
                                        userId = userId,
                                        x = pos.x * scaleX,
                                        y = pos.y * scaleY,
                                        color = "#" + (0xFFFFFF and myColor.hashCode()).toString(16).padStart(6, '0'),
                                    )
                                )
                            }
                        }
                    }
                }
        ) {
            remoteCursors.values.forEach { cursor ->
                val scaleX = boxSize.width / 800f
                val scaleY = boxSize.height / 300f
                val offsetX = (cursor.x * scaleX).roundToInt()
                val offsetY = (cursor.y * scaleY).roundToInt()

                Box(modifier = Modifier.offset { IntOffset(offsetX, offsetY) }) {
                    Box(
                        modifier = Modifier
                            .size(16.dp)
                            .clip(CircleShape)
                            .background(cursor.color)
                    )
                    Text(
                        text = cursor.userId,
                        style = MaterialTheme.typography.labelSmall,
                        color = cursor.color,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .offset(y = 16.dp)
                    )
                }
            }
        }

        Text(
            "Drag to share your cursor position",
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 4.dp)
        )
    }
}
