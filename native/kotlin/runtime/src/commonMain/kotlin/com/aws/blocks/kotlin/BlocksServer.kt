package com.aws.blocks.kotlin

import io.ktor.http.URLBuilder
import io.ktor.http.Url
import io.ktor.http.appendPathSegments

data class BlocksServer(
    val name: String,
    val url: Url
) {
    constructor(
        name: String,
        url: String
    ) : this(name = name, url = Url(url))

    /**
     * Where raw routes such as the auth routes hang off: [url] cut at its first path segment that
     * is exactly `aws-blocks`, keeping the scheme, host, port and anything before that segment
     * (an API Gateway stage), with no trailing `/`. A URL with no such segment is used whole,
     * less a trailing `/`.
     */
    private val rawBase: String = URLBuilder(url).apply {
        val segments = encodedPathSegments
        val cut = segments.indexOf("aws-blocks")
        if (cut >= 0) {
            encodedPathSegments = segments.subList(0, cut)
            encodedParameters.clear()
            encodedFragment = ""
        }
    }.buildString().trimEnd('/')

    fun rawRoute(vararg segments: String): String =
        URLBuilder(rawBase).appendPathSegments(segments.toList()).buildString()
}
