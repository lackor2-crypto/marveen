// The owner's law (kanban #839): a bug fix always comes with a regression test. ONE sentence, shared by
// every prompt that reaches a project-chat assistant, so the wording cannot drift between them.
export const REGRESSION_TEST_RULE_EN =
  'BUG FIX = REGRESSION TEST (the owner\'s law): when you fix a bug in code, add a test in the SAME commit that fails without the fix and passes with it, so the bug cannot come back unnoticed; if the bug truly cannot be caught by an automated test, say in your answer (and on the kanban card) why there is no test and how you measured the fix instead.'

/** For the assistant that cannot edit code itself and opens a kanban card for the fix. */
export const REGRESSION_TEST_CARD_RULE_EN =
  'When the card you open is a BUG FIX, write into its description that the fix must come with a regression test in the same commit (a test that fails without the fix): this is the owner\'s law for every fix.'
