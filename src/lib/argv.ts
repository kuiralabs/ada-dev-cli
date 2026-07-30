// Minimal argument parsing. Deliberately dependency-free: the surface is
// `ada <command> [subcommand] [positionals] [--flags]`, and a parser library
// would be more code to audit than the eighty lines it replaces.

/**
 * Flags that never take a value.
 *
 * Without this set, `ada localnet --json status` parsed as `{json: 'status'}` —
 * the subcommand was swallowed as the flag's value *and* `--json` silently
 * stopped being true, so the output contract broke without saying so. For a tool
 * whose second audience is a program parsing stdout, that is the worst failure
 * mode available: quiet and wrong.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'help',
  'h',
  'version',
  'v',
  'yes',
  'y',
  'verbose',
  'quiet',
  'force',
]);

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
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      // A value-taking flag consumes the next token unless that token is itself
      // a flag, so `--network --json` leaves network unset rather than setting it
      // to the string '--json'.
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      // Short flags are boolean-only. Bundling (-abc) is deliberately not
      // supported: treating it as one unknown name keeps the mistake visible
      // instead of silently setting three flags nobody asked for.
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
  // An empty value counts as absent. `--wallet=` used to resolve to the empty
  // string, which `??` then preferred over the configured default — so the flag
  // neither selected a wallet nor fell back to one. Agents filling a schema send
  // "" for an omitted field routinely, so this is the common case rather than a
  // curiosity.
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Exposed so tests assert against the real set rather than restating it. */
export const booleanFlagNames = (): readonly string[] => [...BOOLEAN_FLAGS];
