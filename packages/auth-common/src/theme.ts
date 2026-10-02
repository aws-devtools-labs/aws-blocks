// SPDX-License-Identifier: Apache-2.0

/**
 * Framework-neutral design-token layer for the shared Blocks UI.
 *
 * The Blocks UI components ({@link Authenticator}, {@link AccountMenuBar})
 * are vanilla-DOM factories that drop into any host page — lit-html,
 * vanilla, React, Next.js. Rather than ask every host to remember to
 * import a stylesheet (a template that forgets renders unstyled), the
 * tokens and base classes travel WITH the component: the component calls
 * {@link injectTheme} once and the `<style>` lands in `document.head`,
 * idempotently.
 *
 * All visual values are CSS custom properties on `:root`, so a host's own
 * markup (a template's todo list) can consume the same `--bb-*` variables
 * for a consistent look without importing anything. Light and dark
 * palettes are driven by `prefers-color-scheme`; a host can force one with
 * `data-bb-theme="light"` / `data-bb-theme="dark"` on any ancestor.
 */

/** Stable id of the injected `<style>` element — the idempotency key. */
export const THEME_STYLE_ID = 'bb-ui-theme';

/**
 * The design-token stylesheet: CSS custom properties plus the base
 * component classes (`.bb-*`) the Blocks UI renders against.
 *
 * Exported as a string so a host that DOES want a bundled stylesheet (or
 * a build step that extracts CSS) can read it directly, and so tests can
 * assert against it without a DOM.
 */
