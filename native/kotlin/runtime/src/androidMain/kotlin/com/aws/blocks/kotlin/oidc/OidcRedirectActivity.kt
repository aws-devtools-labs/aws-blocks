// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.net.toUri

class OidcRedirectActivity : ComponentActivity() {

    enum class State {
        Initial,
        Launching,
        Waiting,
        Cancelled,
        Complete
    }

    private var state = State.Initial

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onPause() {
        super.onPause()
        if (state == State.Launching) {
            state = State.Waiting
        }
    }

    override fun onResume() {
        super.onResume()
        // User has closed the custom tabs without proceeding with a sign in
        if (state == State.Waiting && intent?.data == null) {
            cancel()
        }
    }

    private fun handleIntent(intent: Intent?) {
        when (state) {
            State.Initial -> {
                val authorizeUrl = intent?.getStringExtra(EXTRA_AUTHORIZE_URL)
                if (authorizeUrl != null && PendingOidcResult.isActive) {
                    launchCustomTabs(authorizeUrl)
                } else {
                    cancel()
                }
            }

            State.Waiting -> {
                val redirectUri = intent?.data
                if (redirectUri != null) {
                    complete(redirectUri.toString())
                } else {
                    cancel()
                }
            }

            else -> cancel()
        }
    }

    @SuppressLint("UnsafeImplicitIntentLaunch")
    private fun launchCustomTabs(url: String) {
        state = State.Launching
        try {
            val customTabsIntent = CustomTabsIntent.Builder().build()
            customTabsIntent.launchUrl(this, url.toUri())
        } catch (_: Exception) {
            val browserIntent = Intent(Intent.ACTION_VIEW, url.toUri())
            startActivity(browserIntent)
        }
    }

    private fun cancel() {
        state = State.Cancelled
        PendingOidcResult.cancel()
        finish()
    }

    private fun complete(uri: String) {
        state = State.Complete
        PendingOidcResult.complete(uri)
        finish()
    }

    companion object {
        internal const val EXTRA_AUTHORIZE_URL = "com.aws.blocks.kotlin.oidc.AUTHORIZE_URL"
    }
}
