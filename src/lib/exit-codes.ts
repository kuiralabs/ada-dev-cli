// Stable exit codes. Part of the output contract in docs/COMMANDS.md: an agent
// distinguishes "I asked wrong" from "the tool broke" from "the chain said no"
// without parsing prose.

export const EXIT_OK = 0;
export const EXIT_INVALID_ARGS = 2;
export const EXIT_CONFIG = 3;
export const EXIT_NOT_RUNNING = 4;
export const EXIT_NETWORK = 5;
export const EXIT_CHAIN_REJECTED = 6;
export const EXIT_TOOL_MISSING = 7;
export const EXIT_INTERNAL = 70;
