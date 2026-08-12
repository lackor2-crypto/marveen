// What every /compact this fork sends should preserve.
//
// Boss, 2026-08-12, on being told the compaction prompt belongs to Claude Code
// and not to us: "akor is keress ere megoldast." There is one. `/compact`
// accepts free-text instructions ("/compact Focus on the API changes"), so the
// prompt is not out of reach after all -- we do not own the messages array, but
// we do own what we ask for when we compact.
//
// The content is the context-management document's section 9 ("Extract state,
// not prose") plus 10 (never approximate exact values), 7 (keep rejected
// approaches) and 61 (a single explicit next action), compressed to what fits
// in a slash command.
//
// MUST STAY A SINGLE LINE. It is delivered through tmux send-keys, where a
// newline is Enter: a two-line instruction would submit halfway through and the
// remainder would land in the fresh context as a stray prompt.
export const COMPACT_INSTRUCTIONS =
  'Extract state, not prose. Preserve verbatim: exact numbers, file paths, commands, versions, ids and config values (never round or write "about"); ' +
  "the user's explicit requirements and constraints; decisions with their reasons; approaches already tried and rejected, with why, so they are not retried; " +
  'errors and their causes; what is finished versus still open; and end with one concrete NEXT ACTION. Drop narrative before dropping any of those.'

/** The full command to send. Kept here so no caller can forget the instructions. */
export const COMPACT_COMMAND = `/compact ${COMPACT_INSTRUCTIONS}`
