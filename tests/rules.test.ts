import assert from 'node:assert/strict';
import test from 'node:test';
import { decideCutoff, bestTier, neighboursUntilNextTier, priceForParticipants } from '../src/lib/tiers.ts';
import { assertSameSociety } from '../src/lib/guards.ts';
import { ApiError } from '../src/lib/errors.ts';
import { isIndianMobile, normalizePhone } from '../src/lib/crypto.ts';

const milkTiers = [
  { minParticipants: 1, pricePaise: 6000 },
  { minParticipants: 2, pricePaise: 4800 },
];

test('one neighbour stays on the first milk tier', () => {
  assert.equal(priceForParticipants(milkTiers, 1), 6000);
  assert.equal(bestTier(milkTiers, 1)?.pricePaise, 6000);
  assert.equal(neighboursUntilNextTier(milkTiers, 1), 1);
});

test('second neighbour unlocks the cheaper tier', () => {
  assert.equal(priceForParticipants(milkTiers, 2), 4800);
  assert.equal(bestTier(milkTiers, 2)?.minParticipants, 2);
  assert.equal(neighboursUntilNextTier(milkTiers, 2), null);
});

test('cutoff confirms at the best tier and cancels below the minimum', () => {
  assert.deepEqual(
    decideCutoff({ participantCount: 2, minParticipants: 2, tiers: milkTiers }),
    { status: 'CONFIRMED', pricePaise: 4800 },
  );
  assert.deepEqual(
    decideCutoff({ participantCount: 1, minParticipants: 2, tiers: milkTiers }),
    { status: 'CANCELLED', pricePaise: null },
  );
  assert.deepEqual(
    decideCutoff({ participantCount: 0, minParticipants: 1, tiers: milkTiers }),
    { status: 'CANCELLED', pricePaise: null },
  );
});

test('a resident cannot read another society', () => {
  assert.doesNotThrow(() =>
    assertSameSociety({ role: 'RESIDENT', societyId: 'society-a' }, 'society-a'),
  );
  assert.throws(
    () => assertSameSociety({ role: 'RESIDENT', societyId: 'society-a' }, 'society-b'),
    (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN',
  );
  assert.throws(
    () => assertSameSociety({ role: 'RESIDENT', societyId: null }, 'society-a'),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  assert.doesNotThrow(() =>
    assertSameSociety({ role: 'SUPER_ADMIN', societyId: null }, 'society-b'),
  );
});

test('phone numbers are stored as +91 mobiles', () => {
  assert.equal(normalizePhone('9876543210'), '+919876543210');
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
  assert.equal(isIndianMobile('+919876543210'), true);
  assert.equal(isIndianMobile('+911234567890'), false);
});
