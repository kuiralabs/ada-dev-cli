// The --json contract: exactly one JSON document on stdout and nothing else.
// No banners, no spinners, no colour. Errors go to stderr as JSON too, so a
// caller parsing stdout never has to distinguish success from failure by
// guessing.

export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function writeJsonError(reason: string, message: string, hint?: string): void {
  process.stderr.write(
    JSON.stringify({ ok: false, reason, message, ...(hint ? { hint } : {}) }, null, 2) + '\n',
  );
}
