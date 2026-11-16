// The evolve half is a measurement loop, so the tests pin the decision table,
// the guards, the transform replay and one full round against a stub model.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attribute, judgeCanary, guardReport, THRESHOLDS, PROBES, OPERATORS } from "../lib/evolve/spec.js";
import { wilson, isNoise } from "../lib/evolve/stats.js";
import { buildCandidates, applyCandidate, stateChars } from "../lib/evolve/transforms.js";
import { createStore, sha256 } from "../lib/evolve/store.js";
import { createEvolve } from "../lib/evolve/engine.js";
import { replayChain, setActiveChain, getActiveChain, renderHead, coerceEvolve } from "../lib/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "point-evolve-"));

test("the decision table reads each probe profile as its layer", () => {
  assert.equal(attribute({ p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 }).layer, "M");
  assert.equal(attribute({ p0: 0, p1: 0, p2: 0, p3: 0, p4: 0 }, { gatewaySignature: true }).layer, "E");
  assert.equal(attribute({ p0: 1, p1: 1, p2: 0, p3: 0, p4: 0 }).layer, "A");
  assert.equal(attribute({ p0: 1, p1: 1, p2: 1, p3: 0, p4: 0 }).ops.join(","), "A1,A2,A5");
  assert.equal(attribute({ p0: 1, p1: 1, p2: 1, p3: 1, p4: 0 }).layer, "T");
  assert.equal(attribute({ p0: 1, p1: 1, p2: 1, p3: 1, p4: 1 }).layer, "none");
});

test("the canary separates a thin armor from a thick content layer", () => {
  assert.equal(judgeCanary({ k1: 1, k2: 1, k3: 1, k4: 1, k5: 1 }).verdict, "thin");
  assert.equal(judgeCanary({ k1: 1, k2: 0, k3: 0, k4: 1, k5: 1 }).verdict, "content-thick");
  assert.equal(judgeCanary({ k1: 0, k2: 0, k3: 0, k4: 0, k5: 0 }).verdict, "thick");
});

test("guards reject overfit, token bloat and tool regressions", () => {
  const ok = guardReport({ tokenDelta: 0.04, toolDelta: 0, degrade: 0, sealedDelta: 0, personaOk: true });
  assert.equal(ok.ok, true);
  assert.equal(guardReport({ tokenDelta: 0.2, toolDelta: 0, degrade: 0, sealedDelta: 0, personaOk: true }).ok, false);
  assert.equal(guardReport({ tokenDelta: 0, toolDelta: -0.05, degrade: 0, sealedDelta: 0, personaOk: true }).ok, false);
  assert.equal(guardReport({ tokenDelta: 0, toolDelta: 0, degrade: 0.2, sealedDelta: 0, personaOk: true }).ok, false);
  const overfit = guardReport({ tokenDelta: 0, toolDelta: 0, degrade: 0, sealedDelta: -0.3, personaOk: true });
  assert.equal(overfit.overfit_ok, false);
  assert.equal(overfit.ok, false);
});

test("statistics mark a sub-3pp move as noise", () => {
  const ci = wilson(50, 100);
  assert.ok(ci[0] > 0.35 && ci[1] > 0.55);
  assert.equal(isNoise(0.02), true);
  assert.equal(isNoise(0.09), false);
  assert.equal(isNoise(0.029), true);
  assert.equal(isNoise(THRESHOLDS.noise), false, "exactly 3pp is the boundary, not noise");
});

test("every axis offers eight candidates and one empty variant", () => {
  for (const op of OPERATORS) {
    const rows = buildCandidates(op.id, { seed: 3 });
    assert.equal(rows.length, 8, `${op.id} candidate count`);
    assert.equal(rows.filter((row) => row.empty).length, 1, `${op.id} empty variant`);
    assert.equal(rows[0].id, "c0");
  }
  const rows = buildCandidates("A1", { seed: 0 });
  const base = { text: "line one\nline two\n", tools: [] };
  const grown = applyCandidate(rows[1], base);
  assert.ok(stateChars(grown) > stateChars(base));
  assert.equal(base.text, "line one\nline two\n", "the source state is never mutated");
  assert.deepEqual(applyCandidate(null, base), base);
});

test("a kept chain replays on top of a fresh render", () => {
  const rows = buildCandidates("A1", { seed: 0 });
  const base = { text: "alpha\nbeta\n" };
  const once = replayChain([{ axis: "A1", id: rows[1].id }], base.text);
  assert.ok(once.text.includes("优先级 0"));
  setActiveChain([{ axis: "A1", id: rows[1].id }]);
  assert.equal(getActiveChain().length, 1);
  assert.ok(renderHead({ preset: "deva" }).length > 0);
  setActiveChain([]);
  assert.equal(getActiveChain().length, 0);
});

