/**
 * #890 (Boss TG 5767): when a submission went out by e-mail, the system writes a small text file about it into the
 * work item's own "Feladási bizonylatok" folder (who sent it, to whom, the subject, the attachments, when, the
 * Message-ID), so nobody has to dig through the mailbox later. Built into every install; best effort and silent: a
 * failure here never breaks recording the sending.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { ol } from './owner-lang.js'
import { getProject } from './projects.js'
import { projectFileTarget, receiptFolderFor, writeProjectFile } from './project-files.js'
import { workItemFolder } from './workbench-assets.js'
import { logger } from './logger.js'
import type { WorkItemRow } from './workbench.js'

export interface EmailProofInfo {
  date: string
  time?: string
  to: string
  from?: string
  subject?: string
  attachments?: string[]
  messageId?: string
  /** true when the owner marked it by hand: the mail itself was not read */
  byHand?: boolean
  title?: string
}

/** The text of the proof, in the owner's language. Pure: no disk, no clock. */
export function buildEmailProofText(i: EmailProofInfo): string {
  const na = ol('(nem ismert)', '(not known)')
  const lines = [
    ol('E-mailes feladás bizonylata', 'Proof of submission by e-mail'),
    '',
    `${ol('Munkadarab', 'Work item')}: ${i.title || na}`,
    `${ol('Feladás ideje', 'Sent on')}: ${i.date}${i.time ? ' ' + i.time : ''}`,
    `${ol('Feladó cím', 'From')}: ${i.from || na}`,
    `${ol('Címzett', 'To')}: ${i.to || na}`,
    `${ol('Tárgy', 'Subject')}: ${i.subject || na}`,
    `${ol('Mellékletek', 'Attachments')}: ${i.attachments && i.attachments.length ? i.attachments.join('; ') : na}`,
    `Message-ID: ${i.messageId || na}`,
    '',
    i.byHand
      ? ol('A feladást a tulajdonos jelölte meg kézzel; a levelet a rendszer nem olvasta ki.', 'The owner marked this sending by hand; the system did not read the mail.')
      : ol('A rendszer az Elküldött mappában megtalálta a levelet, ez annak az adatai.', 'The system found the mail in the Sent mailbox; these are its details.'),
  ]
  return lines.join('\r\n') + '\r\n'
}

const cleanPart = (s: string): string => s.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

/** File name: "2026-11-09 14-02 E-mail feladás - <recipient>.txt" (the writer adds " (2)" if the name is taken). */
export function emailProofFileName(i: EmailProofInfo): string {
  const t = (i.time || '').replace(':', '-')
  const to = cleanPart(i.to) || ol('címzett nélkül', 'no recipient')
  return `${i.date}${t ? ' ' + t : ''} ${ol('E-mail feladás', 'E-mail sent')} - ${to}.txt`
}

/** Write the proof into the item's own proof folder; false when it could not (or was already written for this mail). */
export function writeEmailProof(item: WorkItemRow, info: EmailProofInfo): boolean {
  try {
    const project = getProject(item.project_id)
    const itemFolder = workItemFolder(item.id)
    if (!project || !itemFolder) return false
    const sub = receiptFolderFor(project, itemFolder, undefined, true)
    if (!sub) return false
    const full = { ...info, title: info.title || item.title }
    if (info.messageId) {
      // The same mail carrying several finals is recorded several times: one proof per mail.
      const t = projectFileTarget(project, sub)
      if (t.ok) {
        const mark = `Message-ID: ${info.messageId}`
        for (const f of readdirSync(t.dirAbs)) {
          if (!f.toLowerCase().endsWith('.txt')) continue
          try { if (readFileSync(`${t.dirAbs}/${f}`, 'utf8').includes(mark)) return false } catch { /* unreadable: keep looking */ }
        }
      }
    }
    const w = writeProjectFile(project, sub, emailProofFileName(full), Buffer.from(buildEmailProofText(full), 'utf8'))
    return w.ok
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e), item: item.id }, 'email proof of submission could not be written')
    return false
  }
}
