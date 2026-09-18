import { describe, it, expect } from "vitest";
import {
  classifyChange,
  runGate,
  parseDenylist,
  contentSignature,
  EMPTY_DENYLIST,
  type Denylist,
} from "../upstream-principle-gate.js";

const D = EMPTY_DENYLIST;

describe("upstream principle gate -- RED principles auto-exclude", () => {
  it("agent-differentiation (main-only capability) is excluded", () => {
    const v = classifyChange(
      { path: "src/web/agent-scaffold.ts", subjects: "feat: grant MAIN_ONLY tool access", addedLines: [] },
      D,
    );
    expect(v.verdict).toBe("exclude");
    expect(v.principleId).toBe("agent-equality");
  });

  it("hardcoded identity in an executable line is excluded", () => {
    const v = classifyChange(
      { path: "src/foo.ts", subjects: "feat: wire path", addedLines: ['const home = "/home/someuser/marveen";'] },
      D,
    );
    expect(v.verdict).toBe("exclude");
    expect(v.principleId).toBe("host-agnostic-identity");
  });

  it("a NAME in a comment line is NOT excluded (comments may name people)", () => {
    const v = classifyChange(
      { path: "src/foo.ts", subjects: "feat: note", addedLines: ["// requested by the owner at /home/someuser"] },
      D,
    );
    expect(v.verdict).not.toBe("exclude");
  });

  it("forced context cap (auto-/clear) is excluded", () => {
    const v = classifyChange(
      { path: "src/context-guard.ts", subjects: "feat: auto-/clear at context cap 150k", addedLines: [] },
      D,
    );
    expect(v.verdict).toBe("exclude");
    expect(v.principleId).toBe("no-forced-context-cap");
  });

  it("auto-done kanban move is excluded", () => {
    const v = classifyChange(
      { path: "src/web/kanban.ts", subjects: "feat: automatically move cards to done when tests pass", addedLines: [] },
      D,
    );
    expect(v.verdict).toBe("exclude");
    expect(v.principleId).toBe("no-auto-done");
  });
});

describe("upstream principle gate -- GREEN protective guards allowed", () => {
  it("wallet/keret guard is allowed even though it is a guard", () => {
    const v = classifyChange(
      { path: "src/quota-gate.ts", subjects: "feat(quota): rate-limit guard holds back heartbeats when keret runs dry", addedLines: [] },
      D,
    );
    expect(v.verdict).toBe("allow");
    expect(v.source).toBe("green");
  });

  it("data/integrity guard (backup/homoglyph) is allowed", () => {
    const v = classifyChange(
      { path: "src/homoglyph.ts", subjects: "feat: homoglyph gate on durable write paths", addedLines: [] },
      D,
    );
    expect(v.verdict).toBe("allow");
    expect(v.source).toBe("green");
  });
});

describe("upstream principle gate -- FLAG principles need discussion", () => {
  it("a new non-protective gate is flagged", () => {
    const v = classifyChange(
      { path: "src/web/new-thing.ts", subjects: "feat: add approval gate before publishing", addedLines: [] },
      D,
    );
    expect(v.verdict).toBe("discuss");
  });

  it("a UI-text file change is flagged for bilingual review", () => {
    const v = classifyChange({ path: "web/app.js", subjects: "feat: add a button label", addedLines: [] }, D);
    expect(v.verdict).toBe("discuss");
    expect(v.principleId).toBe("bilingual-parity-risk");
  });
});

describe("upstream principle gate -- neutral change allowed", () => {
  it("an ordinary fix with no signals is allowed", () => {
    const v = classifyChange({ path: "src/util.ts", subjects: "fix: correct off-by-one", addedLines: ["i = i + 1;"] }, D);
    expect(v.verdict).toBe("allow");
    expect(v.source).toBe("default");
  });
});

describe("upstream principle gate -- committed denylist", () => {
  it("a path on the denylist is excluded", () => {
    const dl: Denylist = {
      version: 1,
      entries: [
        { principle: "no-auto-done", pathPattern: "src/evil/**", note: "banned earlier", decidedAt: "2026-09-18", decidedBy: "owner" },
      ],
    };
    const v = classifyChange({ path: "src/evil/x.ts", subjects: "feat: whatever", addedLines: [] }, dl);
    expect(v.verdict).toBe("exclude");
    expect(v.source).toBe("denylist");
  });
});

