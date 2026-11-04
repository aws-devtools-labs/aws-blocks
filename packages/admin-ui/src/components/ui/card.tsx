// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as React from 'react';
import { cn } from '@/lib/utils';

function Card({ className, ...props }: React.ComponentProps<'div'>) {
	return <div className={cn('rounded-lg border border-line bg-panel text-fg', className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
	return <div className={cn('flex flex-col space-y-1 p-4', className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
	return <div className={cn('font-medium leading-none tracking-tight', className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
	return <div className={cn('text-[13px] text-fg-soft', className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
	return <div className={cn('p-4 pt-0', className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
