---
name: user-report-impact-analysis
description: Use the moment the user reports a symptom ("X doesn't work", "it shows the wrong number", "still Y after Ctrl-Shift-R"). Treat the report as fact, then run a mandatory end-to-end impact analysis and deep bug hunt. Never close a report as "works as intended" without investigating.
---
# User report -> impact analysis + bug hunt

## When to use
- The user says what they SAW or EXPERIENCED: "the compress button doesn't reduce tokens", "it still shows 100k after a hard refresh", "deletion shows nothing".
- Any report with a concrete repro ("I pressed X, refreshed with Ctrl-Shift-R, still Y").
- Whenever your first instinct is "that's not a bug, they misunderstand" -- that instinct is the trigger, not a reason to skip.

The user is not a programmer. They will not misdescribe what was on their screen. Their word is fact.

## Eljaras (mandatory, not optional)
1. **Accept the report as true.** Do not explain it away or minimize it. Do not
   close it as "works as intended" before step 2-4 are done.
2. **Impact analysis -- trace the FULL path end to end.** For a UI symptom:
   frontend event handler -> the fetch/API call -> backend route -> the
   underlying operation -> the measurement -> what is displayed and WHEN. Read
   the actual code at each hop; do not reason from memory.
3. **Deep bug hunt.** Check timing (does the confirmation fire on *submit* or on
   *completion*?), state (is the read stale?), source of numbers (what is
   measured, from which file/field?). Reproduce from real data (transcripts,
   logs, DB) rather than assuming.
4. **Report with evidence:** concrete numbers, a log field, a code line. Fix the
   real defect(s), then say plainly what was wrong.

## Buktatok
- **"The core operation is correct" is NOT the end.** Even when the main action
  works, a real defect usually sits next to it: a stale display, a premature
  confirmation, a wrong measurement. Keep looking until you find why the user
  saw what they saw.
- **A confirmation toast that fires on command-submit lies.** If the backend
  returns as soon as a slash command is typed (pre-send idle gate), the "done"
  message appears before the ~minute-long operation finishes. Make the message
  honest and let the real number update on completion.
- **A "last value" reader can be stale.** A number read from the newest usage
  entry does not reflect an operation that has not yet produced a new entry
  (e.g. a compaction on an idle session). Account for boundary/marker records.
- **Don't argue with the user to save tokens.** Back-and-forth costs more than
  one proper investigation. Investigate first, explain after.
- **One symptom, several independent causes -- keep digging past the first.**
  2026-08-15, "the strip at the bottom disappears before I can read it" had
  THREE separate causes stacked: a flat 3000 ms default regardless of message
  length, `white-space: nowrap` in the CSS (so a long message ran off both edges
  and was unreadable even when it stayed), and ten call sites passing a wrong
  second argument (`true` -> `setTimeout(fn, true)` -> 1 ms; the string
  `'error'` -> NaN -> 0 ms). Stopping at the first cause would have left the
  failure messages -- Reconnect, Smoke-test, save errors -- still invisible.
- **Audit every call site of a shared UI helper, not just the reported one.**
  `grep -c` the helper, then brace-match each call and count its arguments. A
  helper that silently accepts a wrong-typed argument hides bugs for years;
  make it NORMALISE what it is handed (number / boolean / string / options
  object) so a caller mistake can never make a message invisible again.
- **An earlier timer must not kill a later element.** A `setTimeout` whose id is
  never stored will fire while a NEWER message is on screen and hide it. Keep
  the handle and clear it on every new show.

## Ellenorzes
- You can point to the exact line/mechanism that produced the user's symptom.
- You reproduced the symptom from real data, not just theory.
- Any fix is verified (syntax/typecheck + a functional check), and you told the
  user, with evidence, what the real defect was -- even if part of the system
  turned out to be working correctly.

## Referenciak
- CLAUDE.md: "A USER TAPASZTALATA TENY" szekcio.
- Memory: user-report-is-truth, verify-ui-in-a-real-browser, user-is-not-a-programmer.

## Tanulság (2026-08-16)

> Ezt a szakaszt a tömörítés előtti reflexió írta automatikusan (egy agens reflexioja). Ellenőrizd, mielőtt megbízol benne.

## Mikor használd
A felhasználói jelentések hatásának elemzésére, amikor a felhasználók visszajelzéseket adnak a rendszer működéséről.

## Eljárás
1. Gyűjtsd össze a felhasználói jelentéseket.
2. Elemezd a jelentések tartalmát és hatását a rendszerre.
3. Készítsd el az összefoglalót a megállapításokról.

## Buktatók
- Figyelj arra, hogy a jelentések ne legyenek torzítva.
- Ne hagyj figyelmen kívül fontos visszajelzéseket.

## Ellenőrzés
- Ellenőrizd, hogy a jelentések alapján hozott döntések megfelelően dokumentálva vannak-e.
