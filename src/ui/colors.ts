// Colour is opt-out: disabled when stdout is not a TTY, when NO_COLOR is set,
// or on a dumb terminal. --json callers additionally never route through here,
// because anything reaching stdout in JSON mode must be plain.

// Built at runtime rather than written as a literal escape, so no source file
// in this repo carries a raw control character.
const CSI = String.fromCharCode(27) + '[';
const RESET = `${CSI}0m`;

const enabled =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const wrap = (code: string) => (s: string) =>
  enabled ? `${CSI}${code}m${s}${RESET}` : s;

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const cyan = wrap('36');
