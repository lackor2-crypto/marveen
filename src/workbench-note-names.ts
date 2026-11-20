// The names of the two files the app GENERATES next to every work item: "Kontextus - <name>.md" and "Teendő - <name>.md"
// ("Context - ..." / "To do - ..." on an English install). A leaf module (imports nothing) so the file logic
// (workbench-assets) and the generators (workbench-item-context / -todos) share ONE definition without an import cycle.

export const CONTEXT_PREFIX_HU = 'Kontextus'
export const CONTEXT_PREFIX_EN = 'Context'
export const TODO_PREFIX_HU = 'Teendő'
export const TODO_PREFIX_EN = 'To do'

/** Both language prefixes count when an existing context file is recognised. */
export function isContextFileName(name: string): boolean {
  return new RegExp(`^(?:${CONTEXT_PREFIX_HU}|${CONTEXT_PREFIX_EN}) - .+\\.md$`, 'i').test(name)
}

/** Both language prefixes count when an existing to-do file is recognised. */
export function isTodoFileName(name: string): boolean {
  return new RegExp(`^(?:${TODO_PREFIX_HU}|${TODO_PREFIX_EN}) - .+\\.md$`, 'i').test(name)
}
