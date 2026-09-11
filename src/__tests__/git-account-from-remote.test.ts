// A GIT-FIOK KIOLVASASA A REMOTE-CIMBOL.
//
// Boss, 2026-09-11 (kepernyokeppel): a Raktar > Git tarolok lapon egy repo
// "ismeretlen fiok" alatt allt. "ilyen nincs hogy nem lehet tudni hogy melyik
// git fiokbol jott le az a repo." A valos eset: az MT4-mappaban HELYBEN ulo
// MQL4 repo, amit nem a Rendszer/Tarolok/Git/<fiok>/ ala klonoztunk, tehat a
// fizikai utbol nem derul ki a fiok -- DE a remote-cimben ott van. A regi kod
// csak a `https://<fiok>@host` userinfo-alakot ismerte; a szokasos
// `https://host/<fiok>/<repo>` ut-alakot nem, ezert lett "ismeretlen".
import { describe, it, expect } from 'vitest'
import { accountFromRemoteUrl } from '../git-sync.js'

describe('accountFromRemoteUrl', () => {
  it('a valos MQL4 esete: https ut-alak -> a tulajdonos (lackor2-crypto)', () => {
    expect(accountFromRemoteUrl('https://github.com/lackor2-crypto/trendvonal_rajzolo.git'))
      .toBe('lackor2-crypto')
  })

  it('userinfo az elsodleges, ha van (auth-fiok)', () => {
    expect(accountFromRemoteUrl('https://usalackor@github.com/masvalaki/repo.git'))
      .toBe('usalackor')
  })

  it('https ut-alak .git nelkul is', () => {
    expect(accountFromRemoteUrl('https://github.com/Freeberischeaper/freeber-classic'))
      .toBe('Freeberischeaper')
  })

  it('scp-alaku ssh: user@host:<owner>/<repo>', () => {
    expect(accountFromRemoteUrl('git@github.com:Freeberischeaper/freeberforum.git'))
      .toBe('Freeberischeaper')
  })

  it('ssh:// URL ut-alak', () => {
    expect(accountFromRemoteUrl('ssh://git@github.com/lackor2-crypto/marveen.git'))
      .toBe('lackor2-crypto')
  })

  it('nem-github host is mukodik (a tulajdonos az ut elso szegmense)', () => {
    expect(accountFromRemoteUrl('https://gitlab.com/valaki/projekt.git'))
      .toBe('valaki')
  })

  it('ures string, ha nincs remote (nem talalgatunk fiokot)', () => {
    expect(accountFromRemoteUrl('')).toBe('')
    expect(accountFromRemoteUrl('   ')).toBe('')
  })

  it('ures, ha nincs tulajdonos-szegmens az utban', () => {
    // Csak host, repo nelkul -- ne talaljon ki fiokot.
    expect(accountFromRemoteUrl('https://github.com/')).toBe('')
  })
})
