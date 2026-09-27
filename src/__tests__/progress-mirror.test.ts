// #416: live Telegram progress mirror, rebuilt from upstream d3c5fdf5.
// The classifyPane cases are upstream's scripts/__tests__/telegram-live-progress.test.py
// ported one to one; the rest pin how the mirror rides on OUR placeholder.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  langOf, classifyPane, placeholderLiveText, backgroundText, shouldEdit,
  extractThoughts, thoughtMessage, parseProgressMode,
} from '../progress-mirror.js'
import { readPending } from '../web/progress-mirror-runner.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const pane = (...lines: string[]) => lines.join('\n') + '\n'

describe('classifyPane: a turn in flight', () => {
  it('mirrors the spinner detail line, in the install language (owner 2026-09-27: no English on Telegram)', () => {
    const p = pane('> valami kérdés', '✽ Incubating… (55s · ↓ 2.6k tokens)', '  ⎿  esc to interrupt')
    expect(classifyPane(p)).toEqual({ kind: 'live', text: 'dolgozom… (55s · ↓ 2.6k token)' })
    expect(classifyPane(p, 'en')).toEqual({ kind: 'live', text: 'Incubating… (55s · ↓ 2.6k tokens)' })
  })
  it('falls back to the counter without a detail frame', () => {
    expect(classifyPane(pane('> kérdés', 'esc to interrupt · 2 shells'))).toEqual({ kind: 'live', text: 'dolgozom… (2 parancs)' })
  })
  it('working with nothing else on screen, in both languages', () => {
    expect(classifyPane(pane('esc to interrupt'))).toEqual({ kind: 'live', text: 'dolgozom…' })
    expect(classifyPane(pane('esc to interrupt'), 'en')).toEqual({ kind: 'live', text: 'working…' })
  })
  it('a live turn wins over a background footer', () => {
    expect(classifyPane(pane('✽ Incubating… (55s · ↓ 2.6k tokens)', '  ⎿  esc to interrupt',
      'bypass permissions on · 2 shells · ctrl+t to hide tasks · ↓ to manage'))?.kind).toBe('live')
  })
})

describe('classifyPane: background work', () => {
  it('shells with the tasks panel visible', () => {
    expect(classifyPane(pane('> kész', 'bypass permissions on · 2 shells · ctrl+t to hide tasks · ↓ to manage')))
      .toEqual({ kind: 'background', text: 'háttérfolyamat fut (2 parancs)' })
  })
  it('shells with the tasks panel hidden', () => {
    expect(classifyPane(pane('bypass permissions on · 1 shell · ↓ to manage'))).toEqual({ kind: 'background', text: 'háttérfolyamat fut (1 parancs)' })
  })
  it('monitor and sub-agents', () => {
    expect(classifyPane(pane('bypass permissions on · 1 monitor · ← for agents · ↓ to manage'))).toEqual({ kind: 'background', text: 'háttérfolyamat fut (1 figyelő)' })
  })
  it('the shape a live pane renders', () => {
    expect(classifyPane(pane('  ⏵⏵ bypass permissions on (shift+tab to cycle) · 2 shells · ↓ to manage'))).toEqual({ kind: 'background', text: 'háttérfolyamat fut (2 parancs)' })
  })
  it('a footer truncated by a narrow pane', () => {
    expect(classifyPane(pane('  ⏵⏵ bypass permissions on (shift+tab to cycle) · 3 shells · ctrl+t to hi…'))).toEqual({ kind: 'background', text: 'háttérfolyamat fut (3 parancs)' })
  })
  it('reports every counter, in English too', () => {
    expect(classifyPane(pane('bypass permissions on · 3 shells · 1 monitor · ↓ to manage'), 'en')).toEqual({ kind: 'background', text: 'background work running (3 shells, 1 monitor)' })
  })
})

