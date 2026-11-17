// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type VariantProps, cva } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
	'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
	{
		variants: {
			variant: {
				default: 'border-transparent bg-active text-fg',
				success: 'border-ok/20 bg-ok/10 text-ok-fg',
				destructive: 'border-danger/20 bg-danger/10 text-danger-fg',
				warning: 'border-warn/20 bg-warn/10 text-warn-fg',
				outline: 'border-line text-fg-soft',
			},
		},
		defaultVariants: {
			variant: 'default',
		},
	},
);

export interface BadgeProps extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
	return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
