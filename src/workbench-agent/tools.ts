/**
 * TOOL REGISTRY (kanban #336, 2. fazis, spec 6 + 0.3).
 *
 * "Az agent KIZAROLAG engedelyezett toolokon keresztul dolgozhat."
 *
 * Ket dolog van itt, es semmi tobb:
 *
 *   1. MI a tool: neve, mit csinal, es a spec 0.3 szerinti metaadatai
 *      (`destructive`, `reversible`, `external_effect`).
 *   2. SZABAD-E most: a metaadatok a MEGLEVO autonomy-kategoriakra vannak
 *      KEPEZVE (`store/autonomy-config.json`), es ha a szint nem eleg, a
 *      MEGLEVO `/api/approvals` jegy szuletik -- NEM uj mechanizmus. Ezt a
 *      spec 0.3 kifejezetten kikoti ("A meglevo /api/approvals rendszert kell
 *      ujrahasznositani"), es a szint-kiertekeles ugyanaz a harom sor, amit a
 *      `routes/approvals.ts` hasznal.
 *
 * A 2. fazis MINIMALIS, BIZTONSAGOS keszlete -- csak annyi, amennyi a loopot
 * bizonyitja. A dokumentum-, kep- es video-toolok KESOBBI fazisoke.
 */
import { loadAutonomyConfig, effectiveLevel, type AutonomyConfig } from '../autonomy.js'

type AutonomyLoader = () => AutonomyConfig
let autonomyLoader: AutonomyLoader = loadAutonomyConfig

/** Csak teszthez: a beallitasok forrasanak cserelese, hogy a teszt NE irjon a
 *  valodi `store/autonomy-config.json`-be. `null` visszaallitja a valodit. */
export function setAutonomyLoaderForTest(l: AutonomyLoader | null): void {
  autonomyLoader = l || loadAutonomyConfig
}

/** A spec 0.3 szerinti technikai metaadatok. */
export interface ToolMeta {
  destructive: boolean
  reversible: boolean
  external_effect: boolean
  /** Melyik MEGLEVO autonomy-kategoriara kepezodik. `null` = mindig szabad
   *  (tiszta olvasas, nincs hatasa semmire). */
  autonomyCategory: string | null
}

export interface ToolDef extends ToolMeta {
  name: string
  /** Mit csinal -- ez megy bele az agent rendszer-uzenetebe. */
  description: string
  /** A bemenet mezoi, emberi szoval. A modell ebbol tudja, mit kell kuldenie. */
  input: string
}

/**
 * A 2. fazis eszkozei.
 *
 * Mind OLVASAS vagy a Munkapad SAJAT adatanak irasa -- egyik sem nyul a
 * felhasznalo fajljaihoz iras/torles szinten, es egyik sem kuld semmit kifele.
 * A `workItem.create`/`update` visszafordithato (a verziok megmaradnak), de
 * mar valtoztat, ezert a `marveen_selfdev`-nel szigorubb helyre nem kell
 * tenni: sajat, projekten beluli adat.
 */
export const TOOLS: ToolDef[] = [
  {
    name: 'file.read',
    description: 'Read a text file that belongs to the project folder. Returns the beginning of the file.',
    input: 'path: the file path relative to the project folder',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'project.get',
    description: 'Basic facts about the project: name, description, client, status.',
    input: '(no input)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'project.getContext',
    description: 'The measured context of the project: open cards, pending approvals, recent events.',
    input: '(no input)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'project.listFiles',
    description: 'List the files in the project folder.',
    input: '(no input)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'workItem.open',
    description: 'Open one work item of the project: its title, kind, status and current version.',
    input: 'id: the work item id',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'workItem.listVersions',
    description: 'List the versions of a work item.',
    input: 'id: the work item id',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'workItem.create',
    description: 'Create a new work item in the project (a first version is created with it).',
    input: 'title: the name of the work item; type: one of document, image, graphic, video, note',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'marveen_selfdev',
  },
  {
    name: 'workItem.update',
    description: 'Change the title or the status of an existing work item.',
    input: 'id: the work item id; title (optional); status (optional): draft, in_progress, review or done',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'marveen_selfdev',
  },
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

export function getTool(name: string): ToolDef | undefined {
  return TOOLS_BY_NAME.get(String(name || '').trim())
}

export type ToolDecision =
  /** Futhat azonnal. */
  | { kind: 'allow'; level: number }
  /** A MEGLEVO approval rendszeren keresztul kell engedelyt kerni. */
  | { kind: 'approval'; level: number; category: string }
  /** A beallitasok szerint meg kerdezni sem lehet -- a tulajdonos oldja fel. */
  | { kind: 'blocked'; level: number; category: string }

/**
 * Szabad-e ez a tool ennek az agensnek.
 *
 * Ugyanaz a harom sor, amit a `routes/approvals.ts` hasznal: kategoria ->
 * `effectiveLevel` -> 3 = onalloan mehet, 2 = jovahagyast kell kerni, 1 =
 * jelent es megall. Olvashatatlan config SEMMIT nem ad: ilyenkor a kategoriaba
 * eso tool jovahagyast ker (ugyanaz a fail-closed irany, mint ott).
 * Kategoria nelkuli (tiszta olvaso) tool mindig mehet.
 */
export function decideTool(tool: ToolDef, agentId: string): ToolDecision {
  if (!tool.autonomyCategory) return { kind: 'allow', level: 3 }
  const category = tool.autonomyCategory
  let level = 0
  try {
    const config = autonomyLoader()
    const cat = config.categories.find((c) => c.key === category)
    // Ismeretlen kategoria: nem talalgatunk jogot, jovahagyast kerunk.
    level = cat ? effectiveLevel(cat, agentId, config) : 0
  } catch {
    // Nincs vagy olvashatatlan a config (pl. friss telepites): nem ad jogot.
    level = 0
  }
  if (level >= 3) return { kind: 'allow', level }
  if (level <= 1 && level > 0) return { kind: 'blocked', level, category }
  return { kind: 'approval', level, category }
}

/** A rendszer-uzenetbe kerulo eszkoz-lista. A modell csak ezt ismerheti. */
export function toolsForPrompt(): string {
  return TOOLS.map((t) => {
    const flags = [
      t.destructive ? 'destructive' : 'non-destructive',
      t.reversible ? 'reversible' : 'irreversible',
      t.external_effect ? 'external effect' : 'no external effect',
    ].join(', ')
    return `- ${t.name}: ${t.description} Input: ${t.input}. (${flags})`
  }).join('\n')
}