export const THEME_CSS: string = `
:root {
	/* Palette — light (default) */
	--bb-color-bg: #ffffff;
	--bb-color-surface: #ffffff;
	--bb-color-surface-alt: #f4f6f9;
	--bb-color-text: #16191f;
	--bb-color-text-muted: #5f6b7a;
	--bb-color-border: #d5dbdb;
	--bb-color-accent: #0972d3;
	--bb-color-accent-hover: #065299;
	--bb-color-accent-text: #ffffff;
	--bb-color-danger: #d91515;
	--bb-color-focus-ring: #0972d3;

	/* Spacing scale */
	--bb-space-1: 4px;
	--bb-space-2: 8px;
	--bb-space-3: 12px;
	--bb-space-4: 16px;
	--bb-space-5: 20px;

	/* Radius */
	--bb-radius-sm: 4px;
	--bb-radius-md: 8px;

	/* Typography */
	--bb-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	--bb-font-size-sm: 12px;
	--bb-font-size-base: 14px;

	/* Elevation */
	--bb-shadow-sm: 0 1px 2px rgba(0, 7, 22, 0.12);
	--bb-shadow-md: 0 4px 16px rgba(0, 7, 22, 0.24);
}

@media (prefers-color-scheme: dark) {
	:root {
		--bb-color-bg: #0f1b2a;
		--bb-color-surface: #1a2634;
		--bb-color-surface-alt: #232f3e;
		--bb-color-text: #e9ebed;
		--bb-color-text-muted: #a9b4c0;
		--bb-color-border: #3b4858;
		--bb-color-accent: #539fe5;
		--bb-color-accent-hover: #89bdee;
		--bb-color-accent-text: #0f1b2a;
		--bb-color-danger: #ff7170;
		--bb-color-focus-ring: #539fe5;
	}
}

/* Explicit host override — wins over the media query. */
[data-bb-theme="light"] {
	--bb-color-bg: #ffffff;
	--bb-color-surface: #ffffff;
	--bb-color-surface-alt: #f4f6f9;
	--bb-color-text: #16191f;
	--bb-color-text-muted: #5f6b7a;
	--bb-color-border: #d5dbdb;
	--bb-color-accent: #0972d3;
	--bb-color-accent-hover: #065299;
	--bb-color-accent-text: #ffffff;
	--bb-color-danger: #d91515;
	--bb-color-focus-ring: #0972d3;
}

[data-bb-theme="dark"] {
	--bb-color-bg: #0f1b2a;
	--bb-color-surface: #1a2634;
	--bb-color-surface-alt: #232f3e;
	--bb-color-text: #e9ebed;
	--bb-color-text-muted: #a9b4c0;
	--bb-color-border: #3b4858;
	--bb-color-accent: #539fe5;
	--bb-color-accent-hover: #89bdee;
	--bb-color-accent-text: #0f1b2a;
	--bb-color-danger: #ff7170;
	--bb-color-focus-ring: #539fe5;
}

/* ------------------------------------------------------------------ */
/* Base component classes                                              */
/* ------------------------------------------------------------------ */

.bb-authenticator {
	max-width: 400px;
	font-family: var(--bb-font-family);
	color: var(--bb-color-text);
}

.bb-card {
	border: 1px solid var(--bb-color-border);
	padding: var(--bb-space-5);
	border-radius: var(--bb-radius-md);
	background: var(--bb-color-surface);
	box-shadow: var(--bb-shadow-sm);
}

.bb-heading {
	margin-top: 0;
	margin-bottom: var(--bb-space-4);
	font-weight: 700;
	color: var(--bb-color-text);
}

.bb-error {
	color: var(--bb-color-danger);
	font-size: var(--bb-font-size-base);
	font-weight: 500;
	margin-bottom: var(--bb-space-3);
}

.bb-field {
	margin-bottom: var(--bb-space-4);
}

.bb-input {
	width: 100%;
	padding: var(--bb-space-2) var(--bb-space-3);
	margin-bottom: var(--bb-space-1);
	box-sizing: border-box;
	font-size: var(--bb-font-size-base);
	font-family: inherit;
	color: var(--bb-color-text);
	background: var(--bb-color-surface);
	border: 1px solid var(--bb-color-border);
	border-radius: var(--bb-radius-sm);
}

.bb-input:focus {
	outline: none;
	border-color: var(--bb-color-accent);
	box-shadow: 0 0 0 2px var(--bb-color-focus-ring);
}

.bb-hint {
	font-size: var(--bb-font-size-sm);
	color: var(--bb-color-text-muted);
	margin: 0 0 var(--bb-space-2) 2px;
}

.bb-button {
	font-family: inherit;
	font-size: var(--bb-font-size-base);
	padding: var(--bb-space-2) var(--bb-space-4);
	border-radius: var(--bb-radius-sm);
	cursor: pointer;
	border: 1px solid transparent;
}

.bb-button:focus-visible {
	outline: none;
	box-shadow: 0 0 0 2px var(--bb-color-focus-ring);
}

.bb-button-primary {
	background: var(--bb-color-accent);
	color: var(--bb-color-accent-text);
	border-color: var(--bb-color-accent);
}

.bb-button-primary:hover {
	background: var(--bb-color-accent-hover);
	border-color: var(--bb-color-accent-hover);
}

.bb-button-secondary {
	background: var(--bb-color-surface);
	color: var(--bb-color-accent);
	border-color: var(--bb-color-border);
}

.bb-button-secondary:hover {
	border-color: var(--bb-color-accent);
}

.bb-button-block {
	width: 100%;
}

.bb-menubar {
	display: flex;
	justify-content: flex-end;
	align-items: center;
	gap: var(--bb-space-3);
	padding: var(--bb-space-3) var(--bb-space-5);
	background: var(--bb-color-surface-alt);
	border-bottom: 1px solid var(--bb-color-border);
	font-family: var(--bb-font-family);
	color: var(--bb-color-text);
}

.bb-menubar-username {
	font-size: var(--bb-font-size-base);
	color: var(--bb-color-text);
}

.bb-modal-backdrop {
	position: fixed;
	inset: 0;
	background: rgba(0, 7, 22, 0.5);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 1000;
}

.bb-modal-content {
	background: var(--bb-color-surface);
	color: var(--bb-color-text);
	border-radius: var(--bb-radius-md);
	padding: var(--bb-space-5);
	max-width: 400px;
	position: relative;
	box-shadow: var(--bb-shadow-md);
}

.bb-modal-close {
	position: absolute;
	top: var(--bb-space-2);
	right: var(--bb-space-2);
	border: none;
	background: none;
	font-size: 20px;
	line-height: 1;
	cursor: pointer;
	padding: 0;
	width: 24px;
	height: 24px;
	color: var(--bb-color-text-muted);
}
`.trim();

/**
 * Inject the design-token stylesheet into `document.head` exactly once.
 *
 * Idempotent and SSR-safe: a second call is a no-op (keyed on
 * {@link THEME_STYLE_ID}), and a non-DOM environment (no `document`)
 * returns silently so server-side rendering of a host page doesn't throw.
 * Every Blocks UI factory calls this before building its DOM, so the
 * tokens are always present by the time the component paints.
 */
export function injectTheme(): void {
	if (typeof document === 'undefined') return;
	if (document.getElementById(THEME_STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = THEME_STYLE_ID;
	style.textContent = THEME_CSS;
	document.head.appendChild(style);
}
