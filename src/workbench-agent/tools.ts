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
    input: 'title: the name of the work item; type: one of document, image, graphic, video, note, composite (pick composite when it will hold text AND images together). The type is only a label: parts can be added to any work item.',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'marveen_selfdev',
  },
  {
    name: 'workItem.update',
    description: 'Change the title or the status of an existing work item.',
    input: 'id: the work item id; title (optional); status (optional): draft, in_progress, review or done',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'marveen_selfdev',
  },
  {
    name: 'workItem.listParts',
    description: 'List the parts of a work item (text blocks and images, in order). A work item may mix both, for example a social post with a photo and a caption.',
    input: 'id: the work item id (optional, defaults to the open one)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'workItem.addPart',
    description: 'Add a part to a work item: a text block, or an image that already exists in the project folder. This is how one work item can hold text AND a picture at the same time.',
    input: 'id: the work item id (optional, defaults to the open one); kind: text or image; text: the text (for a text part); path: the image file inside the project folder (for an image part); caption (optional)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'marveen_selfdev',
  },
  {
    name: 'file.preview',
    description: 'Ask whether a file of the project folder can be shown to the owner, and how (pdf, image, video, audio or text). It does not change anything.',
    input: 'path: the file path relative to the project folder',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'document.toPdf',
    description: 'Make a PDF from an office document (docx, xlsx, pptx, odt, ...) of the project folder, so it can be shown to the owner. The original file is NOT touched; the PDF goes into a derived cache. If LibreOffice is not installed on this machine, the answer says exactly that -- then tell the owner what is missing instead of guessing.',
    input: 'path: the document inside the project folder',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'file.write',
    description: 'Write a text file into the project folder. It NEVER overwrites: if the name is taken, the file is saved under a free name and the answer says so.',
    input: 'path: the file path relative to the project folder (subfolders allowed); text: the content',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'workbench_file_write',
  },
  {
    name: 'file.copy',
    description: 'Copy a file inside the project folder. It never overwrites: a taken name gets a free one.',
    input: 'path: the source file, relative to the project folder; to: the target file path, relative to the project folder',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'workbench_file_write',
  },
  {
    name: 'file.move',
    description: 'Move a file into another folder inside the project folder. The name stays the same.',
    input: 'path: the file, relative to the project folder; to: the target FOLDER, relative to the project folder (empty string means the project folder itself)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'workbench_file_write',
  },
  {
    name: 'file.rename',
    description: 'Rename a file inside the project folder. It stays in the same folder.',
    input: 'path: the file, relative to the project folder; name: the new file name',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'workbench_file_write',
  },
  {
    name: 'file.delete',
    description: 'Move a file of the project folder to the Trash of the Depot. It is not erased: the owner can take it back from the Trash.',
    input: 'path: the file, relative to the project folder',
    destructive: true, reversible: true, external_effect: false, autonomyCategory: 'data_delete',
  },
  {
    name: 'project.listWorkItems',
    description: 'List the work items of the project with their status and current version.',
    input: '(no input)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'project.listKanban',
    description: 'List the open kanban cards bound to this project.',
    input: '(no input)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'workItem.createVersion',
    description: 'Save the current state of a work item as a new version (a snapshot). Nothing is overwritten.',
    input: 'id: the work item id (optional, defaults to the open one)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'marveen_selfdev',
  },
  {
    name: 'workItem.restoreVersion',
    description: 'Restore an earlier version of a work item. The earlier version is NOT overwritten and the later versions are NOT deleted: the restore writes a NEW version.',
    input: 'id: the work item id (optional, defaults to the open one); version: the id of the version to restore',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'marveen_selfdev',
  },
  {
    name: 'workItem.compareVersions',
    description: 'Compare two versions of a work item: which parts were added, removed or changed. It does not change anything.',
    input: 'id: the work item id (optional, defaults to the open one); from: the id of the older version; to: the id of the newer version',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'canvas.get',
    description: 'Read the structured drawing (canvas) of a work item: its size and every object on it with its stable id. If there is no drawing yet, the answer says so and gives an empty canvas -- that is a starting point, not an error.',
    input: 'id: the work item id (optional, defaults to the open one)',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: null,
  },
  {
    name: 'canvas.edit',
    description: 'Change the structured drawing (canvas) of a work item with a list of operations, and save the result as a NEW version (nothing is overwritten). Objects are addressed by their stable id, so "make the headline 30% bigger and centre it" is two operations on the same id. Read the canvas first with canvas.get to learn the ids.',
    input: 'id: the work item id (optional, defaults to the open one); ops: the list of operations. Each one is an object: {op:"add", object:{type:"text"|"rect"|"image", ...}}, {op:"update", id, patch:{...}}, {op:"remove", id}, {op:"move", id, dx, dy}, {op:"center", id, axis:"x"|"y"|"both"}, {op:"scale", id, factor} (1.3 = 30% bigger), {op:"order", id, to:"front"|"back"|"up"|"down"}, or {op:"canvas", width, height, background}. A text object has text, fontSize, color (#rrggbb), align, bold, italic; a rect has fill and radius; an image has src (a picture inside the project folder).',
    destructive: false, reversible: true, external_effect: false, autonomyCategory: 'workbench_file_write',
  },
  {
    name: 'kanban.create',
    description: 'Open a kanban card. Code fixes and development tasks are NOT work items: they belong on the kanban board. The card is always bound to THIS project, whatever the request says. ONE PROJECT = ONE CARD: if an open card already covers this work (a sub-task, a new bug in it, its next phase), do not open a new card -- the server refuses it; tell the owner to continue on that card.',
    input: 'title: the card title; description (optional); priority (optional): low, normal, high or urgent; related (optional): the ids of cards this one relates to, or an empty list if there is none; separate_project (optional): only if it relates to an open card but is truly a separate project, why (at least 15 characters)',
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
