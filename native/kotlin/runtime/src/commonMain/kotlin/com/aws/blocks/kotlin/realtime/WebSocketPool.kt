// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.realtime

import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class ConnectionKey(val wsUrl: String, val token: String)

class ManagedConnection(
    val session: WebSocketSession,
    private val mutableFrames: MutableSharedFlow<Frame.Text>,
    private val readerJob: Job,
) {
    val frames: SharedFlow<Frame.Text> = mutableFrames.asSharedFlow()

    internal var refCount: Int = 1

    fun cancel() {
        readerJob.cancel()
    }
}

class WebSocketPool(
    private val sessionFactory: (suspend (String) -> WebSocketSession)? = null,
) {
    companion object {
        val default = WebSocketPool()
    }

    private val mutex = Mutex()
    internal val connections = mutableMapOf<ConnectionKey, ManagedConnection>()

    suspend fun acquire(
        wsUrl: String,
        token: String,
        scope: CoroutineScope,
        httpClient: HttpClient,
    ): ManagedConnection {
        val key = ConnectionKey(wsUrl, token)

        mutex.withLock {
            connections[key]?.let { existing ->
                existing.refCount++
                return existing
            }
        }

        val session = sessionFactory?.invoke(wsUrl)
            ?: httpClient.webSocketSession(wsUrl)

        val sharedFlow = MutableSharedFlow<Frame.Text>(extraBufferCapacity = 64)

        mutex.withLock {
            connections[key]?.let { existing ->
                existing.refCount++
                session.close()
                return existing
            }

            val readerJob = scope.launch {
                try {
                    for (frame in session.incoming) {
                        if (frame is Frame.Text) {
                            sharedFlow.emit(frame)
                        }
                    }
                } finally {
                    mutex.withLock {
                        connections.remove(key)
                    }
                }
            }

            val managed = ManagedConnection(
                session = session,
                mutableFrames = sharedFlow,
                readerJob = readerJob,
            )
            connections[key] = managed
            return managed
        }
    }

    suspend fun release(wsUrl: String, token: String) {
        val key = ConnectionKey(wsUrl, token)
        mutex.withLock {
            val managed = connections[key] ?: return
            managed.refCount--
            if (managed.refCount <= 0) {
                connections.remove(key)
                managed.cancel()
                managed.session.close()
            }
        }
    }

    internal suspend fun connectionCount(): Int = mutex.withLock {
        connections.size
    }
}
