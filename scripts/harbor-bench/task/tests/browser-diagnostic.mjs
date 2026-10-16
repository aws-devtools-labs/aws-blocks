// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Never return exception messages or values supplied by the generated application.
export function classifyBrowserFailure(error) {
	const message = typeof error?.message === 'string' ? error.message : '';
	if (error?.name === 'TimeoutError') return 'control_timeout';
	if (error?.code === 'ERR_ASSERTION') return 'value_mismatch';
	if (message.includes('Clicking the checkbox did not change its state')) return 'checkbox_state_unchanged';
	if (message.includes('Element is not attached') || message.includes('element was detached')) return 'element_detached';
	if (message.includes('strict mode violation')) return 'ambiguous_control';
	if (message.includes('Target page, context or browser has been closed')) return 'browser_closed';
	if (message.includes('net::ERR_')) return 'navigation_error';
	return 'runtime_error';
}
