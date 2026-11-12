package com.aws.blocks.kotlin.filebucket

import com.aws.blocks.kotlin.defaultHttpClient
import com.aws.blocks.kotlin.exceptions.TransferableIOException
import io.ktor.client.HttpClient
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.content.ChannelWriterContent
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.utils.io.writeFully
import kotlinx.io.Buffer
import kotlinx.io.RawSource
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class FileUploadHandle(
    val url: String,
    private val fileContentType: String? = null,
    // No cookie jar: [url] is pre-authorized, so it carries its own credential.
    private val httpClient: HttpClient = defaultHttpClient()
) {

    companion object {
        fun fromJson(element: JsonElement): FileUploadHandle {
            val obj = element.jsonObject
            val url = obj["url"]!!.jsonPrimitive.content
            val contentType = obj["contentType"]?.jsonPrimitive?.content
            return FileUploadHandle(url, contentType)
        }
    }

    /**
     * This handle's descriptor, as the server's `toJSON()` sends it and [fromJson] reads it:
     * `{ "__blocks": "file-bucket/upload", "url", "contentType"? }`. A generated client sends a
     * handle parameter this way.
     */
    fun toJson(): JsonObject = buildJsonObject {
        put("__blocks", "file-bucket/upload")
        put("url", url)
        fileContentType?.let { put("contentType", it) }
    }

    suspend fun upload(body: ByteArray) {
        try {
            val response = httpClient.put(url) {
                fileContentType?.let { contentType(ContentType.parse(it)) }
                setBody(body)
            }
            if (!response.status.isSuccess()) {
                throw TransferableIOException(
                    "Upload failed: HTTP ${response.status.value}"
                )
            }
        } catch (e: TransferableIOException) {
            throw e
        } catch (e: Exception) {
            throw TransferableIOException("Upload failed: ${e.message}", e)
        }
    }

    /**
     * Streams [source] to the presigned upload URL.
     *
     * When [contentLength] is `null` the body is sent without a `Content-Length`
     * header (chunked). If the handle was created on the server with a
     * `contentLength` option, that size is signed into the URL and the upload is
     * rejected unless it sends exactly that `Content-Length`: pass the same value
     * here, and make [source] yield exactly that many bytes.
     *
     * @param source The bytes to upload.
     * @param contentLength The body size in bytes, or `null` to stream without one.
     * @throws TransferableIOException On an HTTP error or a network failure.
     */
    suspend fun uploadFrom(source: RawSource, contentLength: Long? = null) {
        try {
            val parsedContentType = fileContentType?.let { ContentType.parse(it) }
            val body = ChannelWriterContent(
                body = {
                    val buffer = Buffer()
                    val byteArray = ByteArray(8192)
                    while (source.readAtMostTo(buffer, 8192L) != -1L) {
                        while (buffer.size > 0) {
                            val toRead = buffer.readAtMostTo(byteArray)
                            writeFully(byteArray, 0, toRead)
                        }
                    }
                },
                contentType = parsedContentType,
                contentLength = contentLength
            )
            val response = httpClient.put(url) {
                setBody(body)
            }
            if (!response.status.isSuccess()) {
                throw TransferableIOException(
                    "Upload failed: HTTP ${response.status.value}"
                )
            }
        } catch (e: TransferableIOException) {
            throw e
        } catch (e: Exception) {
            throw TransferableIOException("Upload failed: ${e.message}", e)
        }
    }
}
