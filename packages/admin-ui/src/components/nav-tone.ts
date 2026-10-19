// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BadgeProps } from '@/components/ui/badge';
import type { NavTone } from '@/nav/inventory-tree';

/**
 * A tone is a role; picking the variant that expresses it is the view's job.
 *
 * Shared rather than per-component because two surfaces render the SAME tag: the
 * second-level nav and the Blocks index page both show each block's deployment
 * badge, and they were found disagreeing — the page hand-wrote `outline` for
 * every non-deployed block while the nav gave an `unmatched` one the `warn`
 * colour, so one block carried two different badges on screen at once. A total
 * map over a closed union, in one place, is what keeps them the same.
 */
export const TONE_VARIANT: Record<NavTone, NonNullable<BadgeProps['variant']>> = {
	neutral: 'outline',
	ok: 'success',
	warn: 'warning',
	danger: 'destructive',
};
