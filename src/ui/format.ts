// Human-facing output only. Nothing here is called in --json mode.

import { bold, dim, red, green, yellow, cyan } from './colors.ts';

export function heading(text: string): string {
  return bold(text);
}

/** Aligned key/value block — the shape used by info, status and tip. */
export function fields(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [k]) => Math.max(max, k.length), 0);
  return rows.map(([k, v]) => `  ${dim(k.padEnd(width))}  ${v}`).join('\n');
}

export const ok = (text: string) => `${green('ok')} ${text}`;
export const warn = (text: string) => `${yellow('!')} ${text}`;

export function errorBlock(message: string, hint?: string, detail?: string): string {
  const lines = [`${red('error')} ${message}`];
  // The failing tool's own words come first: they are specific, where the hint
  // can only ever list what is usually wrong.
  if (detail) for (const line of detail.split('\n')) lines.push(`  ${line}`);
  if (hint) lines.push(`  ${dim(hint)}`);
  return lines.join('\n');
}

export const emphasis = cyan;
