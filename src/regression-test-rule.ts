// The owner's law (kanban #839): a bug fix always comes with a regression test. ONE sentence, shared by
// every prompt that reaches a project-chat assistant, so the wording cannot drift between them.
export const REGRESSION_TEST_RULE_EN =
  'BUG FIX = REGRESSION TEST (the owner\'s law): when you fix a bug in code, add a test in the SAME commit that fails without the fix and passes with it, so the bug cannot come back unnoticed; if the bug truly cannot be caught by an automated test, say in your answer (and on the kanban card) why there is no test and how you measured the fix instead.'

/** For the assistant that cannot edit code itself and opens a kanban card for the fix. */
export const REGRESSION_TEST_CARD_RULE_EN =
  'When the card you open is a BUG FIX, write into its description that the fix must come with a regression test in the same commit (a test that fails without the fix): this is the owner\'s law for every fix.'

/** Hungarian (ASCII, like the other dispatch prompts) and English wording for the prompts that hand a FIX to a
 *  code session: the fix-mode approval prompt and the code-bridge preface. One place, so they cannot drift. */
export const REGRESSION_TEST_DISPATCH_HU =
  'REGRESSZIOS TESZT (a tulajdonos torvenye): hibajavitashoz teszt kell UGYANABBAN a commitban, mint a javitas -- olyan, ami a javitas NELKUL piros (a hibat reprodukalja), a javitassal zold. Sorrend: teszt elobb, bukjon a javitatlan kodon; javitas; zold. A commit/PR cimebe ird bele, hogy van regresszios teszt. Ha a hibat gepi teszttel tenyleg nem lehet megfogni, ird le a kartyara es a zaro osszefoglaloba, MIERT nincs teszt, es mivel merted helyette.'
export const REGRESSION_TEST_DISPATCH_EN =
  'REGRESSION TEST (the owner\'s law): a bug fix needs a test in the SAME commit as the fix -- one that fails without the fix (it reproduces the bug) and passes with it. Order: write the test first and watch it fail on the unfixed code; fix; green. Say in the commit/PR title that it has a regression test. If the bug truly cannot be caught by an automated test, write on the card and in the closing summary WHY there is no test and what you measured instead.'
