import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvolve } from "../lib/evolve/engine.js";
import { createProposer, extractJson, validateProposal } from "../lib/evolve/proposer.js";
import { createResearch } from "../lib/evolve/research.js";
import { verifyChange } from "../lib/evolve/sandbox.js";
import { createStore } from "../lib/evolve/store.js";
import { createPublisher } from "../lib/evolve/publish.js";

const workspace = join(import.meta.dirname, "..");

function tempStore() {
  return createStore(mkdtempSync(join(tmpdir(), "point-store-")));
}

function fakePublisher() {
  const rounds = [];
  return { rounds, publishRound: (record) => { rounds.push(record); return { ok: true }; } };
}

test("research caches a brief and renders it for the proposer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "point-research-"));
  const research = createResearch({
    dir,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ items: [
        { full_name: "acme/guard", html_url: "https://github.com/acme/guard", stargazers_count: 1200, description: "prompt firewall", topics: ["llm"] },
        { full_name: "acme/loop", html_url: "https://github.com/acme/loop", stargazers_count: 30, description: "self-improving loop", topics: [] },
      ] }),
    }),
  });
  const briefing = await research.brief("round-1", ["prompt firewall"]);
  assert.equal(briefing.ok, true);
  assert.equal(briefing.items.length, 2);
  assert.match(research.render(briefing), /acme\/guard ★1200/);
  assert.equal(research.notes().length, 1);
  assert.match(research.notes()[0].text, /prompt firewall/);
});

