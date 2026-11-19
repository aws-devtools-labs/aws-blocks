// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import androidx.startup.Initializer
import java.lang.ref.WeakReference

internal object ContextProvider {
    lateinit var applicationContext: Context
        private set

    private val activityTracker = ActivityTracker()
    val activity: Activity?
        get() = activityTracker.currentActivity?.get()

    fun initialize(context: Context) {
        applicationContext = context.applicationContext
        activityTracker.initialize(context)
    }
}

internal class ActivityTracker : Application.ActivityLifecycleCallbacks {
    var currentActivity: WeakReference<Activity>? = null

    fun initialize(context: Context) {
        val app = context.applicationContext as Application
        app.registerActivityLifecycleCallbacks(this)
    }

    fun get(): Activity? = currentActivity?.get()

    override fun onActivityResumed(activity: Activity) {
        currentActivity = WeakReference(activity)
    }

    override fun onActivityPaused(activity: Activity) {
        if (currentActivity?.get() === activity) {
            currentActivity = null
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}

internal class ContextProviderInitializer : Initializer<Unit> {
    override fun create(context: Context) {
        ContextProvider.initialize(context)
    }

    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
