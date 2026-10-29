// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Races in the client auth-state store: tabs, out-of-order answers, failures.
 * Shared by the `ui.races.*.test.ts` files (each runs in its own process, so
 * importing this installs the DOM globals before `ui.ts` loads).
 *
 * The tests drive the real `ui.ts` against a fake server that is faithful to
 * how a browser session cookie behaves, and check every outcome against an
 * oracle written from the store's rule (DESIGN.md, "Ordering answers"), not
 * from the code.
 *
 * The model:
 *
 * - Each API has one session cookie, shared by every tab of the origin, and a
 *   server-side set of live sessions.
 * - `getAuthState()` carries the cookie the jar holds when it is sent. With
 *   `cookie` timing the server checks that session when it answers (so a
 *   sign-out or an expiry in between makes it `signedOut`); with the old
 *   `naive` timing it answers at once.
 * - `setAuthState()` changes the session (a sign-in sets the cookie, a sign-out
 *   clears it and ends the session) when its response arrives with `cookie`
 *   timing, and when it is sent with `naive` timing. A mid-flow step, a failed
 *   sign-in and a resend change nothing.
 * - Another tab changes the shared cookie, then its broadcast reaches this tab
 *   over `BroadcastChannel` some time later.
 * - A failed request never reaches the server.
 *
 * Every interleaving of up to three concurrent operations is enumerated
 * (depth-first, replaying each path from a fresh world), for one and two APIs,
 * with both timings. The operations: a hydration in flight (landing or
 * failing); another tab's sign-in or sign-out, its broadcast, and the refetch
 * it triggers here (or that refetch failing); a submit here with a terminal
 * result (a sign-in, a sign-out, a failed sign-in) or a mid-flow one (an MFA
 * step, a resend), or failing; and a session timeout followed by a new sign-in
 * that returns an MFA step. Requests the store sends on its own (its re-reads)
 * are interleaved like any other.
 *
 * After every event the snapshot must be the answer the rule names. Once
 * settled it must also equal the session's truth (what a fresh read would
 * see, or the step the tab is still in) when no request failed, `onAuthChange`
 * must agree with it (or hold the last broadcast, when a refetch failed), and
 * nothing may cross APIs. With cookie timing, `onAuthChange`'s emissions are
 * checked against the server's session too: no user after a sign-out it
 * reported, without a sign-in since. Reads must stay within their causes, and
 * a run that does not settle fails.
 *
 * The two-API, three-operation test (every kind and placement, about 8.6
 * million interleavings) runs only with `AUTH_STORE_RACES_FULL=1`, which CI
 * sets when the store or this model changes (`auth-store-races.yml`). The
 * default run is the rest, about 1.2 million.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { Window } from 'happy-dom';
import type { AuthAction, AuthState, AuthUser } from '../index.js';
import type { AuthActionInput, AuthStateApi } from '../ui.js';

// ---------------------------------------------------------------------------
// happy-dom + BroadcastChannel (delivers to the other instances, never to itself)
// ---------------------------------------------------------------------------

const window = new Window();

class BroadcastChannelShim {
	static channels = new Map<string, BroadcastChannelShim[]>();
	name: string;
	listeners: ((event: MessageEvent) => void)[] = [];
	constructor(name: string) {
		this.name = name;
		const group = BroadcastChannelShim.channels.get(name) ?? [];
		group.push(this);
		BroadcastChannelShim.channels.set(name, group);
	}
	postMessage(data: unknown) {
		for (const ch of BroadcastChannelShim.channels.get(this.name) ?? []) {
			if (ch !== this) {
				for (const fn of [...ch.listeners]) fn({ data } as MessageEvent);
			}
		}
	}
	addEventListener(_type: string, fn: (event: MessageEvent) => void) {
		this.listeners.push(fn);
	}
	removeEventListener(_type: string, fn: (event: MessageEvent) => void) {
		this.listeners = this.listeners.filter((f) => f !== fn);
	}
	close() {}
}

Object.assign(globalThis, {
	window,
	document: window.document,
	HTMLElement: window.HTMLElement,
	HTMLFormElement: window.HTMLFormElement,
	HTMLInputElement: window.HTMLInputElement,
	HTMLButtonElement: window.HTMLButtonElement,
	CustomEvent: window.CustomEvent,
	KeyboardEvent: window.KeyboardEvent,
	BroadcastChannel: BroadcastChannelShim,
	Event: window.Event,
});

const { Authenticator, onAuthChange, submitAuthAction, subscribeAuthState, getAuthStateSnapshot } = await import(
	'../ui.js'
);

/** The other tab: a channel instance the test owns. */
const otherTab = new BroadcastChannelShim('blocks-auth');

