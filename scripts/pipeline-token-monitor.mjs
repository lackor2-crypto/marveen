#!/usr/bin/env node
// pipeline-token-monitor.mjs
//
// Watches a multi-agent pipeline run (orchestrator -> planner -> implementer ->
// checker) and measures the REAL token usage of every participant, plus the
// hand-off overhead, so we can compare "several agents" vs "one agent did it all".
//
// It is deliberately host-agnostic: no owner name, agent id, path or port is
// baked in. Transcript roots and the dashboard port come from the environment
// (or sane auto-detected defaults); the dashboard token is read at call time
// from store/.dashboard-token.
//
// Ground truth for tokens = the Claude Code JSONL transcripts. Every assistant
// turn carries message.usage {input_tokens, cache_creation_input_tokens,
// cache_read_input_tokens, output_tokens} and a top-level ISO `timestamp`.
// We sum those per sessionId inside the run window. The VS Code implementer's
// cost also comes from the code-bridge task row (costUsd / numTurns) via the API.
//
// USAGE
//   node scripts/pipeline-token-monitor.mjs start  --card "#257" --card-id <id> --title "..." \
//        --orchestrator-session <sid>
//   node scripts/pipeline-token-monitor.mjs mark   --run <runId> --kind plan-requested [--note "..."] [--chars N] [--payload-file F]
//   node scripts/pipeline-token-monitor.mjs map    --run <runId> --session <sid> --role planner
//   node scripts/pipeline-token-monitor.mjs report --run <runId>
//   node scripts/pipeline-token-monitor.mjs sessions --since <iso|epoch_ms> [--until ...]   # discovery helper
//
// A run file lives in store/pipeline-runs/<runId>.json. It records the timeline
// and the sessionId->role map; `report` reads it together with the transcripts.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = process.env.PROJECT_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STORE_DIR = process.env.STORE_DIR || path.join(PROJECT_ROOT, 'store');
const RUNS_DIR = path.join(STORE_DIR, 'pipeline-runs');
const WEB_PORT = process.env.WEB_PORT || '3420';

// Where Claude Code keeps transcripts. WSL sees the Windows side under /mnt/c.
function transcriptRoots() {
  const roots = [];
  const home = os.homedir();
  roots.push(path.join(home, '.claude', 'projects'));
  // Fleet agents that run a real (isolated-account) CLAUDE_CONFIG_DIR keep their
  // transcripts OUTSIDE ~/.claude. Two isolation schemes are in use:
  //   store/accounts/<name>/projects  and  <repo>/agents/<name>/.claude-config/projects
  const globProjects = (base) => {
    try {
      for (const n of fs.readdirSync(base)) {
        for (const cand of [
          path.join(base, n, 'projects'),
          path.join(base, n, '.claude-config', 'projects'),
        ]) if (fs.existsSync(cand)) roots.push(cand);
      }
    } catch { /* dir absent -- fine */ }
  };
  globProjects(path.join(STORE_DIR, 'accounts'));
  globProjects(path.join(PROJECT_ROOT, 'agents'));
  // Windows-side homes (VS Code implementer runs there), reachable from WSL.
  const winUsers = '/mnt/c/Users';
  try {
    for (const u of fs.readdirSync(winUsers)) {
      const p = path.join(winUsers, u, '.claude', 'projects');
      if (fs.existsSync(p)) roots.push(p);
    }
  } catch { /* not on WSL / no /mnt/c -- fine */ }
  if (process.env.CLAUDE_PROJECTS_EXTRA) {
    for (const p of process.env.CLAUDE_PROJECTS_EXTRA.split(':')) if (p) roots.push(p);
  }
  return roots.filter((p) => fs.existsSync(p));
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function readToken() {
  try { return fs.readFileSync(path.join(STORE_DIR, '.dashboard-token'), 'utf8').trim(); }
  catch { return ''; }
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; } }
    else o._.push(a);
  }
  return o;
}

