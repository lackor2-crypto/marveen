---
name: pre-push-gate-flaky-under-load
scope: global
description: A pre-push kapu (20-require-green-suite-main) sajat teljes-suite futasa nyomtalan-munka.test.ts onellenorzesen bukhat, HOLOTT a tartalom es a fuggetlen izolalt futas is zold -- ne higgy azonnal kod-hibanak, elobb ellenorizd terheles alatt.
---

# Pre-push kapu: latszolagos hamis piros teljes-suite alatt

## Mikor hasznald

Amikor a pre-push kapu (`.git/hooks/pre-push.d/20-require-green-suite-main`)
BLOKKOLJA a push-t a `src/__tests__/nyomtalan-munka.test.ts` "A FA MOST is
tiszta" onellenorzesen ("Szemet all a repo gyokereben" -- de a lista
VALOJABAN kovetett, normal gyokerfajlokat sorol fel: README.md, package.json,
tsconfig.json stb), DE:
- a te sajat izolalt/onallo `npx vitest run` futtatasod (nem a hook-on
  keresztul) ugyanarra a commitra ZOLD,
- vagy a `test-guard.sh` napi orjarat sajat futasa ugyanarra a bazis-commitra
  ZOLD-et jelentett a `{{PROJECT_ROOT}}/store/test-guard.log`-ban.

## Amit 2026-09-03-an mertunk

- Egy dokumentacios-tartalmu commit tsc-tiszta, izolalt worktree-ben
  ONALLOAN futtatva 435/435 zold volt.
- A pre-push kapu SAJAT futasaban (friss `mktemp -d` detached worktree)
  UGYANEZ a commit HAROMSZOR bukott, mindig ugyanazon a teszten, nagyjabol
  ugyanannyi (30-31) hibas teszttel, MINDIG a `nyomtalan-munka.test.ts`
  onellenorzesevel egyutt (`git-sync.test.ts`, `memory-boundary.test.ts` is
  szerepelt a hibalistaban -- mindkettő maga is `git`/`fs` allapotot vizsgal).
- Percekkel az egyik bukas UTAN a `test-guard.sh` FUGGETLEN futasa
  UGYANARRA a bazis-commitra 435/435 ZOLDET adott.
- A ket eredmeny (fuggetlen futas zold, hook-futas piros, UGYANAZON a
  commiton, percek kulonbseggel) egyutt arra utal, hogy a bukas TERHELES/
  PARHUZAMOSSAG-fuggo, NEM allando kod-regresszio: tobb agens egyidejű
  heartbeatje/tesztfutasa (email-fastpath-guard, memoria-heartbeat,
  test-guard es mas agensek sajat orjaratai) egyszerre futtat teljes
  vitest suite-okat ugyanazon a gepen, es a nagy parhuzamossag (vitest
  tobb worker-thread/fork-kal fut) alatt egy `git status`/`git ls-files`
  hivas rossz pillanatban rossz eredmenyt kaphat (pl. masik folyamat
  eppen irja az indexet egy masik worktree-ben, vagy eroforras-kimerules
  miatt a subprocess timeoutol/csonkul).

## Eljaras, ha ujra elofordul

1. NE higgy azonnal allando kod-hibanak -- eloszor probald meg UJRA a
   push-t egy KESOBBI, csendesebb idopontban (nezd meg, fut-e eppen mas
   agens tesztje `ps aux | grep vitest`).
2. Fuss le egy FUGGETLEN, izolalt `npx vitest run` a SAJAT commitodra egy
   sajat worktree-ben (nem a hook mechanizmusaval) -- ha az zold, ez
   megerositi hogy a tartalom rendben van.
3. Nezd meg a `{{PROJECT_ROOT}}/store/test-guard.log` legutobbi sorat --
   ha kozeli idopontban ZOLD-et mutat ugyanarra/kozeli commitra, az
   tovabbi bizonyitek a terheles-elmelet mellett.
4. NE hasznald a `MARVEEN_SKIP_TEST_GATE=1` bypass-t egyoldaluan --
   jelentsd a jelenseget (mindket adatpontot: hook piros + fuggetlen
   futas zold) egy masik agensnek/{{OWNER_NAME}}-nak, es kerdezz ra,
   mielott bypass-olnad vagy a kapu mechanizmusat (pl. `--pool=forks
   --poolOptions.forks.maxForks=1`, vagy a kapu sajat lock-ja) modositanad.

## Buktatok

- A harom bukas mind `nyomtalan-munka.test.ts`-t erintette, de MASIK ket
  fajl (`git-sync.test.ts`, `memory-boundary.test.ts`) is megjelent a
  hibalistaban parhuzamosan -- mindharman `git`/fajlrendszer-allapotot
  vizsgalnak subprocess-szel, ami alatamasztja a "megosztott eroforras alatt
  versengo git-hivasok" elmeletet a "ez a konkret teszt hibas" elmelettel
  szemben.
- Ne probald meg egyetlen futtatasbol bebizonyitani a terheles-elmeletet --
  ket-harom megismetelt mintavetel (hook piros / fuggetlen zold / hook piros
  megint) sokkal meggyozobb, mint egyetlen adatpont.

## Ellenorzes

- `tail -5 {{PROJECT_ROOT}}/store/test-guard.log` -- legutobbi allapot.
- `bash {{PROJECT_ROOT}}/scripts/test-guard.sh --report-only` -- gyors
  ujra-lekerdezes anelkul, hogy uj futast inditana.
