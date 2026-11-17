import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditPayload, auditSource, auditWorkspace, describeAudit } from "../lib/evolve/audit.js";
import { exportedNames } from "../lib/evolve/proposer.js";
import { createEvolve } from "../lib/evolve/engine.js";
import { createStore } from "../lib/evolve/store.js";

const rules = (path, source) => auditSource(path, source).map((row) => row.rule);

test("the scanner reports the shapes that caused real regressions", () => {
  assert.deepEqual(rules("lib/evolve/publish.js", 'await run(["git", "add", "-A"]);'), ["git-add-all"]);
  assert.deepEqual(rules("lib/evolve/engine.js", "record.publish = publisher.publishRound(record);"), ["unawaited-publish"]);
  assert.deepEqual(rules("lib/index.js", 'if (action === "repo") one(); if (action === "repo") two();'), ["duplicate-branch"]);
  assert.deepEqual(rules("lib/protocol.js", "语言：{language}"), ["literal-placeholder"]);
  assert.deepEqual(rules("lib/index.js", 'const p = "/Volumes/new/point";'), ["hardcoded-home"]);
  assert.deepEqual(rules("client.js", "if (data.status.enabled) render();"), ["unguarded-status"]);
  assert.deepEqual(rules("lib/index.js", "req.destroy(); res.end();"), ["destroy-before-reply"]);
});

test("a rule only fires on the files it applies to", () => {
  assert.deepEqual(rules("lib/cli.js", "console.log('x');"), []);
  assert.deepEqual(rules("client.js", "console.log('x');"), ["console-log"]);
  assert.deepEqual(rules("lib/protocol.js", "console.log('x');"), ["console-log"]);
});

test("a clean tree passes and a planted bug fails", () => {
  const clean = auditWorkspace({
    files: ["lib/a.js"],
    readFile: () => "export function a() { return 1; }\n",
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.high, 0);

  const dirty = auditWorkspace({
    files: ["lib/a.js"],
    readFile: () => "export function a() { process.exit(1); }\n",
  });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.high, 1);
  assert.match(describeAudit(dirty), /process-exit@lib\/a\.js:1/);
});

test("the payload scan catches placeholders, missing needles and a broken envelope", () => {
  const base = { identity: "Little Code Sauce", operator: "YG", language: "Simplified Chinese" };
  const clean = auditPayload({ text: `${base.identity} / ${base.operator} / ${base.language}\n<|im_start|>system\nhi\n<|im_end|>`, ...base });
  assert.equal(clean.ok, true);

  const placeholder = auditPayload({ text: "语言：{language}", ...base });
  assert.equal(placeholder.ok, false);
  assert.ok(placeholder.findings.some((row) => row.rule === "literal-placeholder"));

  const missing = auditPayload({ text: "Little Code Sauce / YG / 中文", ...base });
  assert.ok(missing.findings.some((row) => row.rule === "persona-language"));

  const envelope = auditPayload({ text: `${base.language}\n<|im_start|>system\nhi`, ...base });
  assert.ok(envelope.findings.some((row) => row.rule === "envelope-unbalanced"));
});

test("a code round whose scan finds a high bug never writes the tree", async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), "point-audit-")));
  const written = [];
  const engine = createEvolve({
    config: { tracks: ["code"], rounds: 2 },
    store,
    publisher: { publishRound: async () => ({ ok: true }) },
    runner: { available: () => true },
    proposer: {
      available: () => true,
      propose: async () => ({
        ok: true,
        proposal: {
          title: "sweep everything",
          files: [{ path: "lib/evolve/publish.js", content: 'await run(["git", "add", "-A"]);\n' }],
          diff: [],
        },
      }),
    },
    verify: async () => ({ ok: true, tests: 99, checks: [] }),
    audit: async () => ({
      ok: false,
      high: 1,
      findings: [{ rule: "git-add-all", severity: "high", file: "lib/evolve/publish.js", line: 1 }],
    }),
    applyFiles: async (files) => { written.push(...files); },
    getBaselineTests: async () => 98,
  });
  const record = await engine.runRound();
  assert.equal(record.decision, "revert");
  assert.match(record.reason, /audit: git-add-all/);
  assert.equal(written.length, 0, "nothing is written when the scan fails");
  assert.equal(record.audit.high, 1);
});

test("a prompt round is reverted when the payload scan fails", async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), "point-audit-p-")));
  const runner = {
    available: () => true,
    async runBatch({ level, targets, protocol }) {
      const n = targets.length;
      const ok = level.id === "p0" || level.id === "p1" ? n : String(protocol ?? "").includes("优先级 0") ? n : 0;
      return { n, ok, rate: n ? ok / n : 0, chars: String(protocol ?? "").length };
    },
  };
  const engine = createEvolve({
    config: { enabled: true, rounds: 1, budget: "fast" },
    store,
    runner,
    publisher: { publishRound: async () => ({ ok: true }) },
    renderProtocol: () => `${"【操作层｜基线】执行。\n".repeat(600)}`,
    getBaseline: () => "You are a helpful agent.",
    getIdentity: () => ({ identity: "Little Code Sauce", operator: "YG", language: "Simplified Chinese" }),
    auditPayload: () => ({ ok: false, high: 1, findings: [{ rule: "literal-placeholder", severity: "high", file: "payload", line: 1 }] }),
  });
  const record = await engine.runRound();
  assert.equal(record.decision, "revert");
  assert.equal(record.audit.high, 1);
  assert.equal(store.active().chain.length, 0);
});

test("the audit reads the whole tree and only narrows the report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "point-audit-tree-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "clean.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "lib", "dirty.js"), 'export const root = "/Volumes/new/point";\n');
  const narrow = auditWorkspace({ workspace: dir, files: ["lib/clean.js"] });
  assert.equal(narrow.ok, true, "the clean file has no findings of its own");
  assert.ok(narrow.scanned.includes("lib/dirty.js"), "the dirty file was still read");
  const wide = auditWorkspace({ workspace: dir, files: ["lib/dirty.js"] });
  assert.equal(wide.ok, false);
  assert.equal(wide.findings[0].rule, "hardcoded-home");
});

test("exportedNames handles default, generators and star forwards", () => {
  assert.deepEqual(exportedNames("export default function foo() {}"), ["default"]);
  assert.deepEqual(exportedNames("export function* gen(){}; export async function* agen(){}"), ["gen", "agen"]);
  assert.deepEqual(exportedNames('export * from "x"; export * as ns from "y"'), ["ns"]);
});

test("git-add-all audit catches --all and . as well as -A", () => {
  for (const arg of ["-A", "--all", "."]) {
    const found = auditSource("lib/evolve/publish.js", `await call(["add", "${arg}"]);`);
    assert.ok(found.some((f) => f.rule === "git-add-all"), arg);
  }
});
