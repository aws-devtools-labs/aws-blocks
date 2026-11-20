// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.example

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import blocks.testapp.Api
import blocks.testapp.Cursor
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import androidx.core.graphics.toColorInt

private val COLORS = listOf(
    Color(0xFFFF6B6B), Color(0xFF4ECDC4), Color(0xFF45B7D1), Color(0xFFF9CA24),
    Color(0xFF6C5CE7), Color(0xFFA29BFE), Color(0xFFFD79A8), Color(0xFF00B894),
)

private val userId = (1..6).map { ('a'..'z').random() }.joinToString("")
private val myColor = COLORS.random()

private fun colorFromHex(hex: String): Color {
    return try {
        Color(hex.toColorInt())
    } catch (_: Exception) {
        Color.Gray
    }
}

data class RemoteCursor(
    val x: Float,
    val y: Float,
    val color: Color,
    val userId: String,
    val lastSeen: Long = System.currentTimeMillis(),
)

@Composable
fun CursorTracker(api: Api) {
    val scope = rememberCoroutineScope()
    val remoteCursors = remember { mutableStateMapOf<String, RemoteCursor>() }
    var status by remember { mutableStateOf("Connecting...") }
    var channel by remember { mutableStateOf<RealtimeChannel<Cursor>?>(null) }
    var lastPublish by remember { mutableStateOf(0L) }

    // Subscribe to cursor channel
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

    // Remove stale cursors every 1s (matching web's setInterval)
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000L)
            val now = System.currentTimeMillis()
            remoteCursors.entries.removeAll { now - it.value.lastSeen > 3000 }
        }
    }

    Column(modifier = Modifier.padding(16.dp)) {
        Text(text = "Realtime Cursors", style = MaterialTheme.typography.headlineMedium)
        Text(text = status, style = MaterialTheme.typography.bodySmall)

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(8f / 3f)
                .padding(top = 8.dp)
                .background(Color(0xFFF8F9FA))
                .pointerInput(Unit) {
                    detectDragGestures { change, _ ->
                        change.consume()
                        // Throttle outgoing events to 50ms (same as web)
                        val now = System.currentTimeMillis()
                        if (now - lastPublish < 50) return@detectDragGestures
                        lastPublish = now

                        val pos = change.position
                        // Scale local coordinates to the web's 800x300 space
                        val scaleX = 800.0 / size.width
                        val scaleY = 300.0 / size.height
                        scope.launch {
                            try {
                                api.publishCursor(
                                    Cursor(
                                        userId = userId,
                                        x = pos.x * scaleX,
                                        y = pos.y * scaleY,
                                        color = String.format("#%06X", 0xFFFFFF and myColor.hashCode()),
                                    )
                                )
                            } catch (_: Exception) { /* best effort */ }
                        }
                    }
                }
        ) {
            // Isolate cursor drawing to avoid recomposing the outer Column
            CursorCanvas(remoteCursors)
        }

        Text(
            text = "Drag your finger to share your cursor position",
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 4.dp)
        )
    }
}

@Composable
private fun BoxScope.CursorCanvas(remoteCursors: Map<String, RemoteCursor>) {
    Canvas(modifier = Modifier.matchParentSize()) {
        val scaleX = size.width / 800f
        val scaleY = size.height / 300f
        for ((_, cursor) in remoteCursors) {
            val scaled = cursor.copy(
                x = cursor.x * scaleX,
                y = cursor.y * scaleY,
            )
            drawCursor(scaled)
        }
    }
}

private fun DrawScope.drawCursor(cursor: RemoteCursor) {
    // Modern tail-less pointer arrow (like macOS/Figma cursors)
    val path = Path().apply {
        moveTo(cursor.x, cursor.y)                        // tip
        lineTo(cursor.x + 11f, cursor.y + 26f)             // bottom-right
        lineTo(cursor.x + 13f, cursor.y + 13f)                  // notch
        lineTo(cursor.x + 26f, cursor.y + 10f)
        close()
    }
    // Black border
    drawPath(path, Color.Black, style = Stroke(width = 3f))
    // Filled interior
    drawPath(path, cursor.color)

    // Draw userId label (75% of previous size)
    val labelX = cursor.x + 24f
    val labelY = cursor.y + 36f
    val textPaint = Paint().apply {
        color = cursor.color.toArgb()
        textSize = 30f
        isAntiAlias = true
        typeface = Typeface.DEFAULT_BOLD
    }
    val textWidth = textPaint.measureText(cursor.userId)
    val padding = 6f

    // Label background
    drawRoundRect(
        color = cursor.color,
        topLeft = Offset(labelX - padding, labelY - 21f),
        size = androidx.compose.ui.geometry.Size(textWidth + padding * 2, 30f),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(6f, 6f),
    )

    // Label text
    drawContext.canvas.nativeCanvas.drawText(
        cursor.userId,
        labelX,
        labelY,
        textPaint.apply { color = android.graphics.Color.WHITE }
    )
}

@Preview(showBackground = true)
@Composable
private fun CursorPreview() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(8f / 3f)
            .background(Color(0xFFF8F9FA))
    ) {
        val testCursors = mapOf(
            "user1" to RemoteCursor(100f, 50f, COLORS[0], "Alice"),
            "user2" to RemoteCursor(400f, 150f, COLORS[1], "Bob"),
            "user3" to RemoteCursor(700f, 250f, COLORS[2], "Charlie")
        )
        CursorCanvas(testCursors)
    }
}
