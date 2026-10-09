// Pure rules of the Workbench Univer grid (kanban #504): what a save can keep, and how a
// Univer cell maps to the server's strings-in/strings-out table contract. No Univer
// import here, so the vitest suite checks it directly (src/__tests__/univer-rules.test.ts);
// entry.js wires it into the grid.

export var NUM_RE = /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/

// Rows and columns (#526, part 2): inserting, removing and moving whole rows and columns
// is saved into an .xlsx -- the editor tags every row and column with where it came from
// and the server moves the formatting with it. Two things stay refused in an .xlsx:
//  - shifting CELLS (insert cells and push the rest down/right, delete and pull up/left):
//    the cells move without their rows, so nothing can say where a cell's formatting went;
//  - any row/column change on a sheet that holds pictures, charts, table objects, comments
//    or protection: those sit at a position the save does not follow.
export var CELLSHIFT_RE = /^sheet\.command\.(insert-range|delete-range-move)/
export var ROWCOL_RE = /^sheet\.command\.(insert-.*(row|col)|remove-(row|col)|move-(rows|cols))/
// Kept for the callers that only ask "is this structural at all".
export var STRUCTURE_RE = /^sheet\.command\.(insert-.*(row|col)|insert-range|remove-(row|col)|delete-range-move|move-(rows|cols))/

// Sheets (#526): adding, renaming, removing and reordering sheets is saved into an .xlsx
// (the server rewrites the workbook's sheet list and keeps every sheet that stays as it
// was). A .csv is one sheet by nature, so there all of it stays blocked. COPYING a sheet
// stays blocked everywhere: the copy would come out without the original's formatting.
export var SHEET_RE = /^sheet\.command\.(insert-sheet|remove-sheet|remove-sheet-confirm|copy-sheet|set-worksheet-name|set-worksheet-order)/
export var SHEET_COPY_RE = /^sheet\.command\.copy-sheet/

// Formatting is blocked everywhere: the save writes cell text and formulas only (the
// file's own formatting stays, by position), so a style set here would be dropped on
// save without a word. Covers the toolbar, the shortcuts (Ctrl+B ...), the format
// painter and clear-formatting buttons, number formats, merges, borders, hidden
// rows/columns/sheets, tab colour and protection.
export var FORMAT_RE = new RegExp('^(?:sheet\\.(?:command\\.(?:'
  + 'set-style|set-(?:bold|italic|underline|stroke|overline|font-family|font-size|text-color|background-color'
  + '|horizontal-text-align|vertical-text-align|text-wrap|text-rotation|shrink-to-fit|tab-color|worksheet-hidden'
  + '|worksheet-default-style|worksheet-range-theme-style|worksheet-right-to-left|once-format-painter'
  + '|infinite-format-painter|border(?:-[a-z]+)?|rows-hidden|col-hidden|protection|worksheet-protection'
  + '|worksheet-permission-points|range-protection-from-context-menu|defined-name)'
  + '|set-range-(?:bold|italic|underline|stroke|subscript|superscript|font-family|fontsize|font-increase'
  + '|font-decrease|text-color)'
  + '|reset-(?:text-color|range-text-color|background-color)|clear-selection-format|apply-format-painter'
  + '|paste-format|paste-besides-border|add-worksheet-merge(?:-[a-z]+)?|remove-worksheet-merge'
  + '|hide-(?:row|col)-confirm|add-range-protection(?:-[a-z-]+)?|add-worksheet-protection'
  + '|(?:delete|change)-[a-z-]*protection[a-z-]*|insert-defined-name|register-worksheet-range-theme-style'
  + '|numfmt\\.[a-z.]+|mobile\\.numfmt\\.[a-z.]+)'
  + '|operation\\.(?:open\\.numfmt\\.panel|set-format-painter))'
  + '|ui\\.(?:operation\\.(?:activate|continuous)-format-painter|command\\.clear-formatting))$')

/** Which lock a command hits: 'sheet', 'sheetcopy', 'structure', 'objects', 'format' or null (allowed). */
export function blockedKind(commandId, structureLocked, sheetsLocked, objectsOnSheet) {
  var id = String(commandId || '')
  if (SHEET_COPY_RE.test(id)) return sheetsLocked ? 'sheet' : 'sheetcopy'
  if (sheetsLocked && SHEET_RE.test(id)) return 'sheet'
  if (structureLocked && CELLSHIFT_RE.test(id)) return 'structure'
  if (structureLocked && objectsOnSheet && ROWCOL_RE.test(id)) return 'objects'
  if (FORMAT_RE.test(id)) return 'format'
  return null
}

