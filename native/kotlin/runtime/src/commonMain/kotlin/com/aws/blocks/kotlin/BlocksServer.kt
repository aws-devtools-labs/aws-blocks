// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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

    private val rawBase = url.toString().substringBefore("/aws-blocks")

    fun rawRoute(vararg segments: String): String =
        URLBuilder(rawBase).appendPathSegments(segments.toList()).buildString()
}
