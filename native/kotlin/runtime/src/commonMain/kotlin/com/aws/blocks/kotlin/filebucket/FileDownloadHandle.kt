package com.aws.blocks.kotlin.filebucket

import com.aws.blocks.kotlin.defaultHttpClient
import com.aws.blocks.kotlin.exceptions.TransferableIOException
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.readRawBytes
import io.ktor.http.isSuccess
import io.ktor.utils.io.readAvailable
import kotlinx.io.Buffer
import kotlinx.io.RawSink
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class FileDownloadHandle(
    val url: String,
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
            throw TransferableIOException(
                "Download failed: HTTP ${response.status.value}"
            )
        }
        response.readRawBytes()
    } catch (e: TransferableIOException) {
        throw e
    } catch (e: Exception) {
        throw TransferableIOException("Download failed: ${e.message}", e)
    }

    suspend fun downloadTo(sink: RawSink) {
        try {
            httpClient.prepareGet(url).execute { response ->
                if (!response.status.isSuccess()) {
                    throw TransferableIOException(
                        "Download failed: HTTP ${response.status.value}"
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
        } catch (e: TransferableIOException) {
            throw e
        } catch (e: Exception) {
            throw TransferableIOException("Download failed: ${e.message}", e)
        }
    }
}