/**
 * Let pending promise continuations run (no timers involved). The store's
 * longest chain is a few hops; `explore` flushes deeper before it calls a run
 * settled, so a chain longer than `ticks` cannot hide.
 */
async function flush(ticks = 12) {
	for (let i = 0; i < ticks; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Answers the fake server sends (a fresh object every time, as over the wire)
// ---------------------------------------------------------------------------

const signInAction: AuthAction = {
	name: 'signIn',
	label: 'Sign In',
	fields: [
		{ name: 'username', label: 'Username', type: 'text', required: true },
		{ name: 'password', label: 'Password', type: 'password', required: true },
	],
};

function userOf(ns: string, name: string): AuthUser {
	return { userId: `${ns}:${name}`, username: `${ns}:${name}` };
}

function signedIn(ns: string, name: string): AuthState {
	return { state: 'signedIn', user: userOf(ns, name), actions: [{ name: 'signOut', label: 'Sign Out', fields: [] }] };
}

function signedOut(error?: string): AuthState {
	return error
		? { state: 'signedOut', actions: [signInAction], error, errorName: 'NotAuthorizedException' }
		: { state: 'signedOut', actions: [signInAction] };
}

function confirmingSignIn(): AuthState {
	return {
		state: 'confirmingSignIn',
		actions: [
			{
				name: 'confirmSignIn',
				label: 'Confirm',
				fields: [
					{ name: 'challenge', label: 'Challenge', type: 'hidden', required: true, defaultValue: 'code' },
					{ name: 'session', label: 'Session', type: 'hidden', required: true, defaultValue: 'challenge-1' },
					{ name: 'code', label: 'Code', type: 'text', required: true },
				],
			},
		],
	};
}

function confirmingSignUp(): AuthState {
	return {
		state: 'confirmingSignUp',
		actions: [
			{
				name: 'confirmSignUp',
				label: 'Confirm',
				fields: [
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: 'alice' },
					{ name: 'code', label: 'Code', type: 'text', required: true },
				],
			},
			{
				name: 'resendSignUpCode',
				label: 'Resend',
				fields: [
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: 'alice' },
				],
			},
		],
	};
}

// ---------------------------------------------------------------------------
// The world: one clock, the requests in flight, every answer received
// ---------------------------------------------------------------------------

type Mode = 'cookie' | 'naive';

/**
 * What an answer tells the tab, by the server's account of it (not the store's):
 * a `read` (`getAuthState`), a `session` action (it set or cleared the session
 * cookie) or a `flow` action (it changed nothing on the server: a challenge
 * step, a failed sign-in, a resend).
 */
type Kind = 'read' | 'session' | 'flow';

interface Answer {
	ns: string;
	kind: Kind;
	/** Clock tick the request was sent at. */
	start: number;
	/** Clock tick its response arrived at. */
	arrival: number;
	state: AuthState;
}

interface Event {
	label: string;
	run(): void;
}

class World {
	clock = 0;
	pending: Event[] = [];
	answers = new Map<string, Answer[]>();
	byState = new WeakMap<object, Answer>();
	failNext = false;
	failed = 0;
	/** Set while another tab's broadcast is being delivered: the read it triggers is a refetch. */
	delivering = false;
	/** A refetch for another tab's broadcast failed in this run. */
	refetchFailed = false;
	/** Requests sent in this run (hydration included), and broadcasts delivered. */
	reads = 0;
	actions = 0;
	deliveries = 0;
	/** One order for server-side session changes and `onAuthChange` emissions. */
	seq = 0;
	/** Per API: every change of the session's user on the server, in order. */
	sessions = new Map<string, { seq: number; user: string | null }[]>();
	bump() {
		this.seq += 1;
		return this.seq;
	}
	tick() {
		this.clock += 1;
		return this.clock;
	}
	takeFail() {
		const fail = this.failNext;
		this.failNext = false;
		return fail;
	}
	/** A request in flight; resolving or rejecting it is an event the scheduler picks. */
	request(label: string, ns: string, kind: Kind, start: number, fail: boolean, produce: () => AuthState) {
		const refetch = kind === 'read' && this.delivering;
		return new Promise<AuthState>((resolve, reject) => {
			const event: Event = {
				label: fail ? `${label}✗` : label,
				run: () => {
					this.pending = this.pending.filter((e) => e !== event);
					const arrival = this.tick();
					if (fail) {
						this.failed += 1;
						if (refetch) this.refetchFailed = true;
						reject(new Error('network down'));
						return;
					}
					const state = produce();
					const answer: Answer = { ns, kind, start, arrival, state };
					this.answers.get(ns)?.push(answer);
					this.byState.set(state, answer);
					resolve(state);
				},
			};
			this.pending.push(event);
		});
	}
}

