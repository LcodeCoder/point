// Post-round bug scan.
//
// The audits that produced 0.4.8 found the same shapes over and over: a literal
// placeholder that disabled a guard, `git add -A` sweeping unrelated edits into
// a round, a publish promise nobody awaited, a route that destroyed the request
// before the 413 could be written. Those are cheap to detect and expensive to
// miss, so every round re-scans the tree before it is allowed to keep anything.
//
// This is a deterministic scanner, not a model: it only reports shapes it can
// point at, with a file and a line. A finding it cannot prove is not reported.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const DEFAULT_SEVERITY = "medium";

/** Files worth scanning: the shipped library, the panel, and the scripts. */
export function listSources(workspace) {
  const out = [];
  const walk = (dir) => {
    let rows;
    try {
      rows = readdirSync(dir);
    } catch {
      return;
    }
    for (const row of rows) {
      const full = join(dir, row);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (row === "node_modules" || row === ".git" || row === "docs") continue;
        walk(full);
      } else if (/\.(js|mjs)$/.test(row)) {
        out.push(relative(workspace, full));
      }
    }
  };
  walk(join(workspace, "lib"));
  walk(join(workspace, "scripts"));
  out.push("client.js");
  return out;
}

const lib = (path) => path.startsWith("lib/");
const notCli = (path) => lib(path) && !path.endsWith("cli.js");

/**
 * Rule table. `where` narrows the file set, `test` returns a line number or 0.
 * Keep every rule cheap: this runs after each round.
 */
