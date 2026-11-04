const BANNED = [
  'gun',
  'pistol',
  'rifle',
  'bomb',
  'explosive',
  'cocaine',
  'heroin',
  'mdma',
  'opium',
  'ganja',
  'hashish',
  'porn',
];

export function containsProhibited(text: string): boolean {
  const folded = text.toLowerCase();
  return BANNED.some((word) => folded.includes(word));
}

export function sponsoredSlotCount(organicCount: number): number {
  if (organicCount < 10) return 0;
  return Math.floor(organicCount / 10);
}