/** A fake auth server for one API namespace, and the generated-client-like API object for it. */
class Server {
	readonly api: AuthStateApi;
	private tokens = new Map<string, string>();
	private jar: string | null = null;
	private issued = 0;
	constructor(
		private world: World,
		readonly ns: string,
		private mode: Mode,
		initialUser: string | null,
	) {
		world.answers.set(ns, []);
		world.sessions.set(ns, []);
		if (initialUser) this.issue(initialUser);
		const read = (sent: string | null) => {
			const user = sent !== null ? this.tokens.get(sent) : undefined;
			return user !== undefined ? signedIn(ns, user) : signedOut();
		};
		const api: AuthStateApi = {
			getAuthState: () => {
				world.reads += 1;
				const start = world.tick();
				const fail = world.takeFail();
				const sent = this.jar;
				const early = this.mode === 'naive' && !fail ? read(sent) : undefined;
				return world.request(`${ns}.read@${start}`, ns, 'read', start, fail, () => early ?? read(sent));
			},
			setAuthState: (input: AuthActionInput) => {
				world.actions += 1;
				const start = world.tick();
				const fail = world.takeFail();
				const { kind, effect, answer } = this.respond(input);
				if (this.mode === 'naive' && !fail) effect();
				return world.request(`${ns}.${input.action}@${start}`, ns, kind, start, fail, () => {
					if (this.mode === 'cookie') effect();
					return answer();
				});
			},
		};
		this.api = Object.assign(api, { [Symbol.for('aws-blocks.apiNamespace')]: ns });
	}
	private issue(user: string) {
		this.issued += 1;
		const token = `${this.ns}-${this.issued}`;
		this.tokens.set(token, user);
		this.jar = token;
		this.logSession();
	}
	private end() {
		if (this.jar !== null) this.tokens.delete(this.jar);
		this.jar = null;
		this.logSession();
	}
	private logSession() {
		this.world.sessions.get(this.ns)?.push({ seq: this.world.bump(), user: this.user() });
	}
	/** How the server answers each action this test sends. */
	private respond(input: AuthActionInput): { kind: Kind; effect: () => void; answer: () => AuthState } {
		const none = () => {};
		if (input.action === 'signOut') return { kind: 'session', effect: () => this.end(), answer: () => signedOut() };
		if (input.action === 'signIn' && input.password === 'ok') {
			return { kind: 'session', effect: () => this.issue('alice'), answer: () => signedIn(this.ns, 'alice') };
		}
		if (input.action === 'signIn' && input.password === 'mfa') {
			return { kind: 'flow', effect: none, answer: confirmingSignIn };
		}
		if (input.action === 'resendSignUpCode' || input.action === 'signUp') {
			return { kind: 'flow', effect: none, answer: confirmingSignUp };
		}
		return { kind: 'flow', effect: none, answer: () => signedOut('Incorrect username or password.') };
	}
	/** The user a fresh `getAuthState()` would see now: the session's truth. */
	user(): string | null {
		return this.jar !== null ? (this.tokens.get(this.jar) ?? null) : null;
	}
	/** The session ends on the server without anyone being told (it timed out). */
	expire() {
		if (this.jar !== null) this.tokens.delete(this.jar);
		this.logSession();
	}
	/** Another tab's sign-in landed: its cookie is now the jar's. */
	otherTabSignsIn(user: string) {
		this.issue(user);
	}
	/** Another tab's sign-out landed. */
	otherTabSignsOut() {
		this.end();
	}
}

// ---------------------------------------------------------------------------
// The oracle — the store's rule, written from DESIGN.md over the answers received
// ---------------------------------------------------------------------------

/**
 * What the store must show after `answers` (every answer this tab received for
 * one API, in any order):
 *
 * - the newest session answer, where a read counts from when it was sent and
 *   a session action from when its answer arrived — if it is signed in (but
 *   while a live flow answer is under it, the store re-reads, and the flow
 *   stays shown if it was shown);
 * - else this tab's place in its flow: the latest-arriving flow answer that is
 *   not moot (the session was seen signed in after it was sent — a signed-in
 *   read sent later — or changed here after it was sent — a session action
 *   answered later);
 * - else the newest session answer;
 * - nothing before any answer.
 */
function expectedFromRule(answers: readonly Answer[]): AuthState | null {
	// Folded in arrival order: while a flow is under a signed-in answer sent
	// before it (the store is re-reading), what was shown stays shown.
	const key = (a: Answer) => (a.kind === 'read' ? a.start : a.arrival);
	const arrived = [...answers].sort((x, y) => x.arrival - y.arrival);
	let shown: AuthState | null = null;
	for (let i = 0; i < arrived.length; i++) {
		const known = arrived.slice(0, i + 1);
		let session: Answer | undefined;
		for (const a of known) {
			if (a.kind !== 'flow' && (!session || key(a) > key(session))) session = a;
		}
		const step = liveStep(known);
		if (session?.state.state === 'signedIn') shown = step && shown === step.state ? step.state : session.state;
		else shown = step?.state ?? session?.state ?? shown;
	}
	return shown;
}

