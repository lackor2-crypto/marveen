// #823 (owner TG 4151/4154/4193): regression locks for fixes that landed without a test. Each test pins the distinctive
// line of the fix to the file that carries it, so deleting or rewriting the fix turns this red. These are source
// contracts (they cannot see runtime): the commit hash in each name is where the fix and its reason live.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = (f: string): string => readFileSync(f, 'utf8')

const LOCKS: { commit: string; what: string; file: string; line: string }[] = [
 {
  "commit": "b95ca8a3",
  "what": "#799 limit-reset wakes are staggered per agent",
  "file": "src/web/limit-wake-runner.ts",
  "line": "export const LIMIT_WAKE_STAGGER_MS = Number.isFinite(Number(process.env['LIMIT_WAKE_STAGGER_MS'])) && process.env['LIMIT_WAKE_STAGGER_MS'] !== undefined"
 },
 {
  "commit": "b95ca8a3",
  "what": "#799 each account agent is woken separately",
  "file": "src/web/limit-wake-runner.ts",
  "line": "staggered: group.length > 1 }, 'limit-wake: waking account agent')"
 },
 {
  "commit": "db742492",
  "what": "#773 Drive storage table only for connected accounts",
  "file": "src/web/routes/drive-sync.ts",
  "line": "const bekotott = new Set(loadSyncConfig().pairs.map((p) => String(p.account || '')).filter(Boolean))"
 },
 {
  "commit": "db742492",
  "what": "#773 Drive storage guidance when nothing is connected",
  "file": "web/app.js",
  "line": "list.innerHTML = '<p class=\"subtitle\" style=\"margin:0\">' + escapeHtml(t('drive.quota_not_connected')) + '</p>'"
 },
 {
  "commit": "9b34f539",
  "what": "#709 rename toast tells when the folder kept its name",
  "file": "web/workbench.js",
  "line": "window.showToast(t(fr && fr.ok === true && fr.reason === 'name_taken' ? 'workbench.rename.folder_taken'"
 },
 {
  "commit": "faf9c2ca",
  "what": "update finalizer polls the dashboard up to 150 s",
  "file": "update.sh",
  "line": "_health() { local i=0 max=\"${1:-150}\"; while [ \"$i\" -lt \"$max\" ]; do"
 },
 {
  "commit": "e83c4b6d",
  "what": "git: the account key beats the machine-wide gh credential helper",
  "file": "src/git-accounts.ts",
  "line": "env[`GIT_CONFIG_KEY_${n}`] = 'credential.https://github.com.helper'"
 },
 {
  "commit": "68cd5202",
  "what": "#711 font size can be changed again after 36 pt",
  "file": "web/workbench.js",
  "line": "var big = (dpRoot() || el).querySelectorAll('[style*=\"xxx-large\"], font[size=\"7\"]')"
 },
 {
  "commit": "a0e67b4e",
  "what": "#669 subtitle after the video end is warned about",
  "file": "web/workbench.js",
  "line": "if (typeof start === 'number' && typeof len === 'number' && len > 0 && start >= len) window.showToast(t('workbench.vt.sub_after_end', { s: vtSecs(len) }))"
 },
 {
  "commit": "a0e67b4e",
  "what": "#669 editor keys work right after pressing Play",
  "file": "web/workbench.js",
  "line": "if (b) b.addEventListener('click', function (e) { if (e.detail > 0 && typeof b.blur === 'function') b.blur() })"
 },
 {
  "commit": "e59e59be",
  "what": "a source marked not_found only for a missing file is re-verified",
  "file": "src/workbench-docmodel.ts",
  "line": "AND (s.verdict = 'pending' OR (s.verdict = 'not_found' AND s.detail = 'the file is not in the project folder'))"
 },
 {
  "commit": "921acf83",
  "what": "#649 a table opened for editing keeps a live grid preview",
  "file": "web/workbench.js",
  "line": "esc(t('workbench.dp.tbl_editing'))"
 },
 {
  "commit": "07dcf0b5",
  "what": "#564 a Style change reaches every selected paragraph",
  "file": "web/workbench.js",
  "line": "for (var i = 0; i < titles.length; i++) { try { if (r.range.intersectsNode(titles[i])) out.push(titles[i]) } catch (_e) { /* detached */ } }"
 },
 {
  "commit": "a4cb00e2",
  "what": "#562 dragging a picture keeps it in the text",
  "file": "web/workbench.js",
  "line": "dpCall('PATCH', '/blocks/' + encodeURIComponent(bid), { section: hsec.id, position: ni }).then(function (o) { if (o) render() })"
 },
 {
  "commit": "3681dadd",
  "what": "#529 the open-file answer does not wait for the task cleanup",
  "file": "src/open-in-file-manager.ts",
  "line": "if (opensInFlight === 0) void sweepLegacyOpenFile()"
 },
 {
  "commit": "4fd359f9",
  "what": "#508 the Uploads list refreshes after a change",
  "file": "web/workbench.js",
  "line": "if (!r.ok || WB.selectedId !== id || !WB.detail || !r.data) return"
 },
 {
  "commit": "e9c73b4f",
  "what": "#501 the work item is the top row of its folder",
  "file": "web/workbench.js",
  "line": "mixed.sort(function (a, b) { return (a.it ? 0 : 1) - (b.it ? 0 : 1) || nameCmp(a, b) })"
 },
 {
  "commit": "589cc721",
  "what": "#501 an item whose file lies outside the box is shown once",
  "file": "web/workbench.js",
  "line": "items.forEach(function (it) { if (it.source_path && outItemByRel[it.source_path] === it) return; (byPlace[place[it.id]] = byPlace[place[it.id]] || []).push(it) })"
 },
 {
  "commit": "066fe471",
  "what": "#501 the picture context menu asks what the item should be",
  "file": "web/workbench.js",
  "line": "esc(t('workbench.file.to_item_head'))"
 },
 {
  "commit": "4069c56b",
  "what": "#482 the kanban board keeps its scroll across a re-render",
  "file": "web/app.js",
  "line": "if (cb.scrollTop) keepCols[(lane.dataset.group || '') + '::' + (cb.dataset.status || '')] = cb.scrollTop"
 },
 {
  "commit": "bc0a5f10",
  "what": "#482 every Workbench scroll box keeps its place",
  "file": "web/workbench.js",
  "line": "var cls = typeof n.className === 'string' ? n.className : (n.className && typeof n.className.baseVal === 'string' ? n.className.baseVal : '')"
 },
 {
  "commit": "0030077d",
  "what": "#462 outline input error also says too long",
  "file": "src/web/routes/workbench.ts",
  "line": "(egy bekezdés legfeljebb 20 000 karakter)"
 },
 {
  "commit": "fbeeb599",
  "what": "#462 touch/narrow screens get a ... button on the item row",
  "file": "web/workbench.js",
  "line": "data-wb-act=\"item-ctx\" data-wb-id=\"' + escA(it.id) + '\" aria-haspopup=\"menu\"'"
 },
 {
  "commit": "dfde40b6",
  "what": "#462 Simple view frame height does not depend on the scroll position",
  "file": "web/workbench.js",
  "line": "var hdr = fr && typeof fr.getBoundingClientRect === 'function' ? body.getBoundingClientRect().top - fr.getBoundingClientRect().top : 0"
 },
 {
  "commit": "f4e30507",
  "what": "#462 a full re-render keeps the page scroll",
  "file": "web/workbench.js",
  "line": "if (keep.wy && typeof window.scrollTo === 'function') window.scrollTo(window.scrollX || 0, keep.wy)"
 },
 {
  "commit": "bbeb1f45",
  "what": "#736 Life-move has an own Already sent button for other documents",
  "file": "web/workbench.js",
  "line": "if (unsentGate(f.item_id)) list.appendChild(gateBox(f.item_id, t('workbench.lifemove.gate_unsent_other', { title: f.item_title || '' })))"
 }
]

describe('fixes that landed without a test are locked (#823)', () => {
  for (const l of LOCKS) {
    it(`${l.what} (${l.commit})`, () => { expect(src(l.file)).toContain(l.line) })
  }
})
