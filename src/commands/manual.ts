// The full reference. Reads the same data `help` does, so the two cannot drift.

import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { COMMANDS, GLOBAL_FLAGS } from '../lib/reference.ts';
import { PKG_VERSION } from '../lib/pkg.ts';
import { bold, dim } from '../ui/colors.ts';

export default async function manual(args: Args): Promise<void> {
  if (hasFlag(args, 'json')) {
    writeJson({ version: PKG_VERSION, commands: COMMANDS, globalFlags: GLOBAL_FLAGS });
    return;
  }

  const out: string[] = [];
  out.push(bold(`ada ${PKG_VERSION} — reference`));
  out.push('');
  out.push(bold('GLOBAL FLAGS'));
  const width = GLOBAL_FLAGS.reduce((m, f) => Math.max(m, f.flag.length), 0);
  for (const f of GLOBAL_FLAGS) out.push(`  ${f.flag.padEnd(width)}  ${f.description}`);
  out.push('');

  for (const c of COMMANDS.filter((x) => x.implemented)) {
    out.push(bold(c.usage));
    out.push(`  ${c.summary}`);
    if (c.detail) {
      out.push('');
      for (const line of wrap(c.detail, 76)) out.push(`  ${line}`);
    }
    if (c.flags?.length) {
      out.push('');
      const fw = c.flags.reduce((m, f) => Math.max(m, f.flag.length), 0);
      for (const f of c.flags) out.push(`  ${f.flag.padEnd(fw)}  ${dim(f.description)}`);
    }
    if (c.examples?.length) {
      out.push('');
      for (const e of c.examples) out.push(`  ${dim('$')} ${e}`);
    }
    out.push('');
  }
  process.stdout.write(out.join('\n'));
}

/** Wrap prose at a column, preserving paragraph breaks. */
function wrap(text: string, columns: number): string[] {
  return text.split('\n\n').flatMap((para, i, all) => {
    const lines: string[] = [];
    let current = '';
    for (const word of para.split(/\s+/)) {
      if (current === '') current = word;
      else if (current.length + 1 + word.length <= columns) current += ` ${word}`;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    return i < all.length - 1 ? [...lines, ''] : lines;
  });
}