// The menu entries of the blocked commands, hidden so the grid does not offer what the
// save cannot keep (the command guard above still catches shortcuts). Keyed by Univer
// menu item id; a ribbon group whose items are all hidden disappears with them.
export var HIDDEN_MENU_IDS = [
  // toolbar: format painter and clear formatting (generic UI buttons)
  'ui.operation.activate-format-painter', 'ui.command.clear-formatting',
  // Kezdolap: format group
  'sheet.command.set-range-font-family', 'sheet.command.set-range-fontsize',
  'sheet.command.set-range-font-increase', 'sheet.command.set-range-font-decrease',
  'sheet.command.set-range-bold', 'sheet.command.set-range-italic', 'sheet.command.set-range-underline',
  'sheet.command.set-range-stroke', 'sheet.command.set-range-text-color', 'sheet.command.reset-text-color',
  'sheet.command.set-background-color', 'sheet.command.reset-background-color', 'sheet.command.set-border-basic',
  // Kezdolap: layout group
  'sheet.command.set-horizontal-text-align', 'sheet.command.set-vertical-text-align', 'sheet.command.set-text-wrap',
  'sheet.command.set-shrink-to-fit', 'sheet.command.set-text-rotation', 'sheet.command.add-worksheet-merge',
  'sheet.command.add-worksheet-merge-all', 'sheet.command.add-worksheet-merge-vertical',
  'sheet.command.add-worksheet-merge-horizontal', 'sheet.command.remove-worksheet-merge',
  // Kezdolap: number group, format painter, protection
  'sheet.operation.open.numfmt.panel', 'sheet.command.numfmt.set.percent', 'sheet.command.numfmt.set.currency',
  'sheet.command.numfmt.add.decimal.command', 'sheet.command.numfmt.subtract.decimal.command',
  'sheet.command.set-once-format-painter', 'sheet.command.add-range-protection-from-toolbar',
  // context menus: paste/clear formatting, hide rows/columns, protection
  'sheet.command.paste-format', 'sheet.command.paste-besides-border', 'sheet.command.clear-selection-format',
  'sheet.command.hide-row-confirm', 'sheet.command.hide-col-confirm', 'sheet.contextMenu.permission',
  'sheet.command.add-range-protection-from-context-menu', 'sheet.command.set-range-protection-from-context-menu',
  'sheet.command.delete-range-protection-from-context-menu', 'sheet.command.view-sheet-permission-from-context-menu',
  // sheet tab menu: what a save cannot keep (copy, tab colour, hiding)
  'sheet.command.copy-sheet',
  'sheet.command.set-tab-color', 'sheet.command.set-worksheet-hidden',
  'sheet.command.add-range-protection-from-sheet-bar', 'sheet.command.delete-worksheet-protection-from-sheet-bar',
  'sheet.command.change-sheet-protection-from-sheet-bar', 'sheet.command.view-sheet-permission-from-sheet-bar',
]

// Hidden only where sheets cannot change at all (a .csv).
export var SHEET_MENU_IDS = ['sheet.command.remove-sheet-confirm', 'sheet.operation.rename-sheet']

export function hiddenMenuConfig(sheetsLocked) {
  var out = {}
  HIDDEN_MENU_IDS.forEach(function (id) { out[id] = { hidden: true } })
  if (sheetsLocked) SHEET_MENU_IDS.forEach(function (id) { out[id] = { hidden: true } })
  return out
}

// Deep merge: Univer's own mergeLocales drops untranslated keys below the second level
// (the UI then shows the raw key), so the Hungarian pack is laid over English by hand.
export function deepMerge(base, over) {
  var out = {}
  Object.keys(base).forEach(function (k) { out[k] = base[k] })
  Object.keys(over).forEach(function (k) {
    var b = out[k]
    var o = over[k]
    out[k] = b && o && typeof b === 'object' && typeof o === 'object' && !Array.isArray(b) && !Array.isArray(o) ? deepMerge(b, o) : o
  })
  return out
}

export function cellFromText(text) {
  var s = String(text == null ? '' : text)
  if (s === '') return null
  if (s.charAt(0) === '=' && s.length > 1) return { f: s }
  if (NUM_RE.test(s) && s.length < 16 && !/^-?0\d/.test(s)) return { v: Number(s), t: 2 }
  return { v: s, t: 1 }
}

/** The number format of a cell: its style is inline or an id into the snapshot's styles. */
export function cellPattern(cell, styles) {
  var s = cell && cell.s
  var st = typeof s === 'string' ? (styles || {})[s] : s
  return st && st.n && typeof st.n.pattern === 'string' ? st.n.pattern : ''
}

function patternCore(pattern) {
  return String(pattern || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
}

/** Same test as the server's isDateFormatCode (src/workbench-table.ts). */
export function isDatePattern(pattern) {
  var c = patternCore(pattern)
  return /[dmyhs]/i.test(c) && !/^[#0.,%\s-]*$/.test(c)
}

/** Excel serial (1900 system) -> "YYYY-MM-DD" or "YYYY-MM-DD HH:MM", as the server sends dates. */
export function serialToIso(serial) {
  var d = new Date(Math.round((serial - 25569) * 86400 * 1000))
  if (!isFinite(d.getTime())) return String(serial)
  var iso = d.toISOString()
  return Math.abs(serial - Math.floor(serial)) < 1e-9 ? iso.slice(0, 10) : iso.slice(0, 10) + ' ' + iso.slice(11, 16)
}

function plainNumber(n) {
  return String(Number(n.toPrecision(15)))
}

/**
 * A cell as the text the save sends. `formula` is what Univer resolved for the cell
 * (a formula filled or copied down is stored once and shared, so the cell itself may
 * carry only the shared id); `pattern` is its number format. Univer turns a typed date
 * or percent into a number plus a format, and the server cannot see the format: the
 * date goes back as "YYYY-MM-DD" and the percent as "10%", the same text a typed value
 * gave before.
 */
export function textFromCell(cell, pattern, formula) {
  if (formula) return formula.charAt(0) === '=' ? formula : '=' + formula
  if (!cell) return ''
  if (typeof cell.f === 'string' && cell.f) return cell.f.charAt(0) === '=' ? cell.f : '=' + cell.f
  if (cell.v == null) {
    if (cell.p && cell.p.body && typeof cell.p.body.dataStream === 'string') return cell.p.body.dataStream.replace(/\r\n$/, '').replace(/\r\n/g, '\n').replace(/\r$/, '')
    return ''
  }
  if (typeof cell.v === 'boolean' || cell.t === 3) return cell.v && cell.v !== 'FALSE' ? 'TRUE' : 'FALSE'
  if (typeof cell.v === 'number' && pattern) {
    if (isDatePattern(pattern)) return serialToIso(cell.v)
    if (/%/.test(patternCore(pattern))) return plainNumber(cell.v * 100) + '%'
  }
  return String(cell.v)
}
