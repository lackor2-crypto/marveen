// #656: a debate report ("Vitáztatás jelentés: <question>" / "Debate report: <question>", built in debate-export.ts) is a
// finished output, not a case to work on. Leaf module (no imports) so the context / to-do code can use it without a cycle.

const REPORT_PREFIXES = ['Vitáztatás jelentés: ', 'Debate report: ']

/** Is this work item title the title of a saved debate report (either language)? */
export function isDebateReportTitle(title: unknown): boolean {
  const t = String(title ?? '')
  return REPORT_PREFIXES.some((p) => t.startsWith(p))
}