describe('classifyPane: idle stays idle', () => {
  it('plain idle footer', () => { expect(classifyPane(pane('bypass permissions on (shift+tab to cycle)'))).toBeNull() })
  it('the idle shape a live pane renders ("← for agents" is a hint)', () => {
    expect(classifyPane(pane('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'))).toBeNull()
  })
  it('footer with a tail but no counter', () => { expect(classifyPane(pane('bypass permissions on · ↓ to manage'))).toBeNull() })
  it('scrollback quoting the footer without a tail action', () => {
    expect(classifyPane(pane('2026-07-29 log: bypass permissions on · 1 shell', '? for shortcuts'))).toBeNull()
  })
  it('a bare shell count in the scrollback', () => { expect(classifyPane(pane('npm run build spawned 3 shells', '? for shortcuts'))).toBeNull() })
  it('empty or failed capture', () => { expect(classifyPane('')).toBeNull(); expect(classifyPane(null)).toBeNull() })
})

describe('classifyPane: the shape current Claude Code renders (measured on this host, #416)', () => {
  // No "esc to interrupt" anywhere, and the spinner glyph is "·": upstream's
  // gate would have read this working turn as idle.
  const live = pane(
    '● Bash(tmux capture-pane)',
    '  ⎿  (No output)',
    '',
    '· Churning… (4m 33s · ↓ 23.5k tokens)',
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's",
    '     current work',
    '                                                         8% until auto-compact',
    '───────────────────────────────────────────────────────────────────── Szakértő ─',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────────────',
    '  Opus 5.5 | Ctx 20% | 5h 59% | 7d 92%',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  )
  it('is a live turn with its real status line', () => {
    expect(classifyPane(live)).toEqual({ kind: 'live', text: 'dolgozom… (4m 33s · ↓ 23.5k token)' })
    expect(classifyPane(live, 'en')).toEqual({ kind: 'live', text: 'Churning… (4m 33s · ↓ 23.5k tokens)' })
  })
  it('a tool-call or reply line with "(digit" never becomes the status (lackor2-bot review)', () => {
    const p = pane('● Bash(100 fájl átnézése)', '⏺ Kész (3 fájl)', '· Rendben (2 lépés)', 'esc to interrupt')
    expect(classifyPane(p)).toEqual({ kind: 'live', text: 'dolgozom…' })
    const withSpinner = pane('⏺ Bash(100 fájl)', '✻ Pondering… (12s · ↓ 1k tokens)', 'esc to interrupt')
    expect(classifyPane(withSpinner)).toEqual({ kind: 'live', text: 'dolgozom… (12s · ↓ 1k token)' })
  })
  it('the same pane after the turn ended is idle, not background', () => {
    const idle = pane(
      '✻ Churned for 4m 40s',
      '───────────────────────────────────────────────────────────────────── Szakértő ─',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────────────',
      '  Opus 5.5 | Ctx 20% | 5h 59% | 7d 92%',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    )
    expect(classifyPane(idle)).toBeNull()
  })
})

describe('riding on our placeholder', () => {
  it('keeps the placeholder text first and adds the live line', () => {
    expect(placeholderLiveText('✍️ Dolgozom rajta…', { kind: 'live', text: 'Incubating… (3s)' })).toBe('✍️ Dolgozom rajta…\n✻ Incubating… (3s)')
  })
  it('never edits the placeholder for background or idle', () => {
    expect(placeholderLiveText('x', { kind: 'background', text: 'y' })).toBeNull()
    expect(placeholderLiveText('x', null)).toBeNull()
  })
  it('background text only for background work', () => {
    expect(backgroundText({ kind: 'background', text: 'háttérfolyamat fut (1 parancs)' })).toBe('⏳ háttérfolyamat fut (1 parancs)')
    expect(backgroundText({ kind: 'live', text: 'x' })).toBeNull()
  })
  it('edits only on a change and not faster than the throttle', () => {
    expect(shouldEdit('a', 'a', 0, 99_999, 4000)).toBe(false)
    expect(shouldEdit('a', 'b', 1000, 3000, 4000)).toBe(false)
    expect(shouldEdit('a', 'b', 1000, 5000, 4000)).toBe(true)
    expect(shouldEdit(undefined, 'b', 0, 0, 4000)).toBe(false)
    expect(shouldEdit(undefined, 'b', 0, 4000, 4000)).toBe(true)
  })
})

