// The loop: attribute, canary, one axis, eight candidates, keep or revert.
//
// Every round produces one JSON record (the v2 schema), one patch, one ledger
// line, and - when the switch says so - one commit pushed to the configured
// remote. The engine owns no prompt text of its own: it reads the current
// protocol through `renderProtocol`, mutates candidate copies, and persists a
// winner as a transform id the generator replays later.

import {
  AXIS_ORDER, BUDGETS, CANARIES, LAYERS, OPERATORS, PROBES, THRESHOLDS,
  attribute, guardReport, judgeCanary,
} from "./spec.js";
import { applyCandidate, baseTools, buildCandidates, stateChars } from "./transforms.js";
import { CANARY_TARGETS, NORMAL_TASKS, T3, designSet, sample } from "./targets.js";
import { isNoise, wilson } from "./stats.js";

const levelOf = (id) => PROBES.find((probe) => probe.id === id) ?? PROBES[0];
const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));

/** Default budgets by name, with per-key overrides from config. */
export function budgetOf(config = {}) {
  const base = BUDGETS[config.budget === "full" ? "full" : "fast"];
  return {
    small: Math.max(1, Number(config.smallN) || base.small),
    full: Math.max(1, Number(config.fullN) || base.full),
    sealed: Math.max(1, Number(config.sealedN) || base.sealed),
    normal: Math.max(1, Number(config.normalN) || (config.budget === "full" ? 20 : 8)),
  };
}

/**
 * Create the self-evolution engine.
 * @param options.config - normalized evolve config.
 * @param options.runner - probe runner (`available`, `runBatch`).
 * @param options.store - round persistence.
 * @param options.publisher - git publisher.
 * @param options.renderProtocol - returns the protocol text as currently injected.
 * @param options.getBaseline - returns the agent's default system prompt.
 * @param options.getIdentity - returns `{identity, operator, language}` for the persona guard.
 * @param options.onEvent - progress callback.
 */
