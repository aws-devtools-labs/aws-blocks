// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-export the Authenticator component, auth-state utilities, and the
// framework-neutral design-token layer (injectTheme + --bb-* tokens) from
// auth-common, so templates import them from one place.
export {
	AccountMenuBar,
	AuthenticatedContent,
	Authenticator,
	type AuthStateApi,
	broadcastAuthChange,
	injectTheme,
	onAuthChange,
	THEME_CSS,
	THEME_STYLE_ID,
} from '@aws-blocks/auth-common/ui';