/** The step the tab is still in, if any (see {@link expectedFromRule}). */
function liveStep(answers: readonly Answer[]): Answer | undefined {
	const moot = (f: Answer) =>
		answers.some(
			(a) =>
				(a.kind === 'session' && a.arrival > f.start) ||
				(a.kind === 'read' && a.state.state === 'signedIn' && a.start > f.start),
		);
	let step: Answer | undefined;
	for (const a of answers) if (a.kind === 'flow' && !moot(a) && (!step || a.arrival > step.arrival)) step = a;
	return step;
}

// ---------------------------------------------------------------------------
// One run: a world, the mounted views, scripted operations
// ---------------------------------------------------------------------------

interface Op {
	label: string;
	ns: string;
	steps: { name: string; run(r: Run): void }[];
}

interface RunConfig {
	mode: Mode;
	/** Initial session user per API namespace. */
	initial: Record<string, string | null>;
	/** Hydration still in flight when the operations start (and whether it fails); else hydrated. */
	cold?: { fail: boolean };
	/** A step the tab is already in when the operations start (e.g. after a sign-up). */
	startIn?: { ns: string; action: AuthActionInput };
	ops: Op[];
	/** Mount an `Authenticator` too (for the DOM checks of the named scenarios). */
	dom?: boolean;
}

