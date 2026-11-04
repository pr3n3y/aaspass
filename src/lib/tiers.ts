export type Tier = {
  minParticipants: number;
  pricePaise: number;
};

export function sortTiers(tiers: Tier[]): Tier[] {
  return [...tiers].sort((a, b) => a.minParticipants - b.minParticipants);
}

/** Best tier whose minimum has been reached. Null when nobody has reached the first tier. */
export function bestTier(tiers: Tier[], participants: number): Tier | null {
  let best: Tier | null = null;
  for (const tier of sortTiers(tiers)) {
    if (participants >= tier.minParticipants) best = tier;
  }
  return best;
}

export function nextTier(tiers: Tier[], participants: number): Tier | null {
  return sortTiers(tiers).find((tier) => tier.minParticipants > participants) ?? null;
}

/** Price a joiner pays right now. Uses the unlocked tier, or the first tier if none is unlocked yet. */
export function priceForParticipants(tiers: Tier[], participants: number): number {
  const best = bestTier(tiers, participants);
  if (best) return best.pricePaise;
  return sortTiers(tiers)[0]?.pricePaise ?? 0;
}

export function neighboursUntilNextTier(tiers: Tier[], participants: number): number | null {
  const next = nextTier(tiers, participants);
  if (!next) return null;
  return Math.max(0, next.minParticipants - participants);
}

export function progressGoal(tiers: Tier[], minParticipants: number): number {
  const sorted = sortTiers(tiers);
  const top = sorted[sorted.length - 1]?.minParticipants ?? minParticipants;
  return Math.max(top, minParticipants, 1);
}

export type CutoffDecision = {
  status: 'CONFIRMED' | 'CANCELLED';
  pricePaise: number | null;
};

/** Pure cutoff rule. Confirmed price is the best tier reached. Cancelled deals charge nothing. */
export function decideCutoff(input: {
  participantCount: number;
  minParticipants: number;
  tiers: Tier[];
}): CutoffDecision {
  if (input.participantCount >= input.minParticipants && input.participantCount > 0) {
    return {
      status: 'CONFIRMED',
      pricePaise: priceForParticipants(input.tiers, input.participantCount),
    };
  }
  return { status: 'CANCELLED', pricePaise: null };
}
