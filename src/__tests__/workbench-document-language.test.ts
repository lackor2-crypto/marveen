// A dokumentum NYELVE a felulet nyelvet koveti -- nem a cimzettet, nem a hatosagot.
//
// Boss, Munkapad-chat 2026-10-18: a nemet hivatalnak szolo levelet az agent nemetul kezdte, pedig a
// tulajdonos magyarul hasznalja a Marveent. Ok: a mail-draft eszkoz leirasa ("a cimzett nyelven") es a
// doc.* kezikonyv ("a dokumentum nyelve es a celbirosag") a cimzett nyelve fele huzta, az "Answer
// language" sor pedig csak a CHAT-valaszra szolt. A szabaly NEM az, hogy "mindig magyarul": a bal also
// sarokban allitott nyelvet (hu / en) koveti, igy egy angol telepitesen angol level szuletik.
//
// Amit ez a fajl BIZONYIT:
//  1. mindket prompt-utvonal (elo kontextus, kod-hid) kimondja a dokumentum nyelvet, hu ES en modban;
//  2. a cimzett nyelvere utalo regi mondatok nincsenek benne sehol (se a rendszer-promptban, se az
//     eszkoz-leirasokban, se a doc-kezikonyvben);
//  3. a beszelgetes nyelve az UJ uzenettel egyutt valtozik, az olvasasok viszont nem forgatjak vissza.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase } from '../db.js'
import { createProject, type ProjectRow, getProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { buildContext, SYSTEM_PROMPT } from '../workbench-agent/context.js'
import { buildCodeBridgePrompt } from '../workbench-agent/code-bridge-turn.js'
import { documentLanguageRule } from '../workbench-agent/doc-language.js'
import { TOOLS } from '../workbench-agent/tools.js'
import { openSessionForWorkItem, followUiLanguage, getAgentSession } from '../workbench-agent/sessions.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let projectId = ''
let workItemId = ''

beforeEach(() => {
  initDatabase(':memory:')
  const p = createProject({ name: 'Nemet hivatalok', description: 'Levelek' })
  if (!p.ok) throw new Error('projekt')
  projectId = p.project.id
  const w = createWorkItem({ project_id: projectId, title: 'Level a szocialis hivatalnak', type: 'document' })
  if (!w.ok) throw new Error('munkadarab')
  workItemId = w.item.id
})

describe('a dokumentum nyelve = a felulet nyelve', () => {
  it('az elo kontextus kimondja a dokumentum nyelvet, hu es en modban is', async () => {
    const p = getProject(projectId) as ProjectRow
    const hu = (await buildContext(p, null, 'hu')).contextText
    const en = (await buildContext(p, null, 'en')).contextText
    expect(hu).toContain('Document language: Hungarian')
    expect(en).toContain('Document language: English')
    // Az angol telepites NEM kap magyar utasitast, es forditva.
    expect(en).not.toContain('Document language: Hungarian')
    expect(hu).not.toContain('Document language: English')
  })

  it('a kod-hid prompt is kimondja (ezen az uton szuletett a nemet level)', () => {
    for (const lang of ['hu', 'en'] as const) {
      const prompt = buildCodeBridgePrompt({
        projectName: 'Nemet hivatalok', projectFolder: null,
        workItem: { title: 'Level', type: 'document' }, history: [], message: 'irj levelet', lang,
      })
      expect(prompt).toContain(documentLanguageRule(lang))
      expect(prompt).toContain(lang === 'en' ? 'Document language: English' : 'Document language: Hungarian')
    }
  })

  it('a szabaly kizarja a cimzett / hatosag / birosag nyelvet, es nem "mindig magyar"', () => {
    const hu = documentLanguageRule('hu')
    const en = documentLanguageRule('en')
    expect(hu).toMatch(/addressee/)
    expect(hu).toMatch(/authority/)
    expect(hu).toMatch(/court/)
    expect(hu).toMatch(/switch at the bottom left/)
    // Egy angol telepites szabalya sehol nem emlit magyart, es forditva (a nev a nyelvbol jon).
    expect(en).not.toMatch(/Hungarian/)
    expect(hu).not.toMatch(/in English|English\b/)
  })

  it('a regi, cimzett-nyelvre huzo mondatok nincsenek meg', () => {
    expect(SYSTEM_PROMPT).not.toContain('mother tongue')
    expect(SYSTEM_PROMPT).toContain('Document language')
    const mail = TOOLS.find((t) => t.name === 'doc.mailDraft')
    expect(mail, 'a doc.mailDraft eszkoz megvan').toBeTruthy()
    expect(mail!.description).not.toContain('in the language of the recipient')
    expect(mail!.description).toContain('NOT in the recipient')
    const routes = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench-agent.ts'), 'utf8')
    expect(routes).not.toContain("register of the document's language and target court")
  })
})

describe('a beszelgetes nyelve kovetei a felulet nyelvet', () => {
  it('az uj uzenet nyelve atirja a munkamenetet; ugyanaz a nyelv nem valtoztat', () => {
    const s = openSessionForWorkItem(projectId, workItemId, 'hu')
    expect(s.language).toBe('hu')
    expect(followUiLanguage(s.id, 'en')).toBe(true)
    expect(getAgentSession(s.id)?.language).toBe('en')
    expect(followUiLanguage(s.id, 'en')).toBe(false)
  })

  it('a puszta megnyitas (olvasas) NEM forgatja vissza a nyelvet a telepites alapertelmezesere', () => {
    const s = openSessionForWorkItem(projectId, workItemId, 'en')
    // Az elozmeny-lekeres, a leallitas es tarsaik nem kapnak ?lang-ot: az alapertelmezett (hu) jon.
    const again = openSessionForWorkItem(projectId, workItemId, 'hu')
    expect(again.id).toBe(s.id)
    expect(getAgentSession(s.id)?.language).toBe('en')
  })
})
