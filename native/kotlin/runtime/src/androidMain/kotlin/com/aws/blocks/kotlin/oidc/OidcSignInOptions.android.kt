// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

/** Nothing to configure: the Custom Tab dismisses itself when sign-in finishes. */
actual class OidcSignInPlatformOptions

internal actual fun defaultPlatformOptions(): OidcSignInPlatformOptions =
    OidcSignInPlatformOptions()
