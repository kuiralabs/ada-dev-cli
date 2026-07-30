// Minimal argument parsing. Deliberately dependency-free: the surface is
// `ada <command> [subcommand] [positionals] [--flags]`, and a parser library
// would be more code to audit than the thirty lines it replaces.

export interface Args {
  command?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      // A bare flag followed by a non-flag token consumes it as a value.
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      flags[token.slice(1)] = true;
      continue;
    }

    positionals.push(token);
  }

  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export const hasFlag = (args: Args, name: string): boolean => args.flags[name] === true;

export function flagValue(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}
