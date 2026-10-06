import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CapabilityId, CapabilityPlan, SupportTier } from '../plan/types.js';
import { enforceNegotiation, type NegotiationMode } from './negotiation_policy.js';

// A plan that demands SSR (hasServer → RunServerRender + AtomicRelease).
const ssrPlan: CapabilityPlan = {
	origins: [
		{ id: 'blocks-s3', kind: 'static' },
		{ id: 'blocks-server', kind: 'server' },
	],
	routes: { entries: [{ pattern: '/*', kind: 'server' }], redirects: [], headers: [] },
	policies: { spaFallback: false, hasServer: true, skewEnabled: false },
	release: { buildId: 'b' },
};

const door = (tiers: Partial<Record<CapabilityId, SupportTier>>) => {
	let calls = 0;
	return {
		service: 'test-door',
		supports(cap: CapabilityId): SupportTier {
			calls++;
			return tiers[cap] ?? 'core';
		},
		get calls() {
			return calls;
		},
	};
};

const opts = (negotiation?: NegotiationMode, degrade?: CapabilityId[]) => ({
	negotiation,
	degrade,
	errorCode: 'CapabilityNotSupportedError',
	resolution: 'pick another door',
});

describe('enforceNegotiation', () => {
	it('strict (default) throws on a demanded unsupported capability', () => {
		assert.throws(
			() => enforceNegotiation(ssrPlan, door({ RunServerRender: 'unsupported' }), opts()),
			(e: Error & { code?: string }) =>
				e.code === 'CapabilityNotSupportedError' && /RunServerRender/.test(e.message),
		);
	});

	it('strict throws on a demanded degraded capability not listed in degrade', () => {
		assert.throws(() => enforceNegotiation(ssrPlan, door({ RunServerRender: 'degraded' }), opts('strict')));
	});

	it('strict accepts a degraded capability listed in degrade', () => {
		assert.doesNotThrow(() =>
			enforceNegotiation(ssrPlan, door({ RunServerRender: 'degraded' }), opts('strict', ['RunServerRender'])),
		);
	});

	it('warn reports but does not throw', () => {
		assert.doesNotThrow(() => enforceNegotiation(ssrPlan, door({ RunServerRender: 'unsupported' }), opts('warn')));
	});

	it('off skips the check without consulting supports()', () => {
		const d = door({ RunServerRender: 'unsupported' });
		enforceNegotiation(ssrPlan, d, opts('off'));
		assert.equal(d.calls, 0);
	});

	it('rejects an unknown mode', () => {
		assert.throws(
			() => enforceNegotiation(ssrPlan, door({}), opts('lenient' as NegotiationMode)),
			(e: Error & { code?: string }) => e.code === 'InvalidPropsError',
		);
	});
});
