/**
 * Boss, 2026-11-08: when a document is recorded as sent (finalised and mailed, found in the Sent mailbox, or marked by
 * hand), the DAY goes into the Log of the item's context file. An agent that opens the item later reads it at once and
 * never has to search the mailbox to learn when the letter went out. Sending also answers the trigger document.
 *
 * Importing this module registers the listener (see onSentEvent in workbench-docsent.ts).
 */
import { logger } from './logger.js'
import { ol } from './owner-lang.js'
import { getProject } from './projects.js'
import { getWorkItem } from './workbench.js'
import { onSentEvent, type SentEvent } from './workbench-docsent.js'
import { appendItemContext, contextOwner, readItemContext } from './workbench-item-context.js'

export function sentLogLine(title: string, e: Pick<SentEvent, 'date' | 'recipient' | 'how'>): string {
  const how = e.how === 'recorded' ? ol('küldés rögzítve', 'sending recorded') : ol('„elküldve" jelölés', 'marked as sent')
  const to = e.recipient ? ` → ${e.recipient}` : ''
  const answered = ol('A kiváltó irat ezzel megválaszolva.', 'This answers the trigger document.')
  return `- ${e.date}: ${ol('ELKÜLDVE', 'SENT')} (${how}) – ${title}${to}. ${answered}`
}

export function noteSentInContext(e: SentEvent): boolean {
  const item = getWorkItem(e.itemId)
  if (!item) return false
  const project = getProject(item.project_id)
  if (!project) return false
  const line = sentLogLine(item.title, e)
  const owner = contextOwner(item)
  const have = readItemContext(owner)
  if (have && have.text.includes(line)) return true
  const r = appendItemContext(owner, project, 'log', line)
  if (!r.ok) logger.warn({ itemId: e.itemId, code: r.code }, '[sent-context] the sending date could not be written to the context file')
  return r.ok
}

onSentEvent(noteSentInContext)
