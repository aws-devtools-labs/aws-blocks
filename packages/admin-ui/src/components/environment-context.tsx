// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { EnvironmentsResponse, MetaResponse } from '@/contract/v1';
import {
	type DataTarget,
	DEFAULT_ENVIRONMENT,
	dataTargetFor,
	ENVIRONMENT_STORAGE_KEY,
	type EnvironmentId,
	type EnvironmentStatus,
	environmentIdsFor,
	environmentStatuses,
	isLocalEnvironment,
	parseEnvironment,
	readStoredEnvironment,
	statusFor,
	writeStoredEnvironment,
} from '@/env/environment';
import { apiGet } from '@/lib/api-client';
import { deployCommandFor } from '@/lib/commands';

/**
 * Environment selection — the single axis that replaced the header's `stage` and
 * the two per-page `local | cloud` switches (D75).
 *
 * All the rules live in `@/env/environment` where unit tests can reach them; this
 * file is the React and storage plumbing only.
 */
interface EnvironmentContextValue {
	/** The selected environment: `local`, or the name of a deployed stage. */
	environment: EnvironmentId;
	setEnvironment: (id: EnvironmentId) => void;
	/**
	 * The deployed stage, or `undefined` in local.
	 *
	 * This is the gate for every cloud-only pillar: `undefined` means there is no
	 * stack to query, so the request is not issued at all rather than issued and
	 * explained away (D78 — a Logs Insights query and a Cost Explorer query are
	 * both billed).
	 */
	cloudStage: string | undefined;
	/** What the data, write and RPC endpoints should be told. */
	target: DataTarget;
	/**
	 * Whether the stored selection has been read yet.
	 *
	 * The environment is not applied before first paint the way the theme and the
	 * sidebar are, because nothing about it is expressed in CSS (D84). What it
	 * does decide is which requests fire, so a request made against the default
	 * before the stored value arrives is a request to the wrong environment —
	 * billed twice for Logs and Cost, and misleading in between. Every query keyed
	 * on the environment waits for this.
	 */
	ready: boolean;
	/** Availability of every environment, local first. */
	statuses: EnvironmentStatus[];
	/** Availability of the selected one. */
	status: EnvironmentStatus | undefined;
}

const EnvironmentContext = createContext<EnvironmentContextValue>({
	environment: DEFAULT_ENVIRONMENT,
	setEnvironment: () => {},
	cloudStage: DEFAULT_ENVIRONMENT,
	target: dataTargetFor(DEFAULT_ENVIRONMENT),
	ready: false,
	statuses: [],
	status: undefined,
});

export function EnvironmentProvider({ children }: { children: React.ReactNode }) {
	// The server renders the default and nothing is fetched until `ready`.
	const [environment, setEnvironmentState] = useState<EnvironmentId>(DEFAULT_ENVIRONMENT);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		// Guarded in the model: an exception escaping here unmounts the whole
		// dashboard, and an environment selection must never be able to do that.
		setEnvironmentState(readStoredEnvironment(() => window.sessionStorage.getItem(ENVIRONMENT_STORAGE_KEY)));
		setReady(true);
	}, []);

	// Both are shared, cached queries: the same keys the pages use, so putting
	// them here costs no extra request.
	const { data: meta } = useQuery({
		queryKey: ['meta'],
		queryFn: () => apiGet<MetaResponse>('/api/v1/meta'),
	});
	const { data: environments } = useQuery({
		queryKey: ['environments'],
		queryFn: () => apiGet<EnvironmentsResponse>('/api/v1/environments'),
	});

	const stages = useMemo(() => meta?.stages.map((stage) => stage.name) ?? [], [meta]);
	const knownIds = useMemo(() => environmentIdsFor(stages), [stages]);

	// Reconcile only once the offer is actually known. Guarded on a non-empty
	// stage list on purpose: if `/api/v1/meta` fails there is no offer to validate
	// against, and silently moving the reader to another environment because a
	// request failed would change what they are looking at while telling them
	// nothing. A stage that genuinely no longer exists is corrected here.
	useEffect(() => {
		if (stages.length === 0) return;
		setEnvironmentState((current) => parseEnvironment(current, knownIds));
	}, [stages.length, knownIds]);

	const setEnvironment = useCallback((next: EnvironmentId) => {
		writeStoredEnvironment((value) => window.sessionStorage.setItem(ENVIRONMENT_STORAGE_KEY, value), next);
		setEnvironmentState(next);
	}, []);

	const value = useMemo<EnvironmentContextValue>(() => {
		const statuses = environmentStatuses(stages, deployCommandFor, environments?.environments);
		return {
			environment,
			setEnvironment,
			cloudStage: isLocalEnvironment(environment) ? undefined : environment,
			target: dataTargetFor(environment),
			ready,
			statuses,
			status: statusFor(statuses, environment),
		};
	}, [environment, setEnvironment, ready, stages, environments]);

	return <EnvironmentContext.Provider value={value}>{children}</EnvironmentContext.Provider>;
}

export function useEnvironment() {
	return useContext(EnvironmentContext);
}