function ensureDirs() { fs.mkdirSync(RUNS_DIR, { recursive: true }); }
function runPath(id) { return path.join(RUNS_DIR, `${id}.json`); }
function loadRun(id) {
  const p = runPath(id);
  if (!fs.existsSync(p)) { console.error(`run not found: ${p}`); process.exit(2); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveRun(r) { fs.writeFileSync(runPath(r.runId), JSON.stringify(r, null, 2)); }

// --- transcript scan ---------------------------------------------------------
// Returns Map<sessionId, {cwd, model, turns, input, cacheCreate, cacheRead,
//   output, firstTs, lastTs, file}> for assistant turns whose timestamp falls
// inside [since, until].
function scanSessions(sinceMs, untilMs) {
  const acc = new Map();
  for (const root of transcriptRoots()) {
    let dirs;
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const dir = path.join(root, d);
      let files;
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(dir, f);
        // cheap mtime prefilter: skip files last touched before the window
        try { if (fs.statSync(fp).mtimeMs < sinceMs - 5 * 60000) continue; } catch { continue; }
        let text;
        try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
          if (!line || line.indexOf('"usage"') === -1) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.type !== 'assistant') continue;
          const ts = toMs(j.timestamp);
          if (ts == null || ts < sinceMs || (untilMs && ts > untilMs)) continue;
          const u = j.message && j.message.usage; if (!u) continue;
          const sid = j.sessionId || j.session_id || f.replace(/\.jsonl$/, '');
          let e = acc.get(sid);
          if (!e) { e = { sessionId: sid, cwd: j.cwd || '?', model: (j.message && j.message.model) || '?',
            turns: 0, input: 0, cacheCreate: 0, cacheRead: 0, output: 0, firstTs: ts, lastTs: ts, file: fp }; acc.set(sid, e); }
          e.turns++;
          e.input += u.input_tokens || 0;
          e.cacheCreate += u.cache_creation_input_tokens || 0;
          e.cacheRead += u.cache_read_input_tokens || 0;
          e.output += u.output_tokens || 0;
          if (ts < e.firstTs) e.firstTs = ts;
          if (ts > e.lastTs) e.lastTs = ts;
          if (j.message && j.message.model) e.model = j.message.model;
        }
      }
    }
  }
  return acc;
}

async function fetchCodeTasks(cardRef) {
  const tok = readToken();
  try {
    const res = await fetch(`http://localhost:${WEB_PORT}/api/code/tasks`, {
      headers: { Authorization: `Bearer ${tok}` } });
    if (!res.ok) return [];
    const j = await res.json();
    const tasks = j.tasks || [];
    return cardRef ? tasks.filter((t) => (t.cardRef || '') === cardRef) : tasks;
  } catch { return []; }
}

const fmt = (n) => n.toLocaleString('en-US');
function iso(ms) { return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '?'; }
// total tokens actually processed (a proxy for work); cache reads are cheap but
// still processed. We report the split so the reader can weight them.
function processed(e) { return e.input + e.cacheCreate + e.cacheRead + e.output; }

