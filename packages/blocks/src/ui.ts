// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-export Authenticator component and auth state utilities from auth-common
export { Authenticator, AuthenticatedContent, AccountMenuBar, onAuthChange, broadcastAuthChange, type AuthStateApi } from '@aws-blocks/auth-common/ui';

// Re-export the framework-neutral design-token layer so templates can
// inject the theme and reference --bb-* tokens for their own UI.
export { injectTheme, THEME_CSS, THEME_STYLE_ID } from '@aws-blocks/auth-common/ui';
