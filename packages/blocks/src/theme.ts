// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-export ONLY the framework-neutral design-token layer (injectTheme +
// the --bb-* tokens) from auth-common's dedicated `./theme` subpath. A
// template that just wants the themed look (e.g. the non-auth `react` and
// `nextjs` templates) imports from here instead of `@aws-blocks/blocks/ui`,
// so a bundler is not forced to pull the Authenticator, the WebAuthn
// encode/decode helpers, and the BroadcastChannel plumbing to ship one
// `<style>` tag.
export { injectTheme, THEME_CSS, THEME_STYLE_ID } from '@aws-blocks/auth-common/theme';
