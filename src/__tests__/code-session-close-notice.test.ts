/**
 * Kanban 2741d289 (#252) -- a lezart kartya beszelgetesebe menjen ki a zaro
 * uzenet, es CSAK oda.
 *
 * Amit ez a teszt VISELKEDESBEN merr (nem szoveget egyeztet):
 *  - a zaro uzenet abba a beszelgetesbe megy, amelyikben a munka FUTOTT,
 *  - egy IDEGEN beszelgetesbe soha nem megy ki,
 *  - ketszer nem megy ki ugyanoda (ket ut vezet `done`-ra),
 *  - es a "nem futott munka" / "nem latok oda" KET KULON kimenet.
 */
import { describe, it, expect } from 'vitest'
import {
  runCodeSessionCloseNotice,
  closeNoticeText,
  type CloseNoticeDeps,
  type CloseNoticeTaskRef,
} from '../web/code-session-close-notice.js'

const CARD = { id: '2741d289', seq: 252, title: 'Kod-hid: a lezaras jelzese a csetben' }

interface Harness {
  deps: CloseNoticeDeps
  sent: { project: string; sessionId: string; prompt: string }[]
  marked: string[]
}

function harness(opts: {
  tasks?: CloseNoticeTaskRef[]
  /** Amit a projekt-nev feloldasa ad vissza; `null` = nem latunk oda. */
  resolvesTo?: (project: string) => string | null
  enqueueFails?: string
  alreadySent?: string[]
} = {}): Harness {
  const sent: Harness['sent'] = []
  const marked: string[] = []
  const already = new Set(opts.alreadySent ?? [])
  return {
    sent,
    marked,
    deps: {
      tasksForCard: () => opts.tasks ?? [],
      resolveOwnProject: opts.resolvesTo ?? ((p) => p),
      enqueue: ({ project, sessionId, prompt }) => {
        if (opts.enqueueFails) return { ok: false, detail: opts.enqueueFails }
        sent.push({ project, sessionId, prompt })
        return { ok: true, taskId: `task-${sent.length}` }
      },
      wasSent: (cardId, sessionId) => already.has(`${cardId}:${sessionId}`),
      markSent: (cardId, sessionId) => {
        marked.push(`${cardId}:${sessionId}`)
        already.add(`${cardId}:${sessionId}`)
      },
    },
  }
}

const task = (over: Partial<CloseNoticeTaskRef> = {}): CloseNoticeTaskRef => ({
  project: 'marvin',
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  createdAt: 1000,
  ...over,
})

describe('a lezart kartya beszelgetese kap zaro uzenetet', () => {
  it('abba a beszelgetesbe ir, amelyikben a munka futott', () => {
    const h = harness({ tasks: [task()] })
    const out = runCodeSessionCloseNotice(CARD, h.deps)
    expect(out.kind).toBe('sent')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444')
    expect(h.sent[0]!.project).toBe('marvin')
    // A szoveg mondja is ki, hogy lezarult -- ezt olvassa a kovetkezo dispatch.
    expect(h.sent[0]!.prompt).toContain('#252')
    expect(h.sent[0]!.prompt).toContain('2741d289')
  })

  it('NEM ir sehova, ha ezen a kartyan nem futott kod-hid munka', () => {
    // Friss telepitesen ez a normalis allapot: ures `code_tasks`.
    const h = harness({ tasks: [] })
    expect(runCodeSessionCloseNotice(CARD, h.deps).kind).toBe('no-task')
    expect(h.sent).toHaveLength(0)
  })

  it('NEM talalgat: ha egyik feladat sem jegyezte fel a beszelgetest, hallgat', () => {
    const h = harness({ tasks: [task({ sessionId: null }), task({ sessionId: '   ' })] })
    expect(runCodeSessionCloseNotice(CARD, h.deps).kind).toBe('no-session')
    expect(h.sent).toHaveLength(0)
  })

  it('a legfrissebb, beszelgetest is rogzito feladat donti el, hova megy', () => {
    // A hivo legfrissebb-eloszor adja at oket; a session nelkulit at kell lepni.
    const h = harness({
      tasks: [
        task({ sessionId: null, createdAt: 3000 }),
        task({ sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', project: 'uj', createdAt: 2000 }),
        task({ sessionId: 'cccccccc-1111-2222-3333-444444444444', project: 'regi', createdAt: 1000 }),
      ],
    })
    runCodeSessionCloseNotice(CARD, h.deps)
    expect(h.sent[0]!.sessionId).toBe('bbbbbbbb-1111-2222-3333-444444444444')
  })

  it('IDEGEN beszelgetesbe soha nem ir: ha a projekt neve masra oldodik fel, inkabb hallgat', () => {
    // A kod-hid a nem kituzott nevet egy MASIK elerheto beszelgetesre ejti
    // vissza. Egy "lezarva" sor egy idegen csetben rosszabb, mint a csend.
    const h = harness({ tasks: [task()], resolvesTo: () => null })
    const out = runCodeSessionCloseNotice(CARD, h.deps)
    expect(out.kind).toBe('project-unreachable')
    expect(h.sent).toHaveLength(0)
  })

  it('ketszer nem megy ki ugyanabba a beszelgetesbe (ket ut vezet done-ra)', () => {
    const h = harness({ tasks: [task()] })
    expect(runCodeSessionCloseNotice(CARD, h.deps).kind).toBe('sent')
    // A masodik hivas a jovahagyas-utrol jon, ugyanarra a kartyara.
    expect(runCodeSessionCloseNotice(CARD, h.deps).kind).toBe('already-sent')
    expect(h.sent).toHaveLength(1)
  })

  it('sikertelen sorbaallitasnal NEM jegyzi elkuldottnek -- kesobb ujra probalhato', () => {
    const h = harness({ tasks: [task()], enqueueFails: 'nem latok ra a projekt beszelgeteseire' })
    const out = runCodeSessionCloseNotice(CARD, h.deps)
    expect(out.kind).toBe('enqueue-failed')
    expect(h.marked).toHaveLength(0)
  })
})

describe('a zaro uzenet ketnyelvu', () => {
  it('magyar es angol valtozat is van, es nem ugyanaz', () => {
    const hu = closeNoticeText(CARD, 'hu')
    const en = closeNoticeText(CARD, 'en')
    expect(hu).not.toBe(en)
    expect(en).toContain('CLOSED')
    expect(hu).toContain('LEZARVA')
    // Az azonosito MINDKET nyelven ott van a sorszam mellett, hogy Boss tudja,
    // MIRE keressen ra (nem git commit, hanem kanban kartya).
    for (const s of [hu, en]) {
      expect(s).toContain('#252')
      expect(s).toContain('2741d289')
    }
  })

  it('sorszam nelkul nem talal ki sorszamot, az azonositoval hivatkozik', () => {
    const s = closeNoticeText({ id: '2741d289', seq: null, title: 'x' }, 'hu')
    expect(s).toContain('2741d289')
    expect(s).not.toContain('#')
  })
})
