// Dependency-free on purpose: the agent scaffold imports this, and must not pull in the workbench/db chain.
// --- Letter body spacing (Boss TG 4582, 2026-11-03) --------------------------------------------------------------------
// A Minijob letter came out with the date, subject, reference lines and salutation run together. DIN 5008 / Hungarian
// official-letter practice: the parts of a letter are set apart by blank lines (an empty line = one U+200B line, otherwise
// the system strips it). Every assistant, every agent and every new install gets the same rules from this one text.
export const LETTER_LAYOUT_RULES_EN = [
  'LETTER SPACING (every official letter): parts of the letter are set apart by one blank line (a line holding only U+200B).',
  '1) Place + date line: blank line after it (2 are fine), then the subject ("Tárgy:" / "Betreff:") as its OWN paragraph, blank line after it.',
  '2) The reference lines (employer, Betriebsnummer, insurance number, case number, "Hivatkozás") form ONE own paragraph of separate lines, blank line before and after.',
  '3) Salutation ("Tisztelt ...!" / "Sehr geehrte ...,"): blank line before and after, never glued to the subject or the first body line.',
  '4) Body paragraphs: one blank line between them; a list or numbered points is its own block with a blank line before and after.',
  '5) Closing ("Tisztelettel," / "Mit freundlichen Grüßen"): one blank line before, about 3 blank lines after for the handwritten signature, then the printed name (and role). No blank line between the closing and the name only if a signature block is used.',
  'TRANSLATION (every language version): the translated letter has the SAME head as the original, at the same place and size: the sender ("Absender:" / "Sender:") stays the framed table at the top right with the SAME layout line (#w=45&a=l&x=55&y=0&o=1, never wider, never at the left), the recipient ("Empfänger:" / "Recipient:") keeps the same blank lines above and below. Translate only the words, never the layout line or the blank lines.',
  'Never put the subject, the references, the salutation or the closing on the same paragraph as the text before them without a blank line.',
].join('\n')