describe("upstream principle gate -- denylist validation + signature", () => {
  it("parseDenylist accepts the empty ledger", () => {
    expect(parseDenylist({ version: 1, entries: [] })).toEqual({ version: 1, entries: [] });
  });

  it("parseDenylist rejects an unknown principle", () => {
    expect(() =>
      parseDenylist({ version: 1, entries: [{ principle: "made-up", pathPattern: "x", note: "", decidedAt: "", decidedBy: "" }] }),
    ).toThrow(/unknown principle/);
  });

  it("parseDenylist rejects an entry with neither pathPattern nor contentSignature", () => {
    expect(() =>
      parseDenylist({ version: 1, entries: [{ principle: "no-auto-done", note: "", decidedAt: "", decidedBy: "" }] }),
    ).toThrow(/pathPattern or contentSignature/);
  });

  it("contentSignature is order- and whitespace-independent", () => {
    expect(contentSignature(["a = 1", "b = 2"])).toBe(contentSignature([" b  =  2 ", "a = 1"]));
  });
});

describe("upstream principle gate -- false-positive guards (do NOT auto-drop good fixes)", () => {
  it("a legit privilege-check fix is NOT excluded as agent-differentiation", () => {
    const v = classifyChange(
      { path: "src/security.ts", subjects: "fix: correct privilege check for file access", addedLines: [] },
      D,
    );
    expect(v.verdict).not.toBe("exclude");
  });

  it("but a genuinely privileged-main-agent change IS excluded", () => {
    const v = classifyChange(
      { path: "src/x.ts", subjects: "feat: give the privileged main agent extra tools", addedLines: [] },
      D,
    );
    expect(v.verdict).toBe("exclude");
    expect(v.principleId).toBe("agent-equality");
  });

  it("'150k' in an unrelated context (backup size) is NOT excluded", () => {
    const v = classifyChange(
      { path: "src/backup.ts", subjects: "fix: cap backup chunk size at 150k for memory", addedLines: [] },
      D,
    );
    expect(v.verdict).not.toBe("exclude");
  });

  it("'50%' in an unrelated context (UI opacity) is NOT excluded", () => {
    const v = classifyChange(
      { path: "src/ui.ts", subjects: "feat: dim disabled buttons to 50% opacity", addedLines: [] },
      D,
    );
    expect(v.verdict).not.toBe("exclude");
  });

  it("but a real context-window cap IS still excluded", () => {
    const v = classifyChange(
      { path: "src/ctx.ts", subjects: "feat: proactive auto-/clear at 150k context window", addedLines: [] },
      D,
    );
    expect(v.verdict).toBe("exclude");
    expect(v.principleId).toBe("no-forced-context-cap");
  });

  it("a change that PREVENTS auto-done is NOT excluded (it aligns with us)", () => {
    const v = classifyChange(
      { path: "src/kanban.ts", subjects: "fix: prevent auto-move to done on close", addedLines: [] },
      D,
    );
    expect(v.verdict).not.toBe("exclude");
  });
});

describe("upstream principle gate -- broadened identity detection", () => {
  it("a hardcoded /mnt path literal is excluded", () => {
    const v = classifyChange(
      { path: "src/net.ts", subjects: "fix: wire path", addedLines: ['const p = "/mnt/f/data";'] },
      D,
    );
    expect(v.verdict).toBe("exclude");
    expect(v.principleId).toBe("host-agnostic-identity");
  });

  it("a hardcoded gitlab repo URL is excluded", () => {
    const v = classifyChange(
      { path: "src/repo.ts", subjects: "feat: default remote", addedLines: ['const url = "https://gitlab.com/foo/bar.git";'] },
      D,
    );
    expect(v.verdict).toBe("exclude");
    expect(v.principleId).toBe("host-agnostic-identity");
  });
});

describe("upstream principle gate -- empty added-lines cannot collide with a signature entry", () => {
  it("an empty-diff change does not match a contentSignature denylist entry", () => {
    const emptySig = contentSignature([]);
    const dl: Denylist = {
      version: 1,
      entries: [{ principle: "no-auto-done", contentSignature: emptySig, note: "x", decidedAt: "", decidedBy: "" }],
    };
    const v = classifyChange({ path: "src/whatever.ts", subjects: "fix: delete dead code", addedLines: [] }, dl);
    expect(v.source).not.toBe("denylist");
  });
});

describe("upstream principle gate -- fresh install / zero-means-two-things", () => {
  it("no changes is 'nothing to review', not a crash", () => {
    const r = runGate([], D);
    expect(r.reviewed).toBe(0);
    expect(r.exclude).toEqual([]);
    expect(r.discuss).toEqual([]);
    expect(r.allow).toEqual([]);
  });

  it("runGate tallies the three buckets", () => {
    const r = runGate(
      [
        { path: "src/a.ts", subjects: "feat: grant MAIN_ONLY access" }, // exclude
        { path: "web/app.js", subjects: "feat: label" }, // discuss
        { path: "src/b.ts", subjects: "fix: typo" }, // allow
      ],
      D,
    );
    expect(r.exclude.length).toBe(1);
    expect(r.discuss.length).toBe(1);
    expect(r.allow.length).toBe(1);
  });
});
