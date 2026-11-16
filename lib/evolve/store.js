// Round persistence: ledger, patches, and the active transform chain.
//
// The protocol is generated, not stored, so "rollback" cannot be a file revert.
// The authoritative state is `active.json` (the chain of winning transforms);
// every round also writes a unified diff of the generated text, so a human can
// read exactly what changed without replaying the generator.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** sha256 of a string, the rollback anchor. */
export function sha256(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/** Split into lines, keeping a trailing-newline marker out of the diff. */
const lines = (text) => String(text ?? "").replace(/\r\n/g, "\n").split("\n");

/**
 * Unified diff between two texts, three lines of context.
 * @param before - old text.
 * @param after - new text.
 * @param name - the file label in the `---`/`+++` header.
 */
export function unifiedDiff(before, after, name = "protocol.txt") {
  const a = lines(before);
  const b = lines(after);
  const n = a.length;
  const m = b.length;

  // LCS table; the texts are a few hundred lines, so the quadratic table is fine.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", line: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: "-", line: a[i] });
      i += 1;
    } else {
      ops.push({ op: "+", line: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ op: "-", line: a[i++] });
  while (j < m) ops.push({ op: "+", line: b[j++] });

  const out = [`--- a/${name}`, `+++ b/${name}`];
  let aLine = 1;
  let bLine = 1;
  let index = 0;
  while (index < ops.length) {
    // Skip equal runs outside the context window.
    if (ops[index].op === " ") {
      index += 1;
      aLine += 1;
      bLine += 1;
      continue;
    }
    const start = Math.max(0, index - 3);
    let end = index;
    let gap = 0;
    while (end < ops.length && gap <= 6) {
      if (ops[end].op === " ") {
        gap += 1;
        end += 1;
      } else {
        gap = 0;
        end += 1;
      }
    }
    end = Math.min(ops.length, end);
    const hunk = ops.slice(start, end);
    const aStart = aLine - (index - start);
    const bStart = bLine - (index - start);
    const aCount = hunk.filter((row) => row.op !== "+").length;
    const bCount = hunk.filter((row) => row.op !== "-").length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const row of hunk) out.push(`${row.op}${row.line}`);
    for (let k = index; k < end; k += 1) {
      if (ops[k].op !== "+") aLine += 1;
      if (ops[k].op !== "-") bLine += 1;
    }
    index = end;
  }
  return `${out.join("\n")}\n`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/**
 * Open the evolve state directory.
 * @param dir - absolute path, normally `$DSH_HOME/point/evolve`.
 */
export function createStore(dir) {
  const paths = {
    root: dir,
    active: join(dir, "active.json"),
    ledger: join(dir, "ledger.jsonl"),
    state: join(dir, "state.json"),
    rounds: join(dir, "rounds"),
    patches: join(dir, "patches"),
  };
  mkdirSync(paths.rounds, { recursive: true });
  mkdirSync(paths.patches, { recursive: true });

  const empty = { version: 1, chain: [], history: [], round: 0, updatedAt: 0 };

  const store = {
    dir,
    paths,

    active() {
      const value = readJson(paths.active, empty);
      return {
        version: value.version ?? 1,
        chain: Array.isArray(value.chain) ? value.chain : [],
        history: Array.isArray(value.history) ? value.history : [],
        round: Number(value.round ?? 0),
        updatedAt: Number(value.updatedAt ?? 0),
      };
    },

    /** Persist the winning chain for a round, keeping the previous one for rollback. */
    commit(chain, meta = {}) {
      const current = store.active();
      const next = {
        version: 1,
        chain: Array.isArray(chain) ? chain : [],
        history: [...current.history, {
          round: Number(meta.round ?? current.round + 1),
          chain: current.chain,
          sha: meta.sha ?? null,
          at: Date.now(),
        }].slice(-24),
        round: Number(meta.round ?? current.round + 1),
        updatedAt: Date.now(),
      };
      writeJson(paths.active, next);
      return next;
    },

    /** Drop the last kept chain and return the restored one. */
    rollback() {
      const current = store.active();
      const last = current.history[current.history.length - 1];
      if (!last) return current;
      const next = {
        ...current,
        chain: last.chain ?? [],
        history: current.history.slice(0, -1),
        updatedAt: Date.now(),
      };
      writeJson(paths.active, next);
      return next;
    },

    ledger() {
      if (!existsSync(paths.ledger)) return [];
      return readFileSync(paths.ledger, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },

    appendLedger(record) {
      appendFileSync(paths.ledger, `${JSON.stringify(record)}\n`, "utf8");
      return record;
    },

    writeRound(record) {
      const file = join(paths.rounds, `round-${record.round}.json`);
      writeJson(file, record);
      return file;
    },

    writePatch(round, before, after) {
      const patch = unifiedDiff(before, after, "protocol.txt");
      const file = join(paths.patches, `round-${round}.patch`);
      writeFileSync(file, patch, "utf8");
      const digest = sha256(patch);
      writeFileSync(`${file}.sha256`, `${digest}  round-${round}.patch\n`, "utf8");
      return { file, sha: digest, patch };
    },

    rounds() {
      try {
        return readdirSync(paths.rounds)
          .filter((name) => /^round-\d+\.json$/.test(name))
          .map((name) => readJson(join(paths.rounds, name), null))
          .filter(Boolean)
          .sort((a, b) => a.round - b.round);
      } catch {
        return [];
      }
    },

    status() {
      const value = readJson(paths.state, null);
      return value ?? { phase: "idle", round: 0, updatedAt: 0 };
    },

    setStatus(patch) {
      const next = { ...store.status(), ...patch, updatedAt: Date.now() };
      writeJson(paths.state, next);
      return next;
    },
  };

  return store;
}
