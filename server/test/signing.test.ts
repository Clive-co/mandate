import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  DecisionSigner,
  fromWire,
  newSignerKey,
  verifyDecision,
  type DecisionMessage,
} from '../src/signing';
import { parseUsdc } from '../src/units';
import { ALICE, BOB, TEST_SIGNER_KEY, USDC } from './fixtures';

const message: DecisionMessage = {
  requestId: 'req-1',
  agentId: 'agent-1',
  token: USDC,
  recipient: ALICE,
  amount: parseUsdc('12.5'),
  outcome: 'approved',
  decidedBy: 'policy',
  issuedAt: 1_700_000_000n,
};

describe('decision signing', () => {
  const signer = new DecisionSigner(TEST_SIGNER_KEY);

  it('signs a decision and verifies it', async () => {
    const signed = await signer.sign(message);
    expect(signed.signer).toBe(privateKeyToAccount(TEST_SIGNER_KEY).address);
    expect(signed.message.amount).toBe('12500000');
    expect(await signer.verify(fromWire(signed.message), signed.signature)).toBe(true);
  });

  it('is deterministic for the same message and key', async () => {
    const a = await signer.sign(message);
    const b = await signer.sign(message);
    expect(a.signature).toBe(b.signature);
  });

  it.each([
    ['amount', { amount: parseUsdc('12.6') }],
    ['recipient', { recipient: BOB }],
    ['outcome', { outcome: 'denied' as const }],
    ['requestId', { requestId: 'req-2' }],
    ['issuedAt', { issuedAt: 1_700_000_001n }],
  ])('rejects a decision whose %s was altered after signing', async (_field, change) => {
    const signed = await signer.sign(message);
    const tampered = { ...fromWire(signed.message), ...change };
    expect(await signer.verify(tampered, signed.signature)).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const other = new DecisionSigner(newSignerKey());
    const signed = await other.sign(message);
    expect(await signer.verify(message, signed.signature)).toBe(false);
  });

  it('lets a third party verify with only the signer address', async () => {
    const signed = await signer.sign(message);
    const ok = await verifyDecision(fromWire(signed.message), signed.signature, signer.address);
    expect(ok).toBe(true);
  });

  it('returns false (does not throw) for a malformed signature', async () => {
    expect(await signer.verify(message, '0xdeadbeef')).toBe(false);
  });

  it('rejects non-integer wire amounts', () => {
    const wire = { ...message, amount: '12.5', issuedAt: '1' };
    expect(() => fromWire(wire)).toThrow();
  });
});
