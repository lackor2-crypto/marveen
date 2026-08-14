// Shared content filter for anything that gets PERSISTED and later re-fed to a
// model: memories, and (since the PreCompact reflection was rebuilt) auto-written
// skill files. Text that ends up in a skill or a memory is read back as
// instructions on a later run, so a transcript quoting "ignore all previous
// instructions" must never be stored verbatim as agent guidance.
//
// This is a coarse net on purpose: it costs a rejected save at worst, and the
// callers all fail open (skip the write, keep working).
const SUSPICIOUS_PATTERNS = [
  /\bcurl\s+(-[a-zA-Z]\s+)*https?:\/\//i,
  /\bbash\s+-c\b/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\bimport\s+subprocess\b/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /override\s+your\s+(instructions|rules|safety|guidelines)/i,
  /forget\s+your\s+(instructions|rules|safety|guidelines|training)/i,
  /new\s+persona/i,
  /\brm\s+-rf\b/i,
]

export function containsSuspiciousContent(content: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(content))
}
