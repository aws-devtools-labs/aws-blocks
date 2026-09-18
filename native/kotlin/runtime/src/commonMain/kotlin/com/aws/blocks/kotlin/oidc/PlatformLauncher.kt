@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.InternalBlocksApi

internal expect fun createPlatformLauncher(): OidcPlatformLauncher
