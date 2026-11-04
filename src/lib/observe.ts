/** Logs a failure without personal data. A Sentry SDK can wrap this later. */
export function captureError(error: unknown, context: Record<string, string> = {}): void {
  const message = error instanceof Error ? error.message : 'error';
  console.error(JSON.stringify({ msg: message, ...context }));
}
