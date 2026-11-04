export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: number };
    const offset = parsed.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) return 0;
    return offset;
  } catch {
    return 0;
  }
}
