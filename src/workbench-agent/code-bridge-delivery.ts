/**
 * A MUNKAPAD-FELADAT VALASZA A MUNKAPAD CHATJEBE MEGY (kanban #433).
 *
 * Boss, 2026-09-28: "abba a csetbe kell nekem visszakapnom az uzenetet,
 * ahonnan kerdeztem" -- a teljes erteku ugynok valasza a Telegramon jott meg,
 * a Munkapad chatjeben nem. Ezert a Munkapad chatbol inditott kod-hid feladat
 * (`origin: 'workbench'`) NEM kap Telegram-ertesitot; a valasz helye a
 * Munkapad-beszelgetes, amit a feladat `chatId`-je nevez meg.
 *
 * MIERT KELL EZ AZ ELO FORDULO MELLE: az elo chat-fordulo (runCodeBridgeTurn)
 * a dashboard-folyamat memoriajaban figyeli a feladatot. Ha a dashboard kozben
 * ujraindul (minden landolas utan automatikus deploy), a figyeles elvesz --
 * a Telegram-ertesito eddig ilyenkor is kezbesitett. Ez az ut a feladat
 * LEZARASAKOR fut (a worker eredmenye, vagy a sorbol kiesett feladat), tehat az
 * ujrainditast is tuleli. Ha mindketto ir, a masodik nem ir: a sor egyszer kerul
 * be (`addAgentMessageOnce`).
 */
import { getAgentSession, addAgentMessageOnce } from './sessions.js'
import { recordCodeBridgeOutcome } from './code-bridge-turn.js'
import type { CodeTask } from '../web/code-bridge-store.js'
import { continueBridgeTaskElsewhere } from './bridge-continuation.js'

/** true = a valasz a Munkapad-beszelgetesbe ment (vagy mar bent volt);
 *  false = ez nem Munkapad-feladat, vagy a beszelgetes nem talalhato -- akkor a
 *  hivo mas uton kezbesit, hogy a valasz sehol se vesszen el. */
export function deliverCodeTaskToWorkbench(task: CodeTask): boolean {
  if (task.origin !== 'workbench' || !task.chatId) return false
  const session = getAgentSession(task.chatId)
  if (!session) return false
  // Limit / elakadas: ha egy masik fiok folytatja (vagy az elo fordulo
  // intezi), a hiba-sor NEM kerul a beszelgetesbe (Boss, 2026-09-29).
  if (continueBridgeTaskElsewhere(task)) return true
  const lang = session.language === 'en' ? 'en' : 'hu'
  const since = Math.floor(task.createdAt / 1000)
  recordCodeBridgeOutcome(
    { status: task.status, result: task.result, summary: task.summary, error: task.error },
    lang,
    (role, content) => { if (content.trim()) addAgentMessageOnce(session.id, role, content, since) },
  )
  return true
}