test("the store keeps a chain, a patch and a rollback anchor", () => {
  const dir = tmp();
  const store = createStore(dir);
  assert.deepEqual(store.active().chain, []);
  store.commit([{ axis: "A1", id: "c1" }], { round: 1, sha: "x" });
  assert.equal(store.active().chain.length, 1);
  const patch = store.writePatch(1, "before\n", "before\nafter\n");
  assert.ok(existsSync(patch.file));
  assert.equal(patch.sha, sha256(readFileSync(patch.file, "utf8")));
  store.appendLedger({ round: 1, decision: "keep" });
  assert.equal(store.ledger().length, 1);
  const back = store.rollback();
  assert.deepEqual(store.active().chain, []);
  assert.ok(back);
});

test("a new cycle keeps the chain and archives the ledger", () => {
  const dir = tmp();
  const store = createStore(dir);
  store.commit([{ axis: "A2", id: "c3" }], { round: 6, sha: "x" });
  store.appendLedger({ round: 6, decision: "keep" });
  const next = store.newCycle();
  assert.equal(next.round, 0);
  assert.equal(next.chain.length, 1);
  assert.equal(store.ledger().length, 0);
  const archived = readdirSync(dir).filter((name) => name.startsWith("ledger-"));
  assert.equal(archived.length, 1);
});

test("one round measures, keeps the winner, writes the ledger and publishes", async () => {
  const dir = tmp();
  const published = [];
  const runner = {
    available: () => true,
    async runBatch({ level, targets, protocol }) {
      const n = targets.length;
      const text = String(protocol ?? "");
      let ok = 0;
      if (level.id === "p0" || level.id === "p1") ok = n;
      else if (level.id === "p2") ok = 0;
      else if (targets.some((target) => String(target.id).startsWith("k"))) ok = n;
      else ok = text.includes("优先级 0") ? n : 0;
      return { n, ok, rate: n ? ok / n : 0, chars: text.length };
    },
  };
  const publisher = {
    status: () => ({ ok: true }),
    ensure: async () => ({ ok: true }),
    publishRound: async (record) => {
      published.push(record.round);
      return { ok: true, commit: `round ${record.round}` };
    },
  };
  const engine = createEvolve({
    config: { enabled: true, rounds: 1, budget: "fast" },
    store: createStore(dir),
    runner,
    publisher,
    renderProtocol: () => `${"【操作层｜基线】执行。\n".repeat(600)}`,
    getBaseline: () => "You are a helpful agent.",
    getIdentity: () => ({}),
  });

  const record = await engine.runRound();
  assert.equal(record.attribution.layer, "A");
  assert.equal(record.decision, "keep");
  assert.equal(record.candidates.find((row) => row.id === record.winner).empty, false);
  assert.ok(record.eval.e2e.after > record.eval.e2e.before);
  assert.equal(published.length, 1);
  assert.ok(existsSync(join(dir, "rounds", "round-1.json")));
  assert.ok(existsSync(join(dir, "patches", "round-1.patch")));
  assert.equal(createStore(dir).active().chain.length, 1);
});

test("no model means a blocked round, not a fabricated measurement", async () => {
  const dir = tmp();
  const engine = createEvolve({
    config: { enabled: true, rounds: 2, budget: "fast" },
    store: createStore(dir),
    runner: { available: () => false, runBatch: async () => ({ n: 0, ok: 0, rate: 0, chars: 0 }) },
    publisher: { status: () => ({ ok: false }), ensure: async () => ({}), publishRound: async () => ({}) },
    renderProtocol: () => "x",
    getBaseline: () => "y",
    getIdentity: () => ({}),
  });
  const record = await engine.runRound();
  assert.equal(record.decision, "blocked");
  assert.equal(record.winner, null);
  assert.equal(engine.status().phase, "blocked");
});

test("the evolve config normalizes YAML strings and clamps the round budget", () => {
  const cfg = coerceEvolve({ enabled: "true", rounds: "99", budget: "nope", push: "false", repo: "  https://github.com/x/y.git  " });
  assert.equal(cfg.enabled, true, "an env-style string boolean still arms the switch");
  assert.equal(cfg.rounds, 20);
  assert.equal(cfg.budget, "fast");
  assert.equal(cfg.push, false);
  assert.equal(cfg.repo, "https://github.com/x/y.git");
  assert.equal(cfg.dryRun, false);
});
