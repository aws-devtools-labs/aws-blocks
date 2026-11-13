// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from 'next';
import { AppHeader } from '@/components/app-header';
import { EnvironmentProvider } from '@/components/environment-context';
import { PrimarySidebar } from '@/components/primary-sidebar';
import { ThemeProvider } from '@/components/theme-context';
import { sidebarBootScript } from '@/nav/sidebar-preference';
import { themeBootScript } from '@/theme/preference';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
	title: 'Blocks Dashboard',
	description: 'Admin UI for Blocks applications',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		// No `dark` class: the palette is keyed on `data-theme`, nothing in the
		// codebase uses a `dark:` variant, and a hardcoded class saying "dark" on a
		// document painted light would be a lie a maintainer could act on.
		// `suppressHydrationWarning` because the script below sets `data-theme` on
		// this element before React hydrates.
		<html lang="en" suppressHydrationWarning>
			<head>
				{/*
				 * Applied before first paint. A synchronous inline script in <head>
				 * blocks parsing, so the document is never painted in the theme the
				 * server guessed and then corrected -- which is the whole reason this
				 * is inlined rather than imported.
				 */}
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: generated from our own constants, no user input. */}
				<script dangerouslySetInnerHTML={{ __html: themeBootScript() }} />
				{/*
				 * Applied before first paint for the same reason as the theme: a stored
				 * collapsed rail would otherwise render 208px wide and snap to 56px on
				 * hydration, which is a layout shift on every page load.
				 */}
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: generated from our own constants, no user input. */}
				<script dangerouslySetInnerHTML={{ __html: sidebarBootScript() }} />
			</head>
			<body>
				<Providers>
					<ThemeProvider>
						<EnvironmentProvider>
							<div className="flex min-h-screen flex-col">
								<AppHeader />
								<div className="flex min-h-0 flex-1">
									<PrimarySidebar />
									<main className="min-w-0 flex-1 p-6">{children}</main>
								</div>
							</div>
						</EnvironmentProvider>
					</ThemeProvider>
				</Providers>
			</body>
		</html>
	);
}