describe('verbose thoughts', () => {
  const asst = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } })
  it('keeps visible text, drops what went out as a real reply', () => {
    const lines = [
      asst([{ type: 'text', text: 'Megnézem a naplót.' }]),
      asst([{ type: 'text', text: 'Kész, a hiba javítva.' }]),
      asst([{ type: 'tool_use', name: 'mcp__plugin_telegram_telegram__reply', input: { text: 'Kész, a hiba javítva.' } }]),
      JSON.stringify({ type: 'user', message: { content: 'x' } }),
      'not json',
    ]
    expect(extractThoughts(lines)).toEqual(['Megnézem a naplót.'])
  })
  it('never posts an English narration block to a Hungarian owner (2026-09-27)', () => {
    const lines = [
      asst([{ type: 'text', text: 'Now let me check the runner and fix the test.' }]),
      asst([{ type: 'text', text: 'Megnézem a `src/web/progress-mirror-runner.ts` fájlt.' }]),
      asst([{ type: 'text', text: '#429 kész' }]),
      asst([{ type: 'text', text: 'The cause is clear: the mirror posts the terminal text.' }]),
    ]
    expect(extractThoughts(lines)).toEqual(['Megnézem a `src/web/progress-mirror-runner.ts` fájlt.', '#429 kész'])
  })
  it('never posts a Hungarian narration block to an English owner (2026-09-27)', () => {
    const lines = [
      asst([{ type: 'text', text: 'Now let me check the runner and fix the test.' }]),
      asst([{ type: 'text', text: 'Megnézem a `src/web/progress-mirror-runner.ts` fájlt.' }]),
      asst([{ type: 'text', text: '#429 kész' }]),
      asst([{ type: 'text', text: 'The cause is clear: the mirror posts the terminal text.' }]),
      asst([{ type: 'text', text: 'Done with #429.' }]),
      asst([{ type: 'text', text: '42' }]),
    ]
    expect(extractThoughts(lines, 'en')).toEqual([
      'Now let me check the runner and fix the test.',
      'The cause is clear: the mirror posts the terminal text.',
      'Done with #429.',
      '42',
    ])
  })
  it('reads an en-prefixed install language as English', () => {
    expect(langOf('en')).toBe('en')
    expect(langOf('en-US')).toBe('en')
    expect(langOf(' EN ')).toBe('en')
    expect(langOf('hu')).toBe('hu')
    expect(langOf(undefined)).toBe('hu')
    expect(langOf('')).toBe('hu')
  })
  it('truncates long thoughts', () => {
    expect(thoughtMessage('a'.repeat(700))).toBe('▸ ' + 'a'.repeat(600) + '…')
  })
})

describe('mode setting', () => {
  it('unknown values fall back to verbose (the default)', () => {
    expect(parseProgressMode('VERBOSE')).toBe('verbose')
    expect(parseProgressMode('silent')).toBe('silent')
    expect(parseProgressMode('bogus')).toBe('verbose')
    expect(parseProgressMode(undefined)).toBe('verbose')
  })
  it('is registered for the settings page, live (no restart)', () => {
    const def = SETTINGS_REGISTRY.find(d => d.key === 'TELEGRAM_PROGRESS_MODE')
    expect(def?.valueSet).toEqual(['silent', 'indicator', 'verbose'])
    expect(def?.default).toBe('verbose')
    expect(def?.requiresRestart).toBe(false)
  })
})

describe('readPending', () => {
  it("reads the hook's <sid>.json and ignores the watchdog's claimed files", () => {
    const sd = mkdtempSync(join(tmpdir(), 'pm-'))
    mkdirSync(join(sd, 'progress'))
    writeFileSync(join(sd, 'progress', 'abc-123.json'), JSON.stringify([{ chat_id: '42', message_id: 7, transcript_path: '/t.jsonl' }]))
    writeFileSync(join(sd, 'progress', 'def.json.claimed.99'), JSON.stringify([{ chat_id: '42', message_id: 8 }]))
    writeFileSync(join(sd, 'progress', 'broken.json'), '{half')
    writeFileSync(join(sd, 'progress', 'seen-abc-1.marker'), '')
    const got = readPending(sd)
    expect(got.map(p => p.message_id)).toEqual([7])
    expect(got[0].file.endsWith('abc-123.json')).toBe(true)
  })
  it('no progress dir (fresh install) is no pending, not an error', () => {
    expect(readPending(mkdtempSync(join(tmpdir(), 'pm-')))).toEqual([])
  })
})
