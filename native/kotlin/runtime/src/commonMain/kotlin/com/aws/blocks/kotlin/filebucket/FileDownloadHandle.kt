// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.filebucket

import com.aws.blocks.kotlin.defaultHttpClient
import com.aws.blocks.kotlin.exceptions.FileTransferException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.readRawBytes
import io.ktor.http.isSuccess
import io.ktor.utils.io.readAvailable
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.io.Buffer
import kotlinx.io.RawSink
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class FileDownloadHandle(
    val url: String,
    // No cookie jar: [url] is pre-authorized, so it carries its own credential.
    private val httpClient: HttpClient = defaultHttpClient()
) {

    companion object {
        fun fromJson(element: JsonElement): FileDownloadHandle {
            val obj = element.jsonObject
            val url = obj["url"]!!.jsonPrimitive.content
            return FileDownloadHandle(url)
        }
    }

    suspend fun download(): ByteArray = try {
        val response = httpClient.get(url)
        if (!response.status.isSuccess()) {
            throw FileTransferException(
                "Download failed: HTTP ${response.status.value}",
                response.status.value,
            )
        }
        response.readRawBytes()
    } catch (e: FileTransferException) {
        throw e
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        throw FileTransferException("Download failed: ${e.message}", null, e)
    }

    suspend fun downloadTo(sink: RawSink) {
        try {
            httpClient.prepareGet(url).execute { response ->
                if (!response.status.isSuccess()) {
                    throw FileTransferException(
                        "Download failed: HTTP ${response.status.value}",
                        response.status.value,
                    )
                }
                val channel = response.bodyAsChannel()
                val byteArray = ByteArray(8192)
                val buffer = Buffer()
                while (!channel.isClosedForRead) {
                    val bytesRead = channel.readAvailable(byteArray)
                    if (bytesRead > 0) {
                        buffer.write(byteArray, startIndex = 0, endIndex = bytesRead)
                        buffer.transferTo(sink)
                    }
                }
            }
        } catch (e: FileTransferException) {
            throw e
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw FileTransferException("Download failed: ${e.message}", null, e)
        }
    }
}