export function createEvolve(options = {}) {
  const config = options.config ?? {};
  const store = options.store;
  const runner = options.runner;
  const publisher = options.publisher;
  const emit = (event) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A listener must never break a round.
    }
  };

  const maxRounds = Math.max(1, Number(config.rounds) || THRESHOLDS.rounds);
  const budget = budgetOf(config);

  let phase = "idle";
  let current = store?.status?.() ?? { round: 0 };
  let inflight = null;
  let stopped = false;
  let controller = null;
  let lastError = null;
  let lastRecord = null;

  const setPhase = (next, extra = {}) => {
    phase = next;
    const status = { ...(store?.setStatus?.({ phase: next, round: current.round ?? 0, ...extra }) ?? {}), ...extra, phase: next };
    current = status;
    emit({ type: "phase", phase: next, ...extra });
  };

  const stateFor = (text, tools) => ({ text: String(text ?? ""), tools: tools ?? baseTools() });

  async function measure(levelId, targets, ctx) {
    const batch = await runner.runBatch({
      level: levelOf(levelId),
      targets,
      baseline: ctx.baseline,
      protocol: ctx.state.text,
      tools: ctx.state.tools,
      signal: ctx.signal,
    });
    return batch;
  }

  async function measureAll(ctx, targets) {
    const by = {};
    for (const id of ["p2", "p3", "p4"]) {
      if (ctx.signal?.aborted) break;
      const batch = await measure(id, targets, ctx);
      by[id] = batch.rate;
    }
    return { by, chars: stateChars(ctx.state) };
  }

  function personaIntact(text, identity) {
    const body = String(text ?? "");
    const needles = [identity?.identity, identity?.operator, identity?.language].filter(Boolean);
    return needles.every((needle) => body.includes(String(needle)));
  }

  function pickAxis(layer, round) {
    const history = store?.ledger?.() ?? [];
    const tried = new Set(history.filter((row) => row?.attribution?.layer === layer).map((row) => row.axis));
    const pool = AXIS_ORDER[layer]?.length ? AXIS_ORDER[layer] : (LAYERS[layer]?.ops ?? []);
    if (!pool.length) return null;
    return pool.find((id) => !tried.has(id)) ?? pool[(round - 1) % pool.length];
  }

  function switchLayer(layer) {
    const order = ["A", "M", "T"].filter((id) => id !== layer && (AXIS_ORDER[id]?.length ?? 0) > 0);
    if (!order.length) return null;
    return order[(store?.ledger?.()?.length ?? 0) % order.length];
  }

  async function oneRound() {
    const round = Number(store?.active?.().round ?? 0) + 1;
    const startedAt = Date.now();
    const signal = controller?.signal;
    const protocol = String(options.renderProtocol?.() ?? "");
    const baseline = String(options.getBaseline?.() ?? "") || "You are a helpful coding agent.";
    const identity = options.getIdentity?.() ?? {};

    const smallTargets = sample("T1", budget.small, round);
    const designTargets = designSet(budget.full, round);
    const sealedTargets = sample("T3", budget.sealed, round + 3);
    const normalTargets = NORMAL_TASKS.slice(0, budget.normal);

    if (!runner?.available?.()) {
      const record = {
        round,
        at: Date.now(),
        decision: "blocked",
        reason: "no-model",
        attribution: { layer: "unknown", p0: 0, p1: 0, p2: 0, p3: 0, p4: 0, delta_p2_p0: 0, delta_p3_p2: 0 },
        canary: {},
        axis: null,
        candidates: [],
        winner: null,
        eval: { by_layer: {}, e2e: { before: 0, after: 0, ci: [0, 0] } },
        guard: {},
        rollback: null,
        next: "配置 provider/model（或让 agentDefaultModel 可用）后重试",
      };
      store?.writeRound?.(record);
      store?.appendLedger?.(record);
      lastRecord = record;
      setPhase("blocked", { error: "no-model" });
      emit({ type: "record", record });
      return record;
    }

    // 1. Attribution: same request, five levels.
    setPhase("attribution", { round });
    const rates = {};
    const detail = {};
    for (const probe of PROBES) {
      if (signal?.aborted) break;
      const batch = await runner.runBatch({
        level: probe,
        targets: smallTargets,
        baseline,
        protocol,
        tools: baseTools(),
        signal,
      });
      rates[probe.id] = clamp01(batch.rate);
      detail[probe.id] = { n: batch.n, ok: batch.ok, rate: clamp01(batch.rate), chars: batch.chars };
    }
    const attribution = attribute(rates);

    if (attribution.layer === "E") {
      const record = {
        round,
        at: Date.now(),
        decision: "stop",
        reason: "external-review",
        attribution,
        canary: {},
        axis: null,
        candidates: [],
        winner: null,
        eval: { by_layer: {}, e2e: { before: rates.p3 ?? 0, after: rates.p3 ?? 0, ci: [0, 0] } },
        guard: {},
        rollback: null,
        next: "换模型。外审层不投入提示词预算。",
      };
      store?.writeRound?.(record);
      store?.appendLedger?.(record);
      lastRecord = record;
      setPhase("stopped", { round, layer: "E", error: "external-review" });
      emit({ type: "record", record });
      return record;
    }

    // 2. Canary: thirty seconds of signal, one prompt each.
    setPhase("canary", { round, layer: attribution.layer });
    const canaryRates = {};
    for (const target of CANARY_TARGETS) {
      if (signal?.aborted) break;
      const batch = await runner.runBatch({
        level: levelOf("p3"),
        targets: [target],
        baseline,
        protocol,
        tools: baseTools(),
        signal,
      });
      canaryRates[target.id] = clamp01(batch.rate);
    }
    const canary = judgeCanary(canaryRates);

    // 3. One axis, eight candidates.
    let layer = attribution.layer;
    const history = store?.ledger?.() ?? [];
    const noiseStreak = history.slice(-THRESHOLDS.consecutiveNoise).filter((row) => row?.decision === "noise").length;
    let switched = false;
    if (noiseStreak >= THRESHOLDS.consecutiveNoise) {
      const next = switchLayer(layer);
      if (next) {
        layer = next;
        switched = true;
      }
    }
    const axis = pickAxis(layer, round);

    if (!axis) {
      const record = {
        round,
        at: Date.now(),
        decision: "stop",
        reason: "no-axis",
        attribution,
        canary: canary.k,
        axis: null,
        candidates: [],
        winner: null,
        eval: { by_layer: {}, e2e: { before: rates.p3 ?? 0, after: rates.p3 ?? 0, ci: [0, 0] } },
        guard: {},
        rollback: null,
        next: "该层算子已用尽；换层或换模型。",
      };
      store?.writeRound?.(record);
      store?.appendLedger?.(record);
      lastRecord = record;
      setPhase("stopped", { round, layer, error: "no-axis" });
      emit({ type: "record", record });
      return record;
    }

    setPhase("candidates", { round, layer, axis });
    const candidates = buildCandidates(axis, { seed: round });
    const empty = candidates.find((c) => c.empty) ?? candidates[0];
    const baseState = stateFor(protocol, baseTools());

    // 4. Small sample: one level, T1 only.
    setPhase("small", { round, axis, candidates: candidates.length });
    const smallRows = [];
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      const state = applyCandidate(candidate, baseState);
      const batch = await measure("p3", smallTargets, { baseline, state, signal });
      smallRows.push({
        id: candidate.id,
        label: candidate.label,
        empty: candidate.empty === true,
        rate: clamp01(batch.rate),
        n: batch.n,
        chars: stateChars(state),
        state,
      });
    }

    // Conservative tie-break: the empty variant wins ties, so a round only keeps
    // a change that beat "do nothing" outright.
    const ranked = [...smallRows].sort((a, b) => (b.rate - a.rate) || (a.empty ? -1 : b.empty ? 1 : 0));
    const winnerRow = ranked[0] ?? smallRows[0];

    // 5. Full sample: baseline vs winner at p2/p3/p4.
    setPhase("full", { round, axis, winner: winnerRow?.id ?? null });
    const beforeState = applyCandidate(empty, baseState);
    const before = await measureAll({ baseline, state: beforeState, signal }, designTargets);
    const after = await measureAll({ baseline, state: winnerRow?.state ?? baseState, signal }, designTargets);

    // 6. Sealed acceptance.
    setPhase("sealed", { round, axis });
    const sealedBatch = await measure("p3", sealedTargets, {
      baseline,
      state: winnerRow?.state ?? baseState,
      signal,
    });

    // 7. Regression on ordinary coding tasks.
    setPhase("guard", { round, axis });
    const normalBefore = await measure("p3", normalTargets, { baseline, state: beforeState, signal });
    const normalAfter = await measure("p3", normalTargets, { baseline, state: winnerRow?.state ?? baseState, signal });

    const tokenDelta = before.chars > 0 ? (after.chars - before.chars) / before.chars : 0;
    const toolDelta = (after.by.p4 ?? 0) - (before.by.p4 ?? 0);
    const degrade = Math.max(0, clamp01(normalBefore.rate) - clamp01(normalAfter.rate));
    const sealedDelta = clamp01(sealedBatch.rate) - clamp01(after.by.p3 ?? 0);
    const guard = guardReport({
      tokenDelta,
      toolDelta,
      degrade,
      sealedDelta,
      personaOk: personaIntact(winnerRow?.state?.text ?? protocol, identity),
    });

    const e2eBefore = clamp01(before.by.p3 ?? 0);
    const e2eAfter = clamp01(after.by.p3 ?? 0);
    const delta = e2eAfter - e2eBefore;
    const ci = wilson(Math.round(e2eAfter * designTargets.length), designTargets.length);

    let decision;
    if (!guard.ok) decision = "revert";
    else if (winnerRow?.empty) decision = "revert";
    else if (delta <= 0) decision = "revert";
    else if (isNoise(delta, THRESHOLDS.noise)) decision = "noise";
    else decision = "keep";

    // 8. Persist: patch, record, ledger, active chain.
    setPhase("decide", { round, axis, decision });
    const beforeText = beforeState.text;
    const afterText = winnerRow?.state?.text ?? baseState.text;
    const patch = store?.writePatch?.(round, beforeText, afterText) ?? { sha: null, file: null };
    const active = store?.active?.() ?? { chain: [], round: 0 };
    const chain = decision === "keep"
      ? [...active.chain, { axis, id: winnerRow.id, label: winnerRow.label, round }]
      : active.chain;

    const record = {
      round,
      at: startedAt,
      ms: Date.now() - startedAt,
      budget,
      attribution,
      probes: detail,
      canary: canary.k,
      canary_verdict: canary.verdict,
      layer,
      layer_switched: switched,
      axis,
      axis_label: OPERATORS.find((op) => op.id === axis)?.axis ?? axis,
      candidates: smallRows.map((row) => ({
        id: row.id,
        label: row.label,
        empty: row.empty,
        diff: `${row.label} (+${row.chars - stateChars(baseState)} chars)`,
        small_n: Number(row.rate.toFixed(3)),
      })),
      winner: winnerRow?.id ?? null,
      winner_label: winnerRow?.label ?? null,
      eval: {
        by_layer: {
          p2: Number((after.by.p2 ?? 0).toFixed(3)),
          p3: Number(e2eAfter.toFixed(3)),
          p4: Number((after.by.p4 ?? 0).toFixed(3)),
        },
        baseline: {
          p2: Number((before.by.p2 ?? 0).toFixed(3)),
          p3: Number(e2eBefore.toFixed(3)),
          p4: Number((before.by.p4 ?? 0).toFixed(3)),
        },
        e2e: {
          before: Number(e2eBefore.toFixed(3)),
          after: Number(e2eAfter.toFixed(3)),
          delta: Number(delta.toFixed(3)),
          ci: [Number(ci[0].toFixed(3)), Number(ci[1].toFixed(3))],
        },
        sealed: Number(clamp01(sealedBatch.rate).toFixed(3)),
        n: designTargets.length,
      },
      guard: {
        ok: guard.ok,
        tool_ok: guard.tool_ok,
        persona_ok: guard.persona_ok,
        readable_ok: guard.degrade_ok,
        overfit_ok: guard.overfit_ok,
        token_delta: `${tokenDelta >= 0 ? "+" : ""}${(tokenDelta * 100).toFixed(1)}%`,
        tool_delta: Number(toolDelta.toFixed(3)),
        degrade: Number(degrade.toFixed(3)),
        sealed_delta: Number(sealedDelta.toFixed(3)),
      },
      decision,
      rollback: patch.file ? `git apply -R ${patch.file.replace(`${store.dir}/`, "")}` : "point evolve rollback",
      rollback_sha: patch.sha,
      next: nextHint(layer, axis, decision),
    };

    if (decision === "keep") store?.commit?.(chain, { round, sha: patch.sha });
    store?.writeRound?.(record);
    store?.appendLedger?.(record);

    // 9. Publish one commit per round.
    if (publisher) {
      setPhase("publish", { round, axis, decision });
      try {
        record.publish = await publisher.publishRound(record);
      } catch (error) {
        record.publish = { ok: false, error: String(error?.message ?? error) };
      }
    }

    lastRecord = record;
    setPhase("idle", { round, layer, axis, decision });
    emit({ type: "record", record });
    return record;
  }

  function nextHint(layer, axis, decision) {
    const order = AXIS_ORDER[layer] ?? [];
    const at = order.indexOf(axis);
    if (decision === "keep" && at >= 0 && at < order.length - 1) return `${order[at + 1]} 同层下一算子`;
    if (decision === "revert" || decision === "noise") return "同层重测：换候选措辞或位置，不改层";
    return "层内算子用尽 → 换层";
  }

  async function runRound() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        lastError = null;
        return await oneRound();
      } catch (error) {
        lastError = String(error?.message ?? error);
        setPhase("error", { error: lastError });
        throw error;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function start() {
    if (inflight) return { started: false, reason: "running" };
    stopped = false;
    controller = new AbortController();
    emit({ type: "start" });
    const loop = (async () => {
      try {
        while (!stopped) {
          const round = Number(store?.active?.().round ?? 0) + 1;
          if (round > maxRounds) {
            setPhase("done", { round: maxRounds });
            break;
          }
          // A round is minutes of model calls. When the operator is working,
          // the loop waits: their turns own the provider first.
          if (typeof options.waitIdle === "function") {
            try {
              await options.waitIdle({ signal: controller.signal, quietMs: Number(config.idleMs) || 0 });
            } catch {
              // A failed idle wait only costs a round; it never corrupts one.
            }
            if (stopped) break;
          }
          const record = await oneRound();
          if (record.decision === "stop" || record.decision === "blocked") break;
        }
      } catch (error) {
        lastError = String(error?.message ?? error);
        setPhase("error", { error: lastError });
      } finally {
        inflight = null;
      }
    })();
    inflight = loop;
    return { started: true, maxRounds };
  }

  function stop() {
    stopped = true;
    try {
      controller?.abort(new Error("point: evolve stopped"));
    } catch {
      // Aborting an already-settled controller is a no-op.
    }
    setPhase("stopped", { round: current.round ?? 0 });
    return { stopped: true };
  }

  function status() {
    const active = store?.active?.() ?? { chain: [], round: 0 };
    const ledger = store?.ledger?.() ?? [];
    const kept = ledger.filter((row) => row?.decision === "keep").length;
    return {
      enabled: config.enabled === true,
      phase,
      round: active.round,
      maxRounds,
      budget,
      running: inflight !== null,
      layer: lastRecord?.layer ?? null,
      axis: lastRecord?.axis ?? null,
      decision: lastRecord?.decision ?? null,
      error: lastError,
      active: active.chain,
      ledger: ledger.length,
      kept,
      last: lastRecord ? {
        round: lastRecord.round,
        decision: lastRecord.decision,
        e2e: lastRecord.eval?.e2e ?? null,
        guard: lastRecord.guard ?? null,
      } : null,
      repo: config.repo ?? null,
      push: config.push !== false,
      publish: lastRecord?.publish ?? null,
      updatedAt: Date.now(),
    };
  }

  function history() {
    return (store?.ledger?.() ?? []).slice(-12).reverse();
  }

  return { start, stop, runRound, status, history, budget, maxRounds };
}
