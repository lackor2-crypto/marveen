// NAPI GIT-LEHUZAS: kartya az Utemezesek alatt, es CSAK letoltes.
//
// Boss, 2026-08-22: "ezeket a giteket az osszeset ami van huzza le mondjuk
// naponta egyszer. akor amikor eppen szabad es elerheto a marvin vagy barmely
// agent. csak pull! kizarolag csak pul!"
//
// Harom dolgot kell itt biztosra tudni:
//   1. hogy MINDEN repohoz megvan a kulcs (ezen bukott el eddig hatbol ot),
//   2. hogy a napi menet SOHA nem tolt fel es nem ir felul semmit,
//   3. hogy a kartya nem foglal agenst -- gepi parancs, nem beszelgetes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { accountFromRepoPath } from '../git-sync.js'

const SYNC = readFileSync(join(__dirname, '..', 'git-sync.ts'), 'utf-8')
const RUNNER = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')
const ROUTE = readFileSync(join(__dirname, '..', 'web', 'routes', 'storages.ts'), 'utf-8')
/** A megjegyzes-sorok nelkuli kod -- hogy a teszt ne a kommentre feleljen. */
function csakKod(sz: string): string {
  return sz.split('\n').filter((l) => {
    const t = l.trim()
    return t.slice(0, 2) !== '//' && t.slice(0, 1) !== '*' && t.slice(0, 2) !== '/*'
  }).join('\n')
}

const SEED = JSON.parse(readFileSync(
  join(__dirname, '..', '..', 'seed-scheduled-tasks', 'git-pull', 'task-config.json'), 'utf-8',
)) as {
  schedule: string; agent: string; enabled: boolean; type: string
  description: string; command: string; timeoutMs: number; failThreshold: number
}

/** Utvonal a futtato gep elvalasztojaval -- Windowson `\` a `/` helyett. */
const ut = (...r: string[]) => r.join(sep)

