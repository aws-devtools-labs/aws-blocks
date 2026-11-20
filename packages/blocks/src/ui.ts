// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-export the auth UI from `@aws-cdk-blocks/bb-auth/ui`: the Authenticator
// components and auth state utilities (the very same functions as
// `@aws-cdk-blocks/auth-common/ui`, so they work with every auth Building Block),
// the `StatusMessage` status-line primitive, plus `Auth`'s typed UI vocabulary (`authOverrides`, `AuthActionName`, …) and the
// framework-neutral design-token layer (`injectTheme` + the `--bb-*` tokens).
export * from '@aws-cdk-blocks/bb-auth/ui';

// The browser redirect client: federated sign-in for a frontend served from
// another origin than the API (`createAuthClient`, from
// `@aws-cdk-blocks/bb-auth/browser-client`).
export * from '@aws-cdk-blocks/bb-auth/browser-client';