class Run {
	world = new World();
	servers = new Map<string, Server>();
	snaps = new Map<string, AuthState[]>();
	users = new Map<string, (AuthUser | null)[]>();
	/** Per API: every `onAuthChange` emission, in the world's order. */
	emissions = new Map<string, { seq: number; user: string | null; broadcast: boolean }[]>();
	/** Per API: the user the last delivered broadcast named. */
	lastBroadcast = new Map<string, string | null>();
	dom = new Map<string, HTMLElement>();
	trace: string[] = [];
	problems: string[] = [];
	private stops: (() => void)[] = [];
	private next: number[];
	private shown = new Map<string, boolean>();
	constructor(readonly cfg: RunConfig) {
		for (const [ns, user] of Object.entries(cfg.initial)) {
			this.servers.set(ns, new Server(this.world, ns, cfg.mode, user));
		}
		this.next = cfg.ops.map(() => 0);
	}
	api(ns: string): AuthStateApi {
		const s = this.servers.get(ns);
		assert.ok(s);
		return s.api;
	}
	server(ns: string): Server {
		const s = this.servers.get(ns);
		assert.ok(s);
		return s;
	}
	async start() {
		for (const ns of this.servers.keys()) {
			const api = this.api(ns);
			const snaps: AuthState[] = [];
			const users: (AuthUser | null)[] = [];
			this.snaps.set(ns, snaps);
			this.users.set(ns, users);
			this.world.failNext = this.cfg.cold?.fail ?? false;
			this.stops.push(
				subscribeAuthState(api, (s) => {
					snaps.push(s);
					if (getAuthStateSnapshot(api) !== s)
						this.problems.push(`${ns}: a listener was called with a state the snapshot does not hold`);
				}),
			);
			this.world.failNext = false;
			const emissions: { seq: number; user: string | null; broadcast: boolean }[] = [];
			this.emissions.set(ns, emissions);
			this.stops.push(
				onAuthChange(api, (u) => {
					users.push(u);
					emissions.push({
						seq: this.world.bump(),
						user: u?.username ?? null,
						broadcast: this.world.delivering,
					});
				}),
			);
			if (this.cfg.dom) this.dom.set(ns, Authenticator(api));
		}
		if (!this.cfg.cold) {
			for (const e of [...this.world.pending]) e.run();
			await flush();
		}
		if (this.cfg.startIn) {
			void submitAuthAction(this.api(this.cfg.startIn.ns), this.cfg.startIn.action).catch(() => {});
			for (const e of [...this.world.pending]) e.run();
			await flush();
		}
		this.check('start');
	}
	submit(ns: string, input: AuthActionInput, fail: boolean) {
		this.world.failNext = fail;
		void submitAuthAction(this.api(ns), input).catch(() => {});
		this.world.failNext = false;
	}
	/** The other tab's broadcast reaches this tab; the refetch it triggers fails when `fail`. */
	deliver(ns: string, user: AuthUser | null, fail: boolean) {
		this.world.deliveries += 1;
		this.lastBroadcast.set(ns, user?.username ?? null);
		this.world.failNext = fail;
		this.world.delivering = true;
		otherTab.postMessage({ type: 'auth-change', user, api: ns });
		this.world.delivering = false;
		this.world.failNext = false;
	}
	enabled(): Event[] {
		const events: Event[] = [];
		this.cfg.ops.forEach((op, i) => {
			const step = op.steps[this.next[i]];
			if (step) {
				events.push({
					label: `${op.label}.${step.name}`,
					run: () => {
						this.next[i] += 1;
						step.run(this);
					},
				});
			}
		});
		return [...events, ...this.world.pending];
	}
	async fire(e: Event) {
		this.trace.push(e.label);
		e.run();
		await flush();
		this.check(e.label);
	}
	/** Intermediate snapshots: no impossible state at any point. */
	private check(at: string) {
		for (const ns of this.servers.keys()) {
			const snapshot = getAuthStateSnapshot(this.api(ns));
			const answers = this.world.answers.get(ns) ?? [];
			const expected = expectedFromRule(answers);
			if (snapshot !== expected) {
				this.problems.push(
					`${ns} after ${at}: shows ${describeState(snapshot, this.world)}, rule says ${describeState(expected, this.world)}`,
				);
			}
			if (snapshot) this.shown.set(ns, true);
			else if (this.shown.get(ns)) this.problems.push(`${ns} after ${at}: the store was emptied`);
			if (snapshot && this.world.byState.get(snapshot)?.ns !== ns) {
				this.problems.push(`${ns} after ${at}: shows a state another API answered`);
			}
		}
	}
	/** After everything settled. */
	final() {
		for (const ns of this.servers.keys()) {
			const api = this.api(ns);
			const snapshot = getAuthStateSnapshot(api);
			const answers = this.world.answers.get(ns) ?? [];
			// The session's truth (a fresh read now), plus the step this tab is still in.
			if (this.world.failed === 0) {
				const user = this.server(ns).user();
				const step = liveStep(answers);
				let ok: boolean;
				let want: string;
				if (user !== null) {
					ok = snapshot?.state === 'signedIn' && snapshot.user?.username === `${ns}:${user}`;
					want = `signedIn ${ns}:${user}`;
				} else if (step) {
					ok = snapshot === step.state;
					want = describeState(step.state, this.world);
				} else {
					ok = snapshot?.state === 'signedOut' && this.world.byState.get(snapshot)?.kind !== 'flow';
					want = 'signedOut (session)';
				}
				if (!ok)
					this.problems.push(`${ns} settled: shows ${describeState(snapshot, this.world)}, truth is ${want}`);
			}
			// The two views agree. When a refetch for another tab's broadcast
			// failed, that broadcast is newer than anything the store knows, so
			// `onAuthChange` may still hold it; and while the store knows nothing
			// (every read failed) it may hold any broadcast.
			const users = this.users.get(ns) ?? [];
			const last = users.length > 0 ? (users[users.length - 1]?.username ?? null) : undefined;
			const fromStore = snapshot ? (snapshot.user?.username ?? null) : undefined;
			const heldBroadcast = this.world.refetchFailed && last === this.lastBroadcast.get(ns);
			if (snapshot && last !== fromStore && !heldBroadcast) {
				this.problems.push(
					`${ns} settled: onAuthChange says ${String(last)}, the store says ${String(fromStore)}`,
				);
			}
			// `onAuthChange` against the server's session (cookie timing): once it
			// reported a sign-out the server had made, it reports a user again only
			// after a sign-in on the server since then. Another tab's broadcast is
			// the exception: the wire format carries no time, so a late one is
			// delivered as it is (it names a sign-in that did happen) and the
			// refetch it triggers corrects it; the store's own answers never bring
			// back a user from before the sign-out. With naive timing a read is
			// answered as of when it was sent, so one sent just before another
			// tab's sign-out lands answers with the user and cannot be told from a
			// fresh one until that tab's broadcast arrives: the check does not apply.
			if (this.cfg.mode === 'cookie') this.checkSignOutsStick(ns);
			// Nothing crosses APIs.
			for (const u of users) {
				if (u !== null && !u.username.startsWith(`${ns}:`))
					this.problems.push(`${ns}: onAuthChange got ${u.username}`);
			}
			for (const s of this.snaps.get(ns) ?? []) {
				if (this.world.byState.get(s)?.ns !== ns)
					this.problems.push(`${ns}: a store listener got another API's state`);
			}
		}
	}
	/** See `final`: a sign-out `onAuthChange` reported stays until a sign-in. */
	private checkSignOutsStick(ns: string) {
		const sessions = this.world.sessions.get(ns) ?? [];
		const userAt = (seq: number) => {
			let user: string | null = null;
			for (const e of sessions) if (e.seq < seq) user = e.user;
			return user;
		};
		let signedOutSeen: number | undefined;
		for (const e of this.emissions.get(ns) ?? []) {
			if (e.user === null) {
				if (userAt(e.seq) === null) signedOutSeen = e.seq;
			} else if (e.broadcast) {
				const named = e.user;
				if (!sessions.some((x) => x.seq < e.seq && `${ns}:${x.user}` === named)) {
					this.problems.push(`${ns} settled: onAuthChange got a broadcast of ${named}, who never signed in`);
				}
			} else if (signedOutSeen !== undefined) {
				const from = signedOutSeen;
				if (!sessions.some((x) => x.user !== null && x.seq > from && x.seq < e.seq)) {
					this.problems.push(
						`${ns} settled: onAuthChange reported ${e.user} after a sign-out, with no sign-in since`,
					);
				}
			}
		}
	}
	/** Requests are bounded: no read without a cause (no endless re-reads). */
	checkBounded() {
		const w = this.world;
		const bound = this.servers.size + w.deliveries + w.actions + w.failed;
		if (w.reads > bound) {
			this.problems.push(`settled: ${w.reads} reads, more than the ${bound} its causes allow`);
		}
	}
	dispose() {
		for (const stop of this.stops) stop();
	}
}

