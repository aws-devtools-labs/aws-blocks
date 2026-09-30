package com.aws.blocks.kotlin.generator

/**
 * How strongly a build needs an OIDC relay target.
 *
 * The relay target's scheme has to be registered with the operating system on Android and
 * iOS, which happens at build time; a loopback receiver needs no registration and no
 * configured value.
 */
enum class RelayToRequirement {
    /** Every target registers a scheme, so a missing value is a misconfiguration. */
    Required,

    /** Some targets register a scheme and some do not, so a missing value is worth flagging. */
    Recommended,

    /** No target registers a scheme, so a missing value is expected. */
    NotNeeded,
}
