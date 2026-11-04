// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { LogEntry, TailMessage } from '@/contract/v1';
import { getSessionToken } from '@/lib/api-client';

const MAX_RENDERED_LINES = 500;

const LEVEL_COLOR: Record<string, string> = {
	error: 'text-danger-fg',
	warn: 'text-warn-fg-strong',
	debug: 'text-fg-soft',
};

type TailStatus = 'idle' | 'connecting' | 'active' | 'ended' | 'error';

export function LiveTailPanel({ stage }: { stage: string }) {
	const [status, setStatus] = useState<TailStatus>('idle');
	const [statusDetail, setStatusDetail] = useState('');
	const [level, setLevel] = useState('');
	const [lines, setLines] = useState<LogEntry[]>([]);
	const [groups, setGroups] = useState<string[]>([]);
	const abortRef = useRef<AbortController | undefined>(undefined);
	const outputRef = useRef<HTMLDivElement>(null);

	// Stop the stream when the panel unmounts or the stage changes.
	useEffect(() => {
		return () => abortRef.current?.abort();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new lines only
	useEffect(() => {
		outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
	}, [lines]);

	const stop = () => {
		abortRef.current?.abort();
		abortRef.current = undefined;
	};

	const start = async () => {
		stop();
		const abort = new AbortController();
		abortRef.current = abort;
		setLines([]);
		setGroups([]);
		setStatus('connecting');
		setStatusDetail('');

		try {
			const token = getSessionToken();
			const params = new URLSearchParams({ stage, ...(level ? { level } : {}) });
			const response = await fetch(`/api/v1/logs/tail?${params}`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
				signal: abort.signal,
			});
			if (!response.body) throw new Error(`No response stream (status ${response.status})`);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					if (!part.trim()) continue;
					const msg = JSON.parse(part) as TailMessage;
					if (msg.type === 'session') {
						setStatus('active');
						setGroups(msg.groups);
					} else if (msg.type === 'event') {
						setLines((prev) => [...prev.slice(-(MAX_RENDERED_LINES - 1)), msg.entry]);
					} else if (msg.type === 'end') {
						setStatus('ended');
						setStatusDetail(msg.reason);
					} else if (msg.type === 'error') {
						setStatus('error');
						setStatusDetail(msg.message);
					}
				}
			}
			setStatus((s) => (s === 'active' || s === 'connecting' ? 'ended' : s));
		} catch (error) {
			if (abort.signal.aborted) {
				setStatus('ended');
				setStatusDetail('stopped');
			} else {
				setStatus('error');
				setStatusDetail(error instanceof Error ? error.message : String(error));
			}
		}
	};

	const running = status === 'connecting' || status === 'active';

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-3">
					<CardTitle className="text-base">Live Tail</CardTitle>
					{status === 'active' && <Badge variant="success">live · {groups.length} groups</Badge>}
					{status === 'connecting' && <Badge variant="warning">connecting…</Badge>}
					{status === 'ended' && <Badge variant="outline">ended{statusDetail ? ` · ${statusDetail}` : ''}</Badge>}
					<div className="ml-auto flex items-center gap-2">
						<select
							className="rounded-md border border-line bg-panel px-2 py-1 text-sm"
							value={level}
							onChange={(e) => setLevel(e.target.value)}
							disabled={running}
						>
							<option value="">any level</option>
							<option value="debug">debug</option>
							<option value="info">info</option>
							<option value="warn">warn</option>
							<option value="error">error</option>
						</select>
						{running ? (
							<button
								type="button"
								onClick={stop}
								className="rounded-md bg-danger/80 px-4 py-1.5 text-sm font-medium text-on-danger hover:bg-danger"
							>
								Stop
							</button>
						) : (
							<button
								type="button"
								onClick={start}
								className="rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-on-brand hover:bg-brand-dark"
							>
								Start tail
							</button>
						)}
					</div>
				</div>
				<CardDescription>
					Streams up to 10 log groups. Costs ~$0.01 per session-minute (~$0.60/hour); max 2 concurrent sessions,
					auto-stops after 15 minutes.
				</CardDescription>
			</CardHeader>
			{status === 'error' && (
				<CardContent>
					<p className="text-sm text-danger-fg">{statusDetail}</p>
				</CardContent>
			)}
			{(running || lines.length > 0) && status !== 'error' && (
				<CardContent>
					<div
						ref={outputRef}
						className="h-80 overflow-y-auto rounded-md border border-line bg-canvas p-3 font-mono text-xs leading-relaxed text-fg"
					>
						{lines.length === 0 && <p className="text-fg-soft">Waiting for log events…</p>}
						{lines.map((entry, i) => (
							<div key={`${entry.timestamp}-${i}`} className="whitespace-pre-wrap break-all">
								<span className="text-fg-soft">{entry.timestamp.slice(11, 23)}</span>{' '}
								<span className={entry.level ? (LEVEL_COLOR[entry.level] ?? 'text-ok-fg-strong') : 'text-fg-dim'}>
									{(entry.level ?? 'raw').padEnd(5)}
								</span>{' '}
								{entry.logger && <span className="text-info-fg">[{entry.logger}] </span>}
								{entry.message}
							</div>
						))}
					</div>
				</CardContent>
			)}
		</Card>
	);
}
