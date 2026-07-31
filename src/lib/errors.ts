// Error taxonomy. Every error carries a machine-stable `reason` so the stderr
// wording can change without breaking an agent that parses it.

import {
  EXIT_INVALID_ARGS, EXIT_CONFIG, EXIT_NOT_RUNNING,
  EXIT_NETWORK, EXIT_TOOL_MISSING, EXIT_INTERNAL,
} from './exit-codes.ts';

export class AdaError extends Error {
  constructor(
    /** Machine-stable identifier. Emitted as `code` in --json mode and safe to
     *  branch on; the message is prose and may change. */
    readonly code: string,
    message: string,
    readonly exitCode: number,
    readonly hint?: string,
    /**
     * The underlying tool's own words, kept verbatim.
     *
     * A translated message says what went wrong in general; this says what the
     * thing that actually failed reported. For a rejected validator that is the
     * Aiken `trace` naming the condition that did not hold — the single most
     * useful line available, and it was being discarded in favour of prose that
     * could only ever list the possibilities.
     */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AdaError';
  }
}

export const usageError = (message: string, hint?: string) =>
  new AdaError('invalid_args', message, EXIT_INVALID_ARGS, hint);

export const configError = (message: string, hint?: string) =>
  new AdaError('config_error', message, EXIT_CONFIG, hint);

export const notRunningError = (message: string, hint?: string) =>
  new AdaError('devnet_not_running', message, EXIT_NOT_RUNNING, hint);

export const networkError = (message: string, hint?: string) =>
  new AdaError('network_error', message, EXIT_NETWORK, hint);

export const toolMissingError = (message: string, hint?: string) =>
  new AdaError('tool_missing', message, EXIT_TOOL_MISSING, hint);

export function toAdaError(err: unknown): AdaError {
  if (err instanceof AdaError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AdaError('internal_error', message, EXIT_INTERNAL);
}
