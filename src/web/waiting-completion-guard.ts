// Waiting means "ALL points are done, Boss decides" (Boss, TG 2136, 2026-10-02, #464).
// A card was moved to waiting after only one of its steps was finished. Two machine
// checks stand in front of the move:
//
//  1. open sub-cards: a card whose child cards are not finished stays where it is
//     (a child in `waiting` or `done` counts as finished work);
//  2. an agent (token caller) must state `all_points_done: true`, i.e. it went through
//     EVERY point of the card. The text of a card cannot be parsed for steps, so the
//     statement is the pause that forces the check. A browser session (Boss dragging a
//     card) is a deliberate human act and is not asked for it.
//
// Pure function: the route supplies the facts, this decides.

export interface WaitingGuardInput {
  /** The column the card is in now (undefined when unknown). */
  prevStatus: string | undefined
  /** The column it is being moved to. */
  newStatus: string | undefined
  /** True for a token / fleet caller, false for a browser session. */
  agentCaller: boolean
  /** The caller's `all_points_done` statement. */
  allPointsDone: unknown
  /** The caller confirmed (after a prompt) that open sub-cards may stay open. */
  confirmOpenParts: unknown
  /** The card's non-archived child cards. */
  children: ReadonlyArray<{ seq?: number; title: string; status: string }>
}

export interface WaitingGuardRefusal {
  error: 'open_subtasks' | 'completion_unconfirmed'
  message: string
  open?: Array<{ seq?: number; title: string; status: string }>
}

const FINISHED = new Set(['waiting', 'done'])

export function checkWaitingMove(i: WaitingGuardInput): WaitingGuardRefusal | null {
  if (i.newStatus !== 'waiting' || i.prevStatus === 'waiting') return null
  const open = i.children.filter((c) => !FINISHED.has(c.status))
  if (open.length > 0 && i.confirmOpenParts !== true) {
    const list = open.map((c) => (c.seq != null ? `#${c.seq}` : '#?') + ' ' + c.title.slice(0, 60)).join('; ')
    return {
      error: 'open_subtasks',
      open: open.map((c) => ({ seq: c.seq, title: c.title, status: c.status })),
      message: `A kártya NEM kerülhet a várakozóba: ${open.length} részfeladata nyitott (${list}). Maradjon folyamatban, és folytasd a munkát. / The card cannot go to waiting: ${open.length} sub-card(s) are still open (${list}). Keep it in progress and continue the work.`,
    }
  }
  if (i.agentCaller && i.allPointsDone !== true) {
    return {
      error: 'completion_unconfirmed',
      message: 'A kártya csak akkor mehet a várakozóba, ha MINDEN pontja kész. Nézd végig az összes pontot (leírás, lépések, kommentek, részfeladatok): ha bármelyik nyitott, a kártya marad folyamatban. Ha tényleg minden kész, küldd újra "all_points_done": true mezővel. / A card may go to waiting only when EVERY point is done. Go through all points (description, steps, comments, sub-cards): if any is open, the card stays in progress. If all are really done, resend with "all_points_done": true.',
    }
  }
  return null
}