test("research reports a failed lookup instead of throwing", async () => {
  const research = createResearch({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  const briefing = await research.brief("round-2", ["x"]);
  assert.equal(briefing.ok, false);
  assert.equal(briefing.results[0].error, "HTTP 403");
});

test("extractJson survives fences and prose around the object", () => {
  const parsed = extractJson('Sure.\n```json\n{"title":"t","files":[]}\n```\ndone');
  assert.equal(parsed.title, "t");
  assert.equal(extractJson("no json here"), null);
});

test("validateProposal refuses tests, the manifest, and no-op files", () => {
  const root = mkdtempSync(join(tmpdir(), "point-prop-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "a.js"), "export const a = 1;\n");

  const ok = validateProposal({ title: "t", files: [{ path: "lib/a.js", content: "export const a = 2;\n" }] }, { workspace: root });
  assert.equal(ok.ok, true);
  assert.equal(ok.proposal.files[0].path, "lib/a.js");

  const same = validateProposal({ files: [{ path: "lib/a.js", content: "export const a = 1;\n" }] }, { workspace: root });
  assert.equal(same.ok, false);
  assert.match(same.error, /no change/);

  const tests = validateProposal({ files: [{ path: "test/x.test.mjs", content: "x".repeat(40) }] }, { workspace: root });
  assert.equal(tests.ok, false);

  const manifest = validateProposal({ files: [{ path: "package.json", content: "{}" }] }, { workspace: root });
  assert.equal(manifest.ok, false);

  const escape = validateProposal({ files: [{ path: "lib/../test/x.js", content: "x".repeat(40) }] }, { workspace: root });
  assert.equal(escape.ok, false);
});

test("proposer returns a validated change from a model answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "point-prop2-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "a.js"), "export const a = 1;\n");
  const llm = {
    async *stream() {
      yield { type: "text-delta", text: JSON.stringify({ title: "bump", rationale: "test", files: [{ path: "lib/a.js", content: "export const a = 2;\n" }] }) };
    },
  };
  const proposer = createProposer({ workspace: root, getLlm: () => llm, getSelection: () => ({ provider: "p", model: "m" }) });
  assert.equal(proposer.available(), true);
  const result = await proposer.propose({ track: "code", goal: "g", round: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.title, "bump");
  assert.equal(result.proposal.files[0].content, "export const a = 2;\n");
});

test("proposer reports a non-JSON answer as a failed proposal", async () => {
  const llm = { async *stream() { yield { type: "text-delta", text: "I would rather not." }; } };
  const proposer = createProposer({ workspace, getLlm: () => llm, getSelection: () => ({ provider: "p", model: "m" }) });
  const result = await proposer.propose({ track: "code" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not JSON/);
});

test("sandbox verifies in a copy and rejects a syntax error", async () => {
  // A synthetic package: running the real suite inside the sandbox would
  // re-enter this very test.
  const root = mkdtempSync(join(tmpdir(), "point-sandbox-ws-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  writeFileSync(join(root, "lib", "a.js"), "export const a = 1;\n");
  writeFileSync(join(root, "test", "a.test.mjs"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../lib/a.js';\ntest('a', () => assert.equal(a, 1));\n");

  const good = await verifyChange({ workspace: root, files: [{ path: "lib/a.js", content: "export const a = 1;\n" }] });
  assert.equal(good.ok, true);
  assert.equal(good.tests, 1);

  const bad = await verifyChange({ workspace: root, files: [{ path: "lib/a.js", content: "export const = ;" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /syntax/);
});

test("store keeps a code backup and restores it", () => {
  const store = tempStore();
  store.writeCode(3, [{ path: "client.js", before: "old", after: "new" }]);
  const restored = store.restoreCode(3);
  assert.deepEqual(restored, [{ path: "client.js", content: "old" }]);
  assert.deepEqual(store.restoreCode(4), []);
});

test("a code round keeps a verified change and writes the files", async () => {
  const store = tempStore();
  const publisher = fakePublisher();
  const written = [];
  const engine = createEvolve({
    config: { tracks: ["code"], rounds: 2 },
    store,
    publisher,
    runner: { available: () => true },
    proposer: {
      available: () => true,
      propose: async () => ({ ok: true, proposal: { title: "add helper", rationale: "r", risk: "low", files: [{ path: "lib/helper.js", content: "export const x = 1;\n" }], diff: [{ path: "lib/helper.js", before: null, after: "export const x = 1;\n" }] } }),
    },
    verify: async () => ({ ok: true, tests: 72, checks: [{ name: "node --test", ok: true, pass: 72, fail: 0 }] }),
    applyFiles: async (files) => { written.push(...files); },
    getBaselineTests: async () => 71,
  });
  const record = await engine.runRound();
  assert.equal(record.track, "code");
  assert.equal(record.decision, "keep");
  assert.equal(record.tests.pass, 72);
  assert.equal(written.length, 1);
  assert.equal(store.active().round, 1);
  assert.equal(publisher.rounds.length, 1);
});

test("a code round reverts when the sandbox fails and still advances the round", async () => {
  const store = tempStore();
  const engine = createEvolve({
    config: { tracks: ["code"], rounds: 3 },
    store,
    runner: { available: () => true },
    proposer: { available: () => true, propose: async () => ({ ok: true, proposal: { title: "x", files: [{ path: "lib/x.js", content: "export const x = 1;\n" }], diff: [] } }) },
    verify: async () => ({ ok: false, error: "tests failed (2)", checks: [{ name: "node --test", ok: false, pass: 60, fail: 2 }] }),
    applyFiles: async () => { throw new Error("must not write"); },
    getBaselineTests: async () => 71,
  });
  const record = await engine.runRound();
  assert.equal(record.decision, "revert");
  assert.equal(record.tests.fail, 2);
  assert.equal(store.active().round, 1);
});

test("a revert round still advances the round counter", async () => {
  const store = tempStore();
  let calls = 0;
  const engine = createEvolve({
    config: { tracks: ["code"], rounds: 3 },
    store,
    runner: { available: () => true },
    proposer: { available: () => true, propose: async () => { calls += 1; return { ok: false, error: "bad json" }; } },
  });
  await engine.runRound();
  await engine.runRound();
  assert.equal(calls, 2);
  assert.equal(store.active().round, 2);
});

test("a code round's commit message names the change and the tests", async () => {
  const publisher = createPublisher({ dir: mkdtempSync(join(tmpdir(), "point-pub-")), dryRun: true, push: false });
  const result = await publisher.publishRound({
    round: 2,
    track: "code",
    title: "add retry helper",
    decision: "keep",
    tests: { pass: 84, fail: 0, ok: true },
  });
  assert.match(result.message, /evolve round 2: add retry helper keep \(84 tests\)/);
});

test("without a proposer the code track falls back to the prompt track", async () => {
  const store = tempStore();
  const engine = createEvolve({
    config: { tracks: ["code"], rounds: 1 },
    store,
    runner: { available: () => false },
  });
  const record = await engine.runRound();
  assert.equal(record.decision, "blocked");
  assert.equal(record.reason, "no-model");
});

test("a proposal cannot silently drop an export", () => {
  const before = "export function keep() {}\nexport const value = 1;\n";
  const workspace = mkdtempSync(join(tmpdir(), "point-prop-"));
  writeFileSync(join(workspace, "lib.js"), before, "utf8");
  const read = () => before;

  const dropped = validateProposal({ files: [{ path: "lib/x.js", content: "export function keep() { return 2 }\n" }] }, { workspace, readFile: read });
  assert.equal(dropped.ok, false);
  assert.match(dropped.error, /drops exports from lib\/x\.js: value/);

  const kept = validateProposal({ files: [{ path: "lib/x.js", content: `${before}export const extra = 2;\n` }] }, { workspace, readFile: read });
  assert.equal(kept.ok, true);
});
