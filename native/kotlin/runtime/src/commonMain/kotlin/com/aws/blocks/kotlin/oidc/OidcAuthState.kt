// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

sealed interface OidcAuthState {
    data object Loading : OidcAuthState
    data object SignedOut : OidcAuthState
    data class SignedIn(val user: OidcUser) : OidcAuthState
}
