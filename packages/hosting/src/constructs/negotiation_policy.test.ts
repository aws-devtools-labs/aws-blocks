import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveNegotiationMode, settleUnmetCapabilities } from './negotiation_policy.js';

const opts = { errorCode: 'CapabilityNotSupportedError', resolution: 'pick another door' } as const;

describe('resolveNegotiationMode', () => {
	it("defaults to 'strict'", () => {
		assert.equal(resolveNegotiationMode(undefined, 'd'), 'strict');
	});

	it('accepts every known mode', () => {
		for (const m of ['strict', 'warn', 'off'] as const) assert.equal(resolveNegotiationMode(m, 'd'), m);
	});

	it('rejects an unknown mode with InvalidPropsError', () => {
		assert.throws(() => resolveNegotiationMode('loose' as never, 'd'), /Unknown negotiation mode 'loose'/);
	});
});

describe('settleUnmetCapabilities', () => {
	it('strict throws on an unmet capability, naming it', () => {
		assert.throws(
			() => settleUnmetCapabilities('test-door', ['RunServerRender'], { ...opts, mode: 'strict' }),
			(e: Error) => e.name === 'CapabilityNotSupportedError' && /RunServerRender/.test(e.message),
		);
	});

	it('strict passes when every unmet capability is waived via degrade', () => {
		const r = settleUnmetCapabilities('test-door', ['RunServerRender'], {
			...opts,
			mode: 'strict',
			degrade: ['RunServerRender'],
		});
		assert.deepEqual(r.errors, []);
		assert.deepEqual(r.warnings, [{ capability: 'RunServerRender' }]);
	});

	it('warn reports unmet capabilities without throwing', () => {
		const r = settleUnmetCapabilities('test-door', ['RunServerRender', 'Alarms'], { ...opts, mode: 'warn' });
		assert.deepEqual(
			r.errors.map((e) => e.capability),
			['RunServerRender', 'Alarms'],
		);
	});

	it('nothing unmet → nothing reported', () => {
		const r = settleUnmetCapabilities('test-door', [], { ...opts, mode: 'strict' });
		assert.deepEqual(r, { errors: [], warnings: [] });
	});
});