function describeState(s: AuthState | null, world: World): string {
	if (!s) return 'nothing';
	const a = world.byState.get(s);
	const who = s.user ? ` ${s.user.username}` : '';
	const err = s.error ? ' (error)' : '';
	return `${s.state}${who}${err}${a ? ` [${a.kind} ${a.start}→${a.arrival}]` : ''}`;
}

/** More events than any run of three operations needs: a run this long is looping. */
const MAX_EVENTS = 60;

/**
 * Run every interleaving of `cfg`'s events (depth-first, each path replayed
 * from a fresh world). Returns the number of runs and the failing ones.
 */
async function explore(cfg: RunConfig, inspect?: (r: Run) => void, deadline = Number.POSITIVE_INFINITY) {
	let prefix: number[] = [];
	let timedOut = false;
	let runs = 0;
	let failed = 0;
	let endedWrong = 0;
	const failures: string[] = [];
	for (;;) {
		if (performance.now() > deadline) {
			timedOut = true;
			break;
		}
		const run = new Run(cfg);
		await run.start();
		const path: number[] = [];
		const widths: number[] = [];
		let looping = false;
		for (;;) {
			if (path.length >= MAX_EVENTS) {
				run.problems.push(`settled: did not settle within ${MAX_EVENTS} events (endless re-reads?)`);
				looping = true;
				break;
			}
			let events = run.enabled();
			if (events.length === 0) {
				await flush(200);
				events = run.enabled();
				if (events.length === 0) break;
			}
			const depth = path.length;
			const choice = depth < prefix.length ? (prefix[depth] ?? 0) : 0;
			path.push(choice);
			widths.push(events.length);
			const event = events[choice];
			assert.ok(event);
			await run.fire(event);
		}
		run.final();
		run.checkBounded();
		inspect?.(run);
		run.dispose();
		runs += 1;
		if (run.problems.length > 0) {
			failed += 1;
			if (
				run.problems.some(
					(p) => p.includes('settled: ') || p.includes(': onAuthChange got') || p.includes('listener got'),
				)
			)
				endedWrong += 1;
			if (failures.length < 20)
				failures.push(`${cfg.mode} ${run.trace.join(' → ')}\n    ${[...new Set(run.problems)].join('\n    ')}`);
		}
		// A looping run's tree has no end: report it and stop this operation set.
		if (looping) break;
		let i = path.length - 1;
		while (i >= 0 && (path[i] ?? 0) + 1 >= (widths[i] ?? 0)) i--;
		if (i < 0) break;
		prefix = [...path.slice(0, i), (path[i] ?? 0) + 1];
	}
	return { runs, failed, endedWrong, failures, timedOut };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const ok: AuthActionInput = { action: 'signIn', username: 'alice', password: 'ok' };
const mfa: AuthActionInput = { action: 'signIn', username: 'alice', password: 'mfa' };
const bad: AuthActionInput = { action: 'signIn', username: 'alice', password: 'bad' };
const out: AuthActionInput = { action: 'signOut' };
const resend: AuthActionInput = { action: 'resendSignUpCode', username: 'alice' };

const ops = {
	/** A submit here whose answer is terminal: a sign-in, a sign-out, a failed sign-in. */
	signIn: (ns: string, fail = false): Op => ({
		label: `${ns}:signIn${fail ? '✗' : ''}`,
		ns,
		steps: [{ name: 'send', run: (r) => r.submit(ns, ok, fail) }],
	}),
	signOut: (ns: string): Op => ({
		label: `${ns}:signOut`,
		ns,
		steps: [{ name: 'send', run: (r) => r.submit(ns, out, false) }],
	}),
	badSignIn: (ns: string): Op => ({
		label: `${ns}:badSignIn`,
		ns,
		steps: [{ name: 'send', run: (r) => r.submit(ns, bad, false) }],
	}),
	/** A submit here whose answer is a mid-flow step. */
	mfa: (ns: string, fail = false): Op => ({
		label: `${ns}:mfa${fail ? '✗' : ''}`,
		ns,
		steps: [{ name: 'send', run: (r) => r.submit(ns, mfa, fail) }],
	}),
	resend: (ns: string): Op => ({
		label: `${ns}:resend`,
		ns,
		steps: [{ name: 'send', run: (r) => r.submit(ns, resend, false) }],
	}),
	/** Another tab signs in (or out); its broadcast arrives later and this tab refetches. */
	otherSignIn: (ns: string, fail = false): Op => ({
		label: `${ns}:otherSignIn${fail ? '✗' : ''}`,
		ns,
		steps: [
			{ name: 'lands', run: (r) => r.server(ns).otherTabSignsIn('bob') },
			{ name: 'broadcast', run: (r) => r.deliver(ns, userOf(ns, 'bob'), fail) },
		],
	}),
	otherSignOut: (ns: string, fail = false): Op => ({
		label: `${ns}:otherSignOut${fail ? '✗' : ''}`,
		ns,
		steps: [
			{ name: 'lands', run: (r) => r.server(ns).otherTabSignsOut() },
			{ name: 'broadcast', run: (r) => r.deliver(ns, null, fail) },
		],
	}),
	/** The session times out on the server, then the user signs in again and gets an MFA step. */
	reauth: (ns: string): Op => ({
		label: `${ns}:reauth`,
		ns,
		steps: [
			{ name: 'expires', run: (r) => r.server(ns).expire() },
			{ name: 'send', run: (r) => r.submit(ns, mfa, false) },
		],
	}),
};

type OpMaker = (ns: string) => Op;

const allKinds: OpMaker[] = [
	(ns) => ops.signIn(ns),
	(ns) => ops.signOut(ns),
	(ns) => ops.badSignIn(ns),
	(ns) => ops.signIn(ns, true),
	(ns) => ops.mfa(ns),
	(ns) => ops.resend(ns),
	(ns) => ops.mfa(ns, true),
	(ns) => ops.otherSignIn(ns),
	(ns) => ops.otherSignOut(ns),
	(ns) => ops.otherSignIn(ns, true),
	(ns) => ops.otherSignOut(ns, true),
	(ns) => ops.reauth(ns),
];

/** Multisets of size `k` drawn from `items`. */
function multisets<T>(items: readonly T[], k: number, from = 0): T[][] {
	if (k === 0) return [[]];
	const out: T[][] = [];
	for (let i = from; i < items.length; i++) {
		const item = items[i];
		if (item === undefined) continue;
		for (const rest of multisets(items, k - 1, i)) out.push([item, ...rest]);
	}
	return out;
}

async function exploreAll(configs: RunConfig[], deadline = Number.POSITIVE_INFINITY) {
	let runs = 0;
	let failed = 0;
	let endedWrong = 0;
	let timedOut = false;
	const failures: string[] = [];
	for (const cfg of configs) {
		const r = await explore(cfg, undefined, deadline);
		if (r.timedOut) timedOut = true;
		runs += r.runs;
		failed += r.failed;
		endedWrong += r.endedWrong;
		if (failures.length < 20) failures.push(...r.failures.slice(0, 20 - failures.length));
	}
	return { runs, failed, endedWrong, failures, timedOut };
}

/**
 * Fails with the first counterexamples when any run broke the rule: at some
 * point, or (`endedWrong`) once settled — stale, the two views disagreeing, or
 * something crossing APIs.
 */
function assertAllHeld({
	runs,
	failed,
	endedWrong,
	failures,
	timedOut = false,
}: {
	runs: number;
	failed: number;
	endedWrong: number;
	failures: string[];
	timedOut?: boolean;
}) {
	assert.ok(!timedOut, `the enumeration did not finish within its time budget (${runs} runs done)`);
	assert.ok(runs > 0, 'no runs');
	assert.strictEqual(
		failed,
		0,
		`${failed} of ${runs} runs broke the rule (${endedWrong} ended wrong once settled); first ones:\n  ${failures.slice(0, 8).join('\n  ')}`,
	);
}

const modes: Mode[] = ['cookie', 'naive'];
const initials: (string | null)[] = [null, 'alice'];

const full = process.env.AUTH_STORE_RACES_FULL === '1';

/** The operation sets one enumeration test explores. */
function enumerationConfigs(mode: Mode, apis: 1 | 2): { name: string; configs: RunConfig[]; skip?: string }[] {
	if (apis === 1) {
		const hydrated: RunConfig[] = [];
		const cold: RunConfig[] = [];
		for (const initial of initials) {
			for (let k = 1; k <= 3; k++) {
				for (const set of multisets(allKinds, k)) {
					hydrated.push({ mode, initial: { a: initial }, ops: set.map((make) => make('a')) });
				}
			}
			for (const fail of [false, true]) {
				for (let k = 0; k <= 2; k++) {
					for (const set of multisets(allKinds, k)) {
						cold.push({ mode, initial: { a: initial }, cold: { fail }, ops: set.map((make) => make('a')) });
					}
				}
			}
		}
		return [
			{ name: 'hydrated: up to three operations of every kind', configs: hydrated },
			{ name: 'hydration in flight, landing or failing: plus up to two operations of every kind', configs: cold },
		];
	}
	const two: RunConfig[] = [];
	const three: RunConfig[] = [];
	for (const initial of initials) {
		for (let k = 1; k <= 2; k++) {
			for (const set of multisets(allKinds, k)) {
				// Every placement of the operations on API a or b, b used at least once.
				for (let mask = 1; mask < 1 << set.length; mask++) {
					two.push({
						mode,
						initial: { a: initial, b: initial },
						ops: set.map((make, i) => make(mask & (1 << i) ? 'b' : 'a')),
					});
				}
			}
		}
		for (const set of full ? multisets(allKinds, 3) : []) {
			for (let mask = 1; mask < 8; mask++) {
				three.push({
					mode,
					initial: { a: initial, b: initial },
					ops: set.map((make, i) => make(mask & (1 << i) ? 'b' : 'a')),
				});
			}
		}
	}
	return [
		{ name: 'up to two operations of every kind, on either API; nothing crosses APIs', configs: two },
		{
			name: 'three operations of every kind split across both APIs; nothing crosses APIs',
			configs: three,
			skip: full ? undefined : 'about 8.6 million interleavings: runs with AUTH_STORE_RACES_FULL=1',
		},
	];
}

/**
 * Every interleaving of up to three operations, in one timing, on one API or
 * spread over two. The runs happen before the tests are declared: inside a
 * test callback, the runner's async-context tracking makes each promise far
 * slower, and the enumeration awaits millions of them.
 */
export async function describeEnumeration(mode: Mode, apis: 1 | 2): Promise<void> {
	const results: {
		name: string;
		skip?: string;
		sets: number;
		ms: number;
		result: Awaited<ReturnType<typeof exploreAll>>;
	}[] = [];
	for (const { name, configs, skip } of enumerationConfigs(mode, apis)) {
		const started = performance.now();
		// The time budget is enforced here, between runs: a test's `timeout`
		// cannot bound work done before the test is declared. A run that loops
		// is cut at MAX_EVENTS.
		const result = await exploreAll(skip ? [] : configs, started + BUDGET_MS);
		results.push({ name, skip, sets: configs.length, ms: Math.round(performance.now() - started), result });
	}
	describe(`auth-state store races (${mode} timing, ${apis} API${apis === 2 ? 's' : ''}): every interleaving`, () => {
		for (const { name, skip, sets, ms, result } of results) {
			test(name, { skip }, (t) => {
				t.diagnostic(`${sets} operation sets, ${result.runs} interleavings, ${ms} ms`);
				assertAllHeld(result);
			});
		}
	});
}

/** Time budget per enumeration test, well above what the store needs. */
const BUDGET_MS = full ? 900_000 : 120_000;

// ---------------------------------------------------------------------------
// Named scenarios (every interleaving of each, both timings)
// ---------------------------------------------------------------------------

export function testId(root: ParentNode | undefined, id: string) {
	return root?.querySelector(`[data-testid="${id}"]`) ?? null;
}

/** Explore `cfg` in both timings; `expect` returns what is wrong with a settled run, if anything. */
export async function scenario(cfg: Omit<RunConfig, 'mode'>, expect: (r: Run) => string | undefined) {
	for (const mode of modes) {
		let runs = 0;
		const failures: string[] = [];
		const result = await explore({ ...cfg, mode }, (r) => {
			runs += 1;
			const wrong = expect(r);
			if (wrong) r.problems.push(`settled: ${wrong}`);
		});
		assert.strictEqual(result.runs, runs);
		failures.push(...result.failures);
		assertAllHeld({ ...result, failures });
	}
}

export const signUp: AuthActionInput = { action: 'signUp', username: 'alice', password: 'pw' };

export { type Run, type RunConfig, assertAllHeld, describeState, explore, getAuthStateSnapshot, initials, modes, ops };
