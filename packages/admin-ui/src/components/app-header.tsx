// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { useEnvironment } from '@/components/environment-context';
import { ThemeToggle } from '@/components/theme-toggle';
import type { MetaResponse } from '@/contract/v1';
import { apiGet } from '@/lib/api-client';

export function AppHeader() {
	const { environment, setEnvironment, statuses } = useEnvironment();

	const { data: meta } = useQuery({
		queryKey: ['meta'],
		queryFn: () => apiGet<MetaResponse>('/api/v1/meta'),
	});

	return (
		<header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
			<span className="text-[15px] font-semibold tracking-tight">Blocks</span>
			<span className="text-fg-dim">/</span>
			<span className="font-mono text-[13px] text-fg-soft">{meta?.projectName ?? '…'}</span>
			<span className="text-fg-dim">/</span>
			{/*
			 * One row, local included rather than set apart: it is an environment
			 * like the others, and a divider or a different shape would suggest a
			 * second axis -- which is exactly the shape this replaced.
			 */}
			<div className="flex gap-1 rounded-lg bg-hover p-0.5">
				{statuses.map((status) => {
					const selected = status.id === environment;
					return (
						<button
							key={status.id}
							type="button"
							onClick={() => setEnvironment(status.id)}
							disabled={!status.selectable}
							// The reason travels with the control. A stage that cannot be
							// selected without saying why reads as a broken switch.
							title={status.detail}
							aria-current={selected ? 'true' : undefined}
							className={`rounded-md px-3 py-1 text-[13px] transition-colors ${
								selected ? 'bg-active font-medium text-fg' : 'text-fg-soft hover:text-fg'
							} ${status.selectable ? '' : 'cursor-not-allowed opacity-50 hover:text-fg-soft'}`}
						>
							{status.id}
						</button>
					);
				})}
			</div>
			{/*
			 * Grouped so the theme control is present even when `meta` is not: the
			 * theme is a local preference and must not disappear because the API
			 * refused a request.
			 */}
			<div className="ml-auto flex items-center gap-3">
				<ThemeToggle />
				{meta && <span className="font-mono text-xs text-fg-dim">admin-ui v{meta.adminUiVersion}</span>}
			</div>
		</header>
	);
}
