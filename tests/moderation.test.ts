import assert from 'node:assert/strict';
import test from 'node:test';
import { containsProhibited, sponsoredSlotCount } from '../src/lib/moderation.ts';

test('blocks a prohibited listing word', () => {
  assert.equal(containsProhibited('old pistol for sale'), true);
  assert.equal(containsProhibited('wooden sofa'), false);
});

test('shows at most one sponsored card per ten organic items', () => {
  assert.equal(sponsoredSlotCount(9), 0);
  assert.equal(sponsoredSlotCount(10), 1);
  assert.equal(sponsoredSlotCount(25), 2);
});