// --- subcommands -------------------------------------------------------------
async function main() {
  ensureDirs();
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);

  if (cmd === 'start') {
    const runId = a.run || `run-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
    const r = {
      runId, card: a.card || null, cardId: a['card-id'] || null, title: a.title || null,
      startedAt: Date.now(), endedAt: null,
      sessionMap: {}, events: [],
    };
    if (a['orchestrator-session']) { r.sessionMap[a['orchestrator-session']] = 'orchestrator'; }
    r.events.push({ ts: r.startedAt, kind: 'start', note: a.note || 'pipeline start' });
    saveRun(r);
    console.log(runId);
    return;
  }

  if (cmd === 'mark') {
    const r = loadRun(a.run);
    let chars = a.chars ? Number(a.chars) : null;
    if (a['payload-file'] && fs.existsSync(a['payload-file'])) {
      try { chars = fs.readFileSync(a['payload-file'], 'utf8').length; } catch { /* ignore */ }
    }
    const ev = { ts: Date.now(), kind: a.kind || 'note', note: a.note || '' };
    if (chars != null) { ev.payloadChars = chars; ev.payloadTokEst = Math.round(chars / 4); }
    if (a.session) ev.session = a.session;
    r.events.push(ev);
    if (a.kind === 'end') r.endedAt = ev.ts;
    saveRun(r);
    console.log(`marked ${ev.kind}${ev.payloadTokEst != null ? ` (~${ev.payloadTokEst} tok handoff)` : ''}`);
    return;
  }

  if (cmd === 'map') {
    const r = loadRun(a.run);
    r.sessionMap[a.session] = a.role;
    saveRun(r);
    console.log(`mapped ${a.session} -> ${a.role}`);
    return;
  }

  if (cmd === 'sessions') {
    const since = toMs(a.since) || (Date.now() - 6 * 3600000);
    const until = a.until ? toMs(a.until) : null;
    const acc = scanSessions(since, until);
    const rows = [...acc.values()].sort((x, y) => y.lastTs - x.lastTs);
    console.log(`# active sessions since ${iso(since)}${until ? ` until ${iso(until)}` : ''}`);
    for (const e of rows) {
      console.log(`${e.sessionId.slice(0, 8)}  ${e.model.padEnd(20)}  turns=${e.turns}  proc=${fmt(processed(e))}  out=${fmt(e.output)}  ${iso(e.firstTs)}..${iso(e.lastTs)}  cwd=${e.cwd}`);
    }
    return;
  }

  if (cmd === 'report') {
    const r = loadRun(a.run);
    const since = r.startedAt;
    const until = r.endedAt || Date.now();
    const acc = scanSessions(since, until);
    const codeTasks = await fetchCodeTasks(r.cardId ? `#${r.cardId}`.replace('##', '#') : null)
      .catch(() => []);
    // also try raw cardId (8-hex) match
    const allTasks = await fetchCodeTasks(null).catch(() => []);
    const myTasks = allTasks.filter((t) => (r.cardId && (t.cardRef === r.cardId))
      || (r.card && t.cardRef === r.card));

    console.log('='.repeat(72));
    console.log(`PIPELINE RUN REPORT  ${r.runId}`);
    console.log(`kartya: ${r.card || '?'} (${r.cardId || '?'})  ${r.title || ''}`);
    console.log(`ablak:  ${iso(since)}  ->  ${iso(until)}  (${Math.round((until - since) / 1000)}s)`);
    console.log('='.repeat(72));

    // per-session, labeled by role where known. Only sessions MAPPED to a
    // pipeline role count toward the pipeline total -- other active sessions
    // (e.g. the owner's own unrelated work on the same account) are listed
    // separately so their tokens never contaminate the measurement.
    const PIPELINE_ROLES = ['orchestrator', 'planner', 'implementer', 'checker'];
    const roleOf = (sid) => r.sessionMap[sid] || null;
    const rows = [...acc.values()].sort((x, y) => x.firstTs - y.firstTs);
    const pipeRows = rows.filter((e) => PIPELINE_ROLES.includes(roleOf(e.sessionId)));
    const otherRows = rows.filter((e) => !PIPELINE_ROLES.includes(roleOf(e.sessionId)));
    let tIn = 0, tCC = 0, tCR = 0, tOut = 0;
    console.log('\n-- Pipeline agensek token-fogyasztasa (csak a leképezett szerepek) --');
    console.log('role         session   model                turns   fresh_in  cache_wr  cache_rd    output   processed');
    for (const e of pipeRows) {
      const role = roleOf(e.sessionId);
      tIn += e.input; tCC += e.cacheCreate; tCR += e.cacheRead; tOut += e.output;
      console.log(
        `${role.padEnd(12)} ${e.sessionId.slice(0, 8)}  ${e.model.slice(0, 20).padEnd(20)} ${String(e.turns).padStart(5)}  ${String(fmt(e.input)).padStart(9)} ${String(fmt(e.cacheCreate)).padStart(9)} ${String(fmt(e.cacheRead)).padStart(9)} ${String(fmt(e.output)).padStart(9)}  ${String(fmt(processed(e))).padStart(10)}`);
    }
    console.log('-'.repeat(96));
    console.log(`${'OSSZ'.padEnd(12)} ${'--------'}  ${''.padEnd(20)} ${''.padStart(5)}  ${String(fmt(tIn)).padStart(9)} ${String(fmt(tCC)).padStart(9)} ${String(fmt(tCR)).padStart(9)} ${String(fmt(tOut)).padStart(9)}  ${String(fmt(tIn + tCC + tCR + tOut)).padStart(10)}`);
    if (otherRows.length) {
      console.log('\n-- Egyeb aktiv session az ablakban (NEM a pipeline resze, nem szamit) --');
      for (const e of otherRows) {
        console.log(`  ${(roleOf(e.sessionId) || '(nem-leképezett)').padEnd(16)} ${e.sessionId.slice(0, 8)}  ${e.model.slice(0, 18).padEnd(18)} turns=${e.turns}  processed=${fmt(processed(e))}  cwd=${e.cwd}`);
      }
      console.log('  (Pl. a tulajdonos sajat, parhuzamos munkaja ugyanazon a fiokon -- szandekosan kizarva.)');
    }

    // hand-off overhead from marked events
    const handoffs = r.events.filter((e) => e.payloadTokEst != null);
    const handoffTok = handoffs.reduce((s, e) => s + e.payloadTokEst, 0);
    console.log('\n-- Atadasi (hand-off) koltseg -- a leirasok merete, ~char/4 --');
    for (const e of handoffs) console.log(`  ${e.kind.padEnd(18)} ~${fmt(e.payloadTokEst)} tok  (${fmt(e.payloadChars)} char)`);
    console.log(`  OSSZ hand-off szoveg: ~${fmt(handoffTok)} tok`);

    // VS Code implementer cost from the code-bridge
    console.log('\n-- VS Code vegrehajto (kod-hid task) --');
    if (myTasks.length === 0) console.log('  (nincs a kartyahoz kotott kod-hid task)');
    for (const t of myTasks) {
      console.log(`  task ${String(t.id).slice(0, 8)}  status=${t.status}  turns=${t.numTurns}  costUsd=${t.costUsd}  dur=${Math.round((t.durationMs || 0) / 1000)}s  model? (transcript)`);
    }

    // timeline
    console.log('\n-- Idovonal --');
    for (const e of r.events) {
      console.log(`  ${iso(e.ts)}  ${e.kind}${e.note ? '  ' + e.note : ''}${e.payloadTokEst != null ? `  (~${fmt(e.payloadTokEst)} tok)` : ''}`);
    }

    // single-agent counterfactual (documented ESTIMATE, not a measurement)
    const orch = rows.find((e) => roleOf(e.sessionId) === 'orchestrator');
    const plan = rows.find((e) => roleOf(e.sessionId) === 'planner');
    const impl = rows.find((e) => roleOf(e.sessionId) === 'implementer');
    console.log('\n-- Egy-agens ellenpelda (BECSLES, nem meres) --');
    console.log('  Feltetel: egy agens vegigcsinalja (kartya olvasas + terv + kod + teszt + verifikacio)');
    console.log('  egyetlen kontextusban. Ekkor NINCS: kulon tervezo-kontextus betoltes, kulon');
    console.log('  vegrehajto-kontextus betoltes, es a hand-off szoveg ujraolvasasa mindket oldalon.');
    const pipelineProcessed = tIn + tCC + tCR + tOut;
    // estimate = orchestrator+checker processed (the single context that stays)
    //   + productive output of planner and implementer (kept work)
    //   - the cache/context reloads that only exist because work was split.
    const kept = (orch ? processed(orch) : 0)
      + (plan ? plan.output : 0) + (impl ? impl.output : 0);
    console.log(`  Pipeline TENYLEGES osszes feldolgozott token: ${fmt(pipelineProcessed)}`);
    console.log(`  Egy-agens BECSULT feldolgozott token (also becsles): ${fmt(kept)}`);
    console.log(`  Kulonbseg (a tobb-agens tobblet-koltsege): ~${fmt(pipelineProcessed - kept)} token`);
    console.log('  Megj.: a cache_rd token ~10% aru a fresh_in-hez kepest; a $-osszevetes a');
    console.log('  VS Code costUsd + az Opus arazas alapjan pontosithato. A becsles also korlat.');
    console.log('='.repeat(72));
    return;
  }

  console.error(`ismeretlen parancs: ${cmd || '(nincs)'}\nlasd a fejlec USAGE reszet.`);
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
