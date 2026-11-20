// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin

/**
 * Marks a declaration that exists so the library's own test suites can substitute behavior.
 *
 * These declarations are public only because test suites live in separate compilation units.
 * They can change or be removed in any release and are not covered by any compatibility
 * guarantee.
 */
@RequiresOptIn(
    level = RequiresOptIn.Level.ERROR,
    message = "Internal AWS CDK Blocks API. It can change or be removed in any release.",
)
@Retention(AnnotationRetention.BINARY)
@Target(
    AnnotationTarget.CLASS,
    AnnotationTarget.FUNCTION,
    AnnotationTarget.PROPERTY,
)
annotation class InternalBlocksApi
