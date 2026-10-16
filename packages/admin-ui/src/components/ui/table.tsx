// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as React from 'react';
import { cn } from '@/lib/utils';

function Table({ className, ...props }: React.ComponentProps<'table'>) {
	return (
		<div className="relative w-full overflow-auto">
			<table className={cn('w-full caption-bottom text-[13px]', className)} {...props} />
		</div>
	);
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
	return <thead className={cn('[&_tr]:border-b [&_tr]:border-line', className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
	return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
	return <tr className={cn('border-b border-line-soft transition-colors hover:bg-hover', className)} {...props} />;
}

function TableHead({ className, scope, ...props }: React.ComponentProps<'th'>) {
	return (
		// `scope` defaults to 'col' rather than being left to each caller. Three
		// pages passed it and four did not, so 20 headers across Cost, Deployments
		// and Logs were announced as plain cells — a screen reader then reads a row
		// without saying which column each value belongs to. Still overridable for
		// a row header.
		<th
			scope={scope ?? 'col'}
			className={cn('h-8 px-2.5 text-left align-middle text-xs font-medium text-fg-dim', className)}
			{...props}
		/>
	);
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
	return <td className={cn('px-2.5 py-1.5 align-middle', className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
