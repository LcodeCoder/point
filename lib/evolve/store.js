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

/** Sanitize a file path into a safe, collision-free backup name. */
function backupName(path) {
  const raw = String(path);
  const flat = raw.replace(/[^a-zA-Z0-9._-]+/g, "__");
  // `lib/a/b.js` and `lib/a__b.js` both flatten to `lib__a__b.js`; append a
  // short digest of the raw path so aliases cannot share one backup file.
  return `${flat}.${sha256(raw).slice(0, 8)}`;
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
  // Rows carry the trailing-newline state: git treats a final line without a
  // newline as a *different line* than the same text with one, so line
  // equality must too. Ignoring it made tail-append patches apply-but-corrupt
  // (git consumed the separator line's newline) and tail-delete patches
  // outright refused.
  const split = (text) => {
    const normalized = String(text ?? "").replace(/\r\n/g, "\n");
    const endsWithNewline = normalized.endsWith("\n");
    if (normalized === "") return { rows: [] };
    const parts = (endsWithNewline ? normalized.slice(0, -1) : normalized).split("\n");
    return {
      rows: parts.map((line, index) => ({
        text: line,
        noNl: index === parts.length - 1 && !endsWithNewline,
      })),
    };
  };
  const left = split(before);
  const right = split(after);
  const a = left.rows;
  const b = right.rows;
  const n = a.length;
  const m = b.length;
  const same = (x, y) => x.text === y.text && x.noNl === y.noNl;

  // LCS table; the texts are a few hundred lines, so the quadratic table is fine.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = same(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) {
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
  // Line numbers at every op boundary, so a hunk header is a lookup.
  const aAt = new Uint32Array(ops.length + 1);
  const bAt = new Uint32Array(ops.length + 1);
  aAt[0] = 1;
  bAt[0] = 1;
  for (let k = 0; k < ops.length; k += 1) {
    aAt[k + 1] = aAt[k] + (ops[k].op !== "+" ? 1 : 0);
    bAt[k + 1] = bAt[k] + (ops[k].op !== "-" ? 1 : 0);
  }
  const changes = [];
  for (let k = 0; k < ops.length; k += 1) if (ops[k].op !== " ") changes.push(k);
  // Changes separated by six equal lines share context; emitting two hunks
  // there duplicates those lines and `git apply` refuses the patch.
  let g = 0;
  while (g < changes.length) {
    const first = changes[g];
    let last = first;
    let h = g + 1;
    while (h < changes.length && changes[h] - last <= 7) {
      last = changes[h];
      h += 1;
    }
    const start = Math.max(0, first - 3);
    const end = Math.min(ops.length, last + 4);
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((row) => row.op !== "+").length;
    const bCount = hunk.filter((row) => row.op !== "-").length;
    const aStart = aCount ? aAt[start] : aAt[start] - 1;
    const bStart = bCount ? bAt[start] : bAt[start] - 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const row of hunk) {
      out.push(`${row.op}${row.line.text}`);
      // The marker belongs directly after the line it describes. `noNl` is only
      // ever true for a side's final row, and a context row matches on both
      // sides (equality includes the flag), so one marker per row is exact.
      if (row.line.noNl) out.push("\\ No newline at end of file");
    }
    g = h;
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
export function createStore(dir, { readOnly = false } = {}) {
  const paths = {
    root: dir,
    active: join(dir, "active.json"),
    ledger: join(dir, "ledger.jsonl"),
    state: join(dir, "state.json"),
    rounds: join(dir, "rounds"),
    patches: join(dir, "patches"),
    code: join(dir, "code"),
    log: join(dir, "evolve.log"),
  };
  if (!readOnly) {
    mkdirSync(paths.rounds, { recursive: true });
    mkdirSync(paths.patches, { recursive: true });
    mkdirSync(paths.code, { recursive: true });
  }

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

    /**
     * Start a new cycle: keep the winning chain, reset the round budget.
     * The ledger is archived rather than truncated, so round numbering can
     * restart at 1 without losing the previous cycle's history.
     */
    newCycle() {
      const current = store.active();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      // The ledger alone is not the evidence: rounds/, patches/ and code/ are
      // keyed by round number and would be overwritten by the next cycle.
      if (existsSync(paths.ledger)) renameSync(paths.ledger, join(paths.root, `ledger-${stamp}.jsonl`));
      for (const key of ["rounds", "patches", "code"]) {
        const from = paths[key];
        if (from && existsSync(from)) renameSync(from, join(paths.root, `${key}-${stamp}`));
      }
      for (const key of ["rounds", "patches", "code"]) {
        if (paths[key]) mkdirSync(paths[key], { recursive: true });
      }
      const next = { ...current, round: 0, history: [], updatedAt: Date.now() };
      writeJson(paths.active, next);
      return next;
    },

    /** Advance the round counter without touching the winning chain. */
    tick(round) {
      const current = store.active();
      const next = { ...current, round: Math.max(current.round, Number(round) || 0), updatedAt: Date.now() };
      writeJson(paths.active, next);
      return next;
    },

    /**
     * Keep the pre-change copy of every file a code round touched.
     * Rollback restores these bytes; the patch file alone cannot.
     */
    writeCode(round, files) {
      const folder = join(paths.code, `round-${round}`);
      mkdirSync(folder, { recursive: true });
      const manifest = files.map((file) => {
        const name = backupName(file.path);
        const backup = join(folder, name);
        const created = file.before === null || file.before === undefined;
        // A created file has no previous bytes: remember that, so a rollback
        // deletes it instead of leaving an empty stub behind.
        if (!created) writeFileSync(backup, String(file.before), "utf8");
        return {
          path: file.path,
          backup,
          created,
          before_chars: created ? 0 : String(file.before).length,
          after_chars: String(file.after ?? "").length,
        };
      });
      writeJson(join(folder, "manifest.json"), manifest);
      return { folder, manifest };
    },

    /** Read back the pre-change bytes for a code round. */
    restoreCode(round) {
      const folder = join(paths.code, `round-${round}`);
      const manifest = readJson(join(folder, "manifest.json"), null);
      if (!Array.isArray(manifest)) return [];
      return manifest
        .filter((row) => row.created || existsSync(row.backup))
        .map((row) => (row.created
          ? { path: row.path, content: null, remove: true }
          : { path: row.path, content: readFileSync(row.backup, "utf8") }));
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
      const attempt = Number(record?.attempt ?? 0);
      const suffix = attempt > 1 ? `-attempt-${attempt}` : "";
      const file = join(paths.rounds, `round-${record.round}${suffix}.json`);
      writeJson(file, record);
      return file;
    },

    /** Append one line to the human log. Never throws: logging must not break a round. */
    appendLog(line) {
      try {
        appendFileSync(paths.log, `${String(line)}\n`, "utf8");
      } catch {
        // A full disk must not cost a round.
      }
    },

    /** The tail of the human log, oldest first. */
    log(limit = 40) {
      try {
        return readFileSync(paths.log, "utf8").trimEnd().split("\n").slice(-Math.max(1, limit));
      } catch {
        return [];
      }
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
          .filter((name) => /^round-\d+(-attempt-\d+)?\.json$/.test(name))
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