export const RULES = [
  {
    id: "literal-placeholder",
    severity: "high",
    where: lib,
    message: "literal {placeholder} shipped in generated text",
    test: (source) => lineOf(source, /\{(?:language|identity|operator|openingTag|maxChars)\}/),
  },
  {
    id: "git-add-all",
    severity: "high",
    where: (path) => path.endsWith("publish.js"),
    message: "stages every file in the tree, including unrelated edits",
    test: (source) => lineOf(source, /["']add["'],\s*["']-A["']/),
  },
  {
    id: "unawaited-publish",
    severity: "high",
    where: (path) => path.endsWith("engine.js"),
    message: "publish promise assigned but not awaited",
    test: (source) => lineOf(source, /record\.publish\s*=\s*(?!await\b)publisher\.publishRound\(/),
  },
  {
    id: "duplicate-branch",
    severity: "high",
    where: lib,
    message: "the same action branch appears twice",
    test: (source) => {
      const seen = new Map();
      // Only branches count; a ternary may compare the same action twice.
      for (const match of source.matchAll(/if\s*\(\s*action\s*===\s*["']([\w-]+)["']|case\s+["']([\w-]+)["']\s*:/g)) {
        const name = match[1] ?? match[2];
        const line = source.slice(0, match.index).split("\n").length;
        if (seen.has(name)) return line;
        seen.set(name, line);
      }
      return 0;
    },
  },
  {
    id: "hardcoded-home",
    severity: "high",
    where: lib,
    message: "absolute path outside the package",
    test: (source) => lineOf(source, /["'`]\/(?:Volumes|Users)\//),
  },
  {
    id: "process-exit",
    severity: "high",
    where: notCli,
    message: "library code exits the host process",
    test: (source) => lineOf(source, /process\.exit\(/),
  },
  {
    id: "shell-true",
    severity: "high",
    where: lib,
    message: "spawns a shell with interpolated arguments",
    test: (source) => lineOf(source, /shell:\s*true/),
  },
  {
    id: "unguarded-status",
    severity: "high",
    where: (path) => path === "client.js",
    message: "reads data.status.enabled without a guard",
    test: (source) => {
      // `data.status && data.status.enabled` is guarded; a bare read is not.
      for (const [index, line] of String(source ?? "").split("\n").entries()) {
        if (!/data\.status\.enabled/.test(line)) continue;
        if (/data\.status\s*&&/.test(line) || /data\.status\?\./.test(line)) continue;
        return index + 1;
      }
      return 0;
    },
  },
  {
    id: "destroy-before-reply",
    severity: "high",
    where: (path) => path.endsWith("lib/index.js"),
    message: "destroys the request before a response can be written",
    test: (source) => lineOf(source, /req\.destroy\(/),
  },
  {
    id: "empty-catch",
    severity: "medium",
    where: lib,
    message: "swallows an error with no comment or fallback",
    test: (source) => lineOf(source, /catch\s*(?:\([^)]*\))?\s*\{\s*\}/),
  },
  {
    id: "console-log",
    severity: "medium",
    where: (path) => notCli(path) || path === "client.js",
    message: "logs to stdout from library code",
    test: (source) => lineOf(source, /\bconsole\.log\(/),
  },
  {
    id: "test-only",
    severity: "medium",
    where: lib,
    message: "committed a focused test",
    test: (source) => lineOf(source, /\.only\(/),
  },
  {
    id: "sync-exec-in-host",
    severity: "medium",
    where: (path) => path.endsWith("lib/index.js"),
    message: "runs a synchronous child process on the host path",
    test: (source) => lineOf(source, /execFileSync\(/),
  },
  {
    id: "todo-marker",
    severity: "low",
    where: (path) => lib(path) && !path.endsWith("audit.js"),
    message: "unfinished marker",
    test: (source) => lineOf(source, /\b(?:TODO|FIXME)\b/),
  },
];

function lineOf(source, pattern) {
  const index = source.search(pattern);
  if (index < 0) return 0;
  return source.slice(0, index).split("\n").length;
}

/** Scan one file against the rules that apply to it. */
export function auditSource(path, source) {
  const findings = [];
  const text = String(source ?? "");
  for (const rule of RULES) {
    if (rule.where && !rule.where(path)) continue;
    const line = rule.test(text);
    if (!line) continue;
    findings.push({ rule: rule.id, severity: rule.severity, file: path, line, message: rule.message });
  }
  return findings;
}

/** Scan the package. `files` narrows the report, but every source is read. */
export function auditWorkspace({ workspace, files, contents, readFile } = {}) {
  const startedAt = Date.now();
  const read = typeof readFile === "function"
    ? (path) => readFile(path)
    : (path) => readFileSync(join(workspace, path), "utf8");
  // A proposal must be judged by what it would write, not by what is on disk
  // now: scanning the live tree let a `process.exit` in a new file pass.
  const overrides = new Map();
  for (const row of Array.isArray(contents) ? contents : []) {
    if (row && typeof row.path === "string") overrides.set(row.path, String(row.content ?? ""));
  }
  // Always scan the whole tree: a change in one file can only be judged next to
  // the rules that file is not allowed to keep. `files` narrows the report, not
  // the reading.
  const paths = workspace ? listSources(workspace) : (Array.isArray(files) ? files : []);
  for (const path of overrides.keys()) if (!paths.includes(path)) paths.push(path);
  const wanted = Array.isArray(files) && files.length ? new Set(files) : null;
  const findings = [];
  const scanned = [];
  for (const path of paths) {
    let source;
    try {
      source = overrides.has(path) ? overrides.get(path) : read(path);
    } catch {
      continue;
    }
    if (source == null) continue;
    scanned.push(path);
    findings.push(...auditSource(path, source));
  }
  const reported = wanted ? findings.filter((row) => wanted.has(row.file)) : findings;
  return summarize(reported, { scanned, ms: Date.now() - startedAt });
}

/**
 * Scan the text a prompt round is about to keep: placeholders, persona needles,
 * envelope balance and banned phrases. Cheap, and it is the same check the
 * guard does, so a keep cannot disagree with the panel.
 */
export function auditPayload({ text, identity, operator, language, lint } = {}) {
  const findings = [];
  const body = String(text ?? "");
  const at = (pattern) => {
    const index = body.search(pattern);
    return index < 0 ? 0 : body.slice(0, index).split("\n").length;
  };

  if (at(/\{(?:language|identity|operator|openingTag|maxChars)\}/)) {
    findings.push({ rule: "literal-placeholder", severity: "high", file: "payload", line: at(/\{(?:language|identity|operator|openingTag|maxChars)\}/), message: "literal {placeholder} in the payload" });
  }
  for (const [label, needle] of [["identity", identity], ["operator", operator], ["language", language]]) {
    if (needle && !body.includes(String(needle))) {
      findings.push({ rule: `persona-${label}`, severity: "high", file: "payload", line: 1, message: `persona needle missing: ${needle}` });
    }
  }
  const opens = (body.match(/<\|im_start\|>/g) ?? []).length;
  const closes = (body.match(/<\|im_end\|>/g) ?? []).length;
  if (opens !== closes) {
    findings.push({ rule: "envelope-unbalanced", severity: "high", file: "payload", line: 1, message: `im_start ${opens} vs im_end ${closes}` });
  }
  if (typeof lint === "function") {
    let hits = [];
    try {
      hits = lint(body) ?? [];
    } catch {
      hits = [];
    }
    for (const hit of hits.slice(0, 8)) {
      findings.push({ rule: "banned-phrase", severity: "high", file: "payload", line: hit.line ?? 1, message: String(hit.term ?? hit.message ?? "banned phrase") });
    }
  }
  return summarize(findings, { scanned: ["payload"], ms: 0 });
}

/** Group findings by severity and decide whether a round may keep. */
export function summarize(findings = [], extra = {}) {
  const rows = findings.filter(Boolean);
  const count = (severity) => rows.filter((row) => row.severity === severity).length;
  const high = count("high");
  const medium = count("medium");
  const low = count("low");
  return {
    ok: high === 0,
    high,
    medium,
    low,
    findings: rows,
    scanned: extra.scanned ?? [],
    ms: extra.ms ?? 0,
  };
}

/** One line for the ledger and the panel. */
export function describeAudit(audit) {
  if (!audit) return "not run";
  if (!audit.findings?.length) return `clean (${audit.scanned?.length ?? 0} files)`;
  const head = audit.findings.slice(0, 3).map((row) => `${row.rule}@${row.file}:${row.line}`).join(", ");
  return `${audit.high} high / ${audit.medium} medium — ${head}`;
}