describe('melyik fiok kulcsaval huzzuk le a repot', () => {
  const gyoker = ut('mnt', 'f', 'Marveen')

  it('a FIZIKAI utbol olvassa ki a fiokot', () => {
    // A repok itt allnak: Rendszer/Tárolók/Git/<fiok>/<repo>.
    const repo = ut(gyoker, 'Rendszer', 'Tárolók', 'Git', 'Freeberischeaper', 'docs')
    expect(accountFromRepoPath(gyoker, repo)).toBe('Freeberischeaper')
  })

  it('a BEKOTOTT ut nem teveszti meg', () => {
    // 2026-08-22: pontosan ez volt a hiba. A ceges repok a fan a
    // `Cégek/…/Fejlesztés/GIT_REPOS` alatt latszanak (oda vannak bekotve), es
    // a fiokot ebbol az utbol probaltuk kiolvasni -- amiben nincs is benne.
    // Kulcs nelkul indult a `fetch`, es a hat repobol ot elhasalt:
    // "could not read Password for 'https://usalackor-blip@github.com'".
    const bekotve = ut(gyoker, 'Cégek', 'Freeberischeaper', 'Fejlesztés', 'GIT_REPOS', 'docs')
    expect(accountFromRepoPath(gyoker, bekotve)).toBe('')
    // ...es ilyenkor a tavoli cim a mentsvar.
    expect(SYNC).toContain('accountOfPath(abs) || await accountFromRemote(abs)')
    expect(SYNC).toMatch(/remote', 'get-url', 'origin'/)
  })

  it('a fan kivuli utra nem talal ki fiokot', () => {
    expect(accountFromRepoPath(gyoker, ut('home', 'boss', 'valami'))).toBe('')
    expect(accountFromRepoPath('', ut(gyoker, 'x'))).toBe('')
  })
})

describe('a napi menet CSAK letolt', () => {
  it('sehol nem tolt fel es nem ir felul', () => {
    // A tiltolista nem stilus-kerdes: mind a negy paranccsal el lehet tuntetni
    // olyan munkat, amirol a felhasznalo azt hiszi, megvan.
    for (const tiltott of ["'push'", "'reset'", "'stash'", "'rebase'", "'checkout'"]) {
      expect(SYNC).not.toContain(tiltott)
    }
  })

  it('az elorelepes csak `--ff-only` lehet', () => {
    expect(SYNC).toContain("'merge', '--ff-only'")
  })
})

describe('a kartya az Utemezesek alatt', () => {
  it('naponta egyszer fut', () => {
    const [perc, ora, nap, ho, hetnap] = SEED.schedule.trim().split(/\s+/)
    expect(SEED.schedule.split(/\s+/)).toHaveLength(5)
    // Nem lehet benne `/` vagy `,`: az mar tobbszori futast jelentene.
    expect(perc).toMatch(/^\d+$/)
    expect(ora).toMatch(/^\d+$/)
    expect([nap, ho, hetnap]).toEqual(['*', '*', '*'])
    expect(SEED.enabled).toBe(true)
  })

  it('gepi parancs: nem foglal agenst es nem fogyaszt keretet', () => {
    expect(SEED.type).toBe('command')
    // A gazda-agens mezo a helyorzobol jon -- sose beegetett nev.
    expect(SEED.agent).toBe('{{MAIN_AGENT_ID}}')
  })

  it('a NEM-VARO vegpontot hivja, nem a blokkolot', () => {
    // A kartya `curl`-je 30 masodpercig var a valaszra. A teljes lehuzas
    // ennel joval tovabb tart (halozat, 9+ repo), ezert a vegpont csak
    // ELINDITJA a menetet, es azonnal visszaigazol.
    expect(SEED.command).toContain('/api/storages/git-sync-start')
    expect(SEED.command).not.toContain("git-sync'")
  })

  it('a telepitesi helyet es a portot helyorzobol veszi', () => {
    expect(SEED.command).toContain('{{INSTALL_DIR}}')
    expect(SEED.command).toContain('{{WEB_PORT}}')
    expect(SEED.command).not.toMatch(/\/home\/|\/Users\//)
  })

  it('a token a fajlbol jon, nem a parancsba irva', () => {
    // Egy parancsba irt token bekerulne a naplokba es a keperynyokepekre is.
    expect(SEED.command).toContain('store/.dashboard-token')
    expect(SEED.command).not.toMatch(/Bearer [A-Za-z0-9]{8}/)
    // Token nelkul hibaval all meg -- nem csendben, „sikeresen".
    expect(SEED.command).toContain('exit 1')
  })

  it('a leiras megmondja, hogy sose tolt fel', () => {
    expect(SEED.description.toLowerCase()).toContain('push')
  })
})

describe('a vegpont, amit a kartya hiv', () => {
  it('elinditja a menetet, de nem varja meg', () => {
    const ag = ROUTE.slice(ROUTE.indexOf("'/api/storages/git-sync-start'"))
    const veg = ag.slice(0, ag.indexOf('\n  }') + 4)
    expect(veg).toContain('syncAllRepos()')
    expect(veg).not.toContain('await syncAllRepos()')
    // 202 = „elfogadtam, dolgozom rajta" -- nem 200 „kesz".
    expect(veg).toContain('202')
  })
})

describe('kezi inditas a kartyarol', () => {
  it('a „Futtatas most" a PARANCSOT futtatja, nem az agenst kerdezi', () => {
    // Enelkul a gomb egy parancs-kartyan a fo agens sessionjebe szurt volna
    // promptot, vagyis soha nem azt csinalta, amit a kartya mond.
    const fn = RUNNER.slice(RUNNER.indexOf('export async function runScheduledTaskNow('))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    expect(body).toContain("task.type === 'command'")
    expect(body).toContain('runCommandTask(task, now)')
    // A parancs-ag a tmux-os ag ELOTT van, kulonben nincs ertelme.
    expect(body.indexOf('runCommandTask')).toBeLessThan(body.indexOf('attemptFireTask'))
  })
})

describe('egy utemezes, nem ketto', () => {
  it('a kartya mellett nem fut rejtett hat-oras idozito', () => {
    // Kulonben a kartya hazudna: „naponta egyszer"-t mutatna, kozben napi
    // negyszer futna, es a KIKAPCSOLT kartya sem allitana meg semmit.
    const fn = SYNC.slice(SYNC.indexOf('export function startGitSync()'))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    expect(body).toContain('vanNapiKartya()')
    expect(body.indexOf('vanNapiKartya()')).toBeLessThan(body.indexOf('setInterval'))
    expect(SYNC).toContain("export const GIT_PULL_TASK = 'git-pull'")
  })
})

describe('a vezerlopult nem all meg a szinkron alatt', () => {
  it('a fa bejarasa aszinkron', () => {
    // 2026-08-22, merve: a szinkron bejaras 23 masodpercre BEFAGYASZTOTTA az
    // egesz vezerlopultot -- a depo a `/mnt/f`-en ul, ahol minden egyes
    // konyvtar-olvasas atmegy a Windows-hataron. Amig a hurok allt, a kartya
    // sajat `curl`-je sem kapott valaszt, es 30 mp utan „hibara" futott:
    // "exit 28: curl: (28) Operation timed out after 30002 milliseconds".
    // A lehuzas kozben vegig hasznalhatonak kell maradnia a feluletnek.
    const fn = SYNC.slice(SYNC.indexOf('export async function findRepos('))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    for (const blokkolo of ['readdirSync', 'statSync', 'existsSync']) {
      expect(body).not.toContain(blokkolo)
    }
    expect(body).toContain('await fsp.readdir')
    expect(SYNC).toContain('for (const abs of await findRepos())')
  })

  it('a parancsot nem `spawnSync` inditja', () => {
    // Ugyanaz a hiba a masik oldalrol: a parancs-kartya futtatasa maga is
    // megallitotta a hurkot, amig a parancs futott.
    // Csak a KODOT nezzuk: a fajl tetejen ott all a magyarazat, amiben
    // szerepel a szo -- enelkul a teszt a sajat indoklasara felelne.
    const CMD = csakKod(readFileSync(join(__dirname, '..', 'web', 'command-task.ts'), 'utf-8'))
    expect(CMD).not.toContain('spawnSync')
    expect(CMD).toContain('spawn(')
  })
})
