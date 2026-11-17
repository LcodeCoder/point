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
import { isNoise, pct, wilson } from "./stats.js";

const levelOf = (id) => PROBES.find((probe) => probe.id === id) ?? PROBES[0];
// A3 rewrites tool schemas; the live tool list belongs to the preset rows, so a
// kept tool edit could never be replayed into the session. Measure it, never
// select it.
const TOOL_ONLY = new Set(["A3", "T1", "T2", "T3"]);
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
 * Milliseconds still owed before the next round may start.
 * A cadence of zero means "as soon as the operator is idle".
 */
export function cadenceDelay({ lastAt = 0, intervalMs = 0, now = Date.now() } = {}) {
  if (!intervalMs || !lastAt) return 0;
  return Math.max(0, intervalMs - (now - lastAt));
}

/** Sleep that stays responsive to stop() and never holds the process open. */
function pause(ms, signal, stopped) {
  return new Promise((resolve) => {
    const end = Date.now() + Math.max(0, ms);
    const tick = () => {
      if (signal?.aborted || stopped?.() || Date.now() >= end) return resolve();
      const timer = setTimeout(tick, Math.min(5000, Math.max(0, end - Date.now())));
      if (typeof timer?.unref === "function") timer.unref();
    };
    tick();
  });
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
  const tracks = (Array.isArray(config.tracks) && config.tracks.length ? config.tracks : ["prompt"])
    .filter((id) => id === "prompt" || id === "code");
  const goal = String(config.goal ?? "Make the plugin work better: fewer refusals, a clearer panel, sturdier code.");

  let phase = "idle";
  let current = store?.status?.() ?? { round: 0 };
  let inflight = null;
  let running = false;
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

  // An operator stop is not a round: nothing is measured, nothing is published,
  // and the round number is not consumed.
  function abortedRound(round, extra = {}) {
    const record = {
      round,
      at: Date.now(),
      decision: "aborted",
      reason: "stopped",
      track: extra.track ?? "prompt",
      ...extra,
    };
    lastRecord = record;
    setPhase("idle", { round, decision: "aborted" });
    emit({ type: "record", record });
    return record;
  }

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
    // T operators rewrite the probe's tool schemas, but the live agent's tools
    // belong to the preset rows. Keeping one would claim a change it cannot
    // deliver, so T is measured in attribution and never selected.
    const pool = (AXIS_ORDER[layer]?.length ? AXIS_ORDER[layer] : (LAYERS[layer]?.ops ?? []))
      .filter((id) => !String(id).startsWith("T") && !TOOL_ONLY.has(id));
    if (!pool.length) return null;
    return pool.find((id) => !tried.has(id)) ?? pool[(round - 1) % pool.length];
  }

  function switchLayer(layer) {
    const order = ["A", "M"].filter((id) => id !== layer && (AXIS_ORDER[id]?.length ?? 0) > 0);
    if (!order.length) return null;
    return order[(store?.ledger?.()?.length ?? 0) % order.length];
  }

  /** Which kind of round this is; a code round needs a proposer to be possible. */
  let forcedTrack = null;

  function trackFor(round) {
    if (forcedTrack) return forcedTrack;
    const list = tracks.length ? tracks : ["prompt"];
    for (let offset = 0; offset < list.length; offset += 1) {
      const id = list[(round - 1 + offset) % list.length];
      if (id === "code" && !options.proposer?.available?.()) continue;
      return id;
    }
    return "prompt";
  }

  async function finishCodeRound(round, startedAt, payload) {
    const attempt = Number(payload.attempt ?? 1);
    const record = {
      round,
      at: startedAt,
      ms: Date.now() - startedAt,
      track: "code",
      attempt,
      title: payload.proposal?.title ?? null,
      rationale: payload.proposal?.rationale ?? null,
      risk: payload.proposal?.risk ?? null,
      files: (payload.proposal?.files ?? []).map((file) => ({ path: file.path, chars: String(file.content ?? "").length })),
      research: payload.briefing
        ? {
            queries: payload.briefing.results?.map((row) => row.query) ?? [],
            hits: payload.briefing.items?.length ?? 0,
            file: payload.briefing.file ?? null,
            top: (payload.briefing.items ?? []).slice(0, 3).map((item) => `${item.name} ★${item.stars}`),
          }
        : null,
      audit: payload.audit ?? null,
      tests: payload.verification
        ? {
            ok: payload.verification.ok === true,
            pass: payload.verification.tests ?? payload.verification.checks?.find((c) => c.name === "node --test")?.pass ?? 0,
            fail: payload.verification.checks?.find((c) => c.name === "node --test")?.fail ?? 0,
            checks: (payload.verification.checks ?? []).map((check) => ({
              name: check.name,
              ok: check.ok,
              ...(check.ok ? {} : { output: String(check.output ?? "").slice(-800) }),
            })),
            ms: payload.verification.ms ?? null,
          }
        : null,
      decision: payload.decision,
      reason: payload.reason ?? null,
      ...(payload.sample ? { sample: payload.sample } : {}),
      rollback: "point evolve rollback",
      next: payload.decision === "keep" ? "下一轮：继续按轨道轮换" : "换一个更小的改动重试",
    };
    try {
      options.changelog?.(record);
    } catch {
      // The ledger still holds the same facts.
    }
    if (publisher) {
      setPhase("publish", { round, track: "code", decision: record.decision });
      try {
        record.publish = await publisher.publishRound(record);
      } catch (error) {
        record.publish = { ok: false, error: String(error?.message ?? error) };
      }
    }

    store?.writeRound?.(record);
    store?.appendLedger?.(record);
    lastRecord = record;
    setPhase("idle", { round, track: "code", decision: record.decision });
    emit({ type: "record", record });
    return record;
  }

  /**
   * A code round: research, propose complete files, prove them in a sandbox,
   * and only then write them into the live tree. The prompt track measures
   * refusal rates; this track measures the test suite.
   */
  async function codeRound(round, signal, attempt = 1) {
    const startedAt = Date.now();
    const queries = Array.isArray(config.researchQueries) && config.researchQueries.length
      ? config.researchQueries
      : [
        "llm prompt injection defense",
        "self-improving agent loop",
        "ai red team harness",
        "react chat panel ui",
        "agent plugin architecture",
      ];

    let briefing = null;
    if (config.research !== false && options.research?.brief) {
      setPhase("research", { round, track: "code" });
      try {
        briefing = await options.research.brief(`round-${round}`, queries, { signal });
      } catch {
        briefing = null;
      }
    }

    if (signal?.aborted) return abortedRound(round, { track: "code" });
    setPhase("propose", { round, track: "code" });
    let proposed;
    try {
      proposed = await options.proposer.propose({
        track: "code",
        goal,
        round,
        attempt,
        previous: retryNote,
        context: String(options.getCodeContext?.() ?? ""),
        research: briefing ? options.research?.render?.(briefing) ?? "" : "",
        signal,
      });
    } catch (error) {
      proposed = { ok: false, error: String(error?.message ?? error) };
    }
    if (!proposed?.ok) {
      return finishCodeRound(round, startedAt, {
        attempt,
        decision: "revert",
        reason: proposed?.error ?? "proposal-failed",
        sample: String(proposed?.raw ?? "").slice(0, 600),
        proposal: null,
        verification: null,
        briefing,
      });
    }

    if (signal?.aborted) return abortedRound(round, { track: "code", title: proposed.proposal.title });
    setPhase("sandbox", { round, track: "code", files: proposed.proposal.files.length });
    let verification;
    try {
      const minTests = Number(await options.getBaselineTests?.()) || 0;
      verification = await options.verify({
        workspace: options.workspace,
        files: proposed.proposal.files,
        minTests,
      });
    } catch (error) {
      verification = { ok: false, error: String(error?.message ?? error), checks: [] };
    }

    if (signal?.aborted) return abortedRound(round, { track: "code", title: proposed.proposal.title });
    if (verification?.ok && typeof options.readFile === "function") {
      // The sandbox verified a copy taken minutes ago. If the operator edited a
      // file meanwhile, applying would silently overwrite their change.
      // `files` carries only the new content; the pre-round bytes live in `diff`.
      const beforeOf = new Map((proposed.proposal.diff ?? []).map((row) => [row.path, row.before]));
      const drifted = proposed.proposal.files.filter((file) => {
        if (!beforeOf.has(file.path)) return false;
        const before = beforeOf.get(file.path);
        if (before === null || before === undefined) return false; // new file: nothing to overwrite
        try {
          return String(options.readFile(file.path) ?? "") !== String(before);
        } catch {
          return true;
        }
      });
      if (drifted.length) {
        verification = {
          ...verification,
          ok: false,
          error: `changed on disk during the round: ${drifted.map((file) => file.path).join(", ")}`,
        };
      }
    }
    let audit = null;
    if (verification?.ok && typeof options.audit === "function") {
      // The sandbox proved a copy. Re-read the live tree and scan it for the
      // shapes earlier audits kept finding before anything is written.
      setPhase("audit", { round, track: "code" });
      try {
        audit = await options.audit({
          files: proposed.proposal.files.map((file) => file.path),
          contents: proposed.proposal.files.map((file) => ({ path: file.path, content: file.content })),
        });
      } catch (error) {
        audit = {
          ok: false,
          high: 1,
          findings: [{ rule: "audit-crashed", severity: "high", file: "audit", line: 1, message: String(error?.message ?? error) }],
        };
      }
      if (audit && audit.ok === false) {
        const worst = (audit.findings ?? [])
          .filter((row) => row.severity === "high")
          .slice(0, 3)
          .map((row) => `${row.rule}@${row.file}:${row.line}`)
          .join(", ");
        verification = { ...verification, ok: false, error: `audit: ${worst || "high finding"}` };
      }
    }
    if (verification?.ok) {
      try {
        store?.writeCode?.(round, proposed.proposal.diff ?? []);
        await options.applyFiles?.(proposed.proposal.files, { round });
      } catch (error) {
        // A half-applied proposal must not stay in the live tree: restore the
        // bytes this round backed up before recording the failure.
        try {
          const restored = store?.restoreCode?.(round) ?? [];
          if (restored.length) await options.applyFiles?.(restored, { round });
        } catch {
          // The record still carries the failure; the operator can roll back.
        }
        verification = { ...verification, ok: false, error: String(error?.message ?? error) };
      }
    }

    return finishCodeRound(round, startedAt, {
      attempt,
      decision: verification?.ok ? "keep" : "revert",
      reason: verification?.ok ? null : verification?.error ?? "verification-failed",
      proposal: proposed.proposal,
      verification,
      audit,
      briefing,
    });
  }

  let retryNote = "";
  let retryLimit = Math.max(0, Number(config.retryLimit) || 0);

  function logLine(text) {
    try {
      store?.appendLog?.(`${new Date().toISOString()} ${text}`);
    } catch {
      // Logging must never break a round.
    }
  }

  async function oneRound({ attempt = 1 } = {}) {
    const round = Number(store?.active?.().round ?? 0) + 1;
    const startedAt = Date.now();
    logLine(`round ${round} attempt ${attempt} start track=${trackFor(round)}`);
    const signal = controller?.signal;
    const protocol = String(options.renderProtocol?.() ?? "");
    const baseline = String(options.getBaseline?.() ?? "") || "You are a helpful coding agent.";
    const identity = options.getIdentity?.() ?? {};

    if (trackFor(round) === "code") return codeRound(round, signal, attempt);

    // A retry must not replay the same prompts: shift every sample by the attempt.
    const shift = (attempt - 1) * 11;
    const smallTargets = sample("T1", budget.small, round + shift);
    const designTargets = designSet(budget.full, round + shift);
    const sealedTargets = sample("T3", budget.sealed, round + 3 + shift);
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
      detail[probe.id] = {
        n: batch.n,
        ok: batch.ok,
        rate: clamp01(batch.rate),
        chars: batch.chars,
        ...(batch.errors?.length ? { errors: batch.errors } : {}),
      };
    }
    // A bare-API failure whose text smells like a gateway verdict (content
    // filter, moderation, policy) points at E, not at the weights.
    const gatewaySignature = (detail.p0?.errors ?? []).some((line) =>
      /content[_ -]?filter|moderation|safety|policy|blocked by|risk control/i.test(String(line)));
    const attribution = attribute(rates, { gatewaySignature, n: smallTargets.length });
    if (signal?.aborted) return abortedRound(round, { attribution, probes: detail });
    const measuredChars = Object.values(detail).reduce((sum, row) => sum + Number(row.chars || 0), 0);

    // Nothing came back at all: the provider or the model is unreachable. Spending
    // five more stages on that would burn the round budget without measuring
    // anything, so record it as blocked and let the operator fix the model.
    if (!measuredChars) {
      const errors = Object.values(detail).flatMap((row) => row.errors ?? []).slice(0, 3);
      const record = {
        round,
        at: Date.now(),
        decision: "blocked",
        reason: "no model output",
        detail: errors,
        attribution,
        canary: {},
        axis: null,
        probes: detail,
        track: "prompt",
      };
  
      store?.writeRound?.(record);
      store?.appendLedger?.(record);
      lastRecord = record;
      setPhase("blocked", { round, error: "no-model-output" });
      emit({ type: "record", record });
      return record;
    }

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

    // Every probe answered: there is no armour left to attribute, so spending
    // candidates on a layer would be measuring noise. Record it and go to
    // regression instead of inventing an axis.
    if (attribution.layer === "none") {
      const record = {
        round,
        at: Date.now(),
        decision: "keep",
        reason: "p0–p4 全过：破甲已成立，无需换算子",
        attribution,
        probes: detail,
        canary: {},
        layer: "none",
        axis: null,
        candidates: [],
        winner: null,
        eval: { by_layer: {}, baseline: {}, e2e: { before: 0, after: 0, delta: 0, ci: [0, 0], ci_kind: "delta" }, sealed: null, n: 0 },
        guard: {},
        rollback: null,
        next: "回归：跑 20 条普通任务与密封集，确认没有退化",
        track: "prompt",
      };
      store?.tick?.(round);
      store?.writeRound?.(record);
      store?.appendLedger?.(record);
      try {
        options.changelog?.(record);
      } catch {
        // The ledger still holds the same facts.
      }
      if (publisher) {
        try {
          record.publish = await publisher.publishRound(record, { signal });
        } catch (error) {
          record.publish = { ok: false, error: String(error?.message ?? error) };
        }
      }
      lastRecord = record;
      setPhase("idle", { round, layer: "none" });
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
    if (signal?.aborted) return abortedRound(round, { attribution, probes: detail, canary: canaryRates, layer: attribution.layer });

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
    let axis = pickAxis(layer, round);
    if (!axis) {
      const next = switchLayer(layer);
      if (next) {
        layer = next;
        switched = true;
        axis = pickAxis(layer, round);
      }
    }

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
        next: layer === "T"
          ? "工具提示词层只测量不落地（工具 schema 属于预设行）；换 A/M 层或换模型。"
          : "该层算子已用尽；换层或换模型。",
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
    // The interval that matters is on the difference, not on the "after" rate:
    // two rates can each look healthy while their gap is noise.
    const nDesign = Math.max(1, designTargets.length);
    const seDelta = Math.sqrt((e2eBefore * (1 - e2eBefore) + e2eAfter * (1 - e2eAfter)) / nDesign);
    const ci = [clamp01(delta - 1.96 * seDelta), clamp01(delta + 1.96 * seDelta)];

    const beforeText = beforeState.text;
    const afterText = winnerRow?.state?.text ?? baseState.text;

    // The payload is scanned before the decision, not after: a keep that ships
    // a placeholder or a broken envelope is exactly the bug this gate exists
    // for, and the guard's persona check alone did not catch it.
    let payloadAudit = null;
    if (typeof options.auditPayload === "function") {
      setPhase("audit", { round, track: "prompt", axis });
      try {
        payloadAudit = options.auditPayload(afterText);
      } catch (error) {
        payloadAudit = {
          ok: false,
          high: 1,
          findings: [{ rule: "audit-crashed", severity: "high", file: "payload", line: 1, message: String(error?.message ?? error) }],
        };
      }
    }

    let decision;
    if (!guard.ok) decision = "revert";
    else if (payloadAudit && payloadAudit.ok === false) decision = "revert";
    else if (winnerRow?.empty) decision = "revert";
    else if (delta <= 0) decision = "revert";
    else if (isNoise(delta, THRESHOLDS.noise)) decision = "noise";
    else decision = "keep";

    // Why the round ended the way it did. An empty reason is the one thing an
    // operator cannot act on, so every decision carries one.
    const failedGuard = Object.entries(guard)
      .filter(([key, value]) => key.endsWith("_ok") && value === false)
      .map(([key]) => key.replace(/_ok$/, ""));
    const firstAudit = Array.isArray(payloadAudit?.findings) ? payloadAudit.findings[0] : null;
    const reason =
      decision === "keep"
        ? `+${(delta * 100).toFixed(1)}pp e2e (${pct(e2eBefore)} → ${pct(e2eAfter)}), sealed ${pct(sealedBatch.rate)}`
        : decision === "noise"
          ? `Δ ${(delta * 100).toFixed(1)}pp is inside the ${(THRESHOLDS.noise * 100).toFixed(0)}pp noise floor`
          : failedGuard.length
            ? `guard failed: ${failedGuard.join(", ")} (token ${(tokenDelta * 100).toFixed(1)}%, tool ${(toolDelta * 100).toFixed(1)}pp, degrade ${(degrade * 100).toFixed(1)}%, sealed ${(sealedDelta * 100).toFixed(1)}pp)`
            : firstAudit
              ? `audit: ${firstAudit.rule}@${firstAudit.file}:${firstAudit.line}`
              : winnerRow?.empty
                ? "the empty variant matched the baseline; no operator earned a keep"
                : `no gain: e2e ${pct(e2eBefore)} → ${pct(e2eAfter)} (Δ ${(delta * 100).toFixed(1)}pp)`;

    // 8. Persist: patch, record, ledger, active chain.
    setPhase("decide", { round, axis, decision });
    // An aborted round must not leave a patch file behind that no record points at.
    if (signal?.aborted) return abortedRound(round, { attribution, probes: detail, axis, layer });
    const patch = store?.writePatch?.(round, beforeText, afterText) ?? { sha: null, file: null };
    const active = store?.active?.() ?? { chain: [], round: 0 };
    const chain = decision === "keep"
      ? [...active.chain, { axis, id: winnerRow.id, label: winnerRow.label, round }]
      : active.chain;

    const record = {
      round,
      at: startedAt,
      ms: Date.now() - startedAt,
      track: "prompt",
      attempt,
      budget,
      attribution,
      probes: detail,
      canary: canary.k,
      canary_verdict: canary.verdict,
      audit: payloadAudit,
      layer,
      layer_switched: switched,
      axis,
      axis_label: OPERATORS.find((op) => op.id === axis)?.axis ?? axis,
      candidates: smallRows.map((row) => ({
        id: row.id,
        label: row.label,
        empty: row.empty,
        diff: `${row.label} (+${row.chars - stateChars(baseState)} chars)`,
        small_rate: Number(row.rate.toFixed(3)),
        small_n: smallTargets.length,
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
          ci_kind: "delta",
        },
        sealed: Number(clamp01(sealedBatch.rate).toFixed(3)),
        n: designTargets.length,
      },
      reason,
      guard: {
        ok: guard.ok,
        failed: failedGuard,
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
    record.finishedAt = Date.now();

    if (signal?.aborted) return abortedRound(round, { attribution, probes: detail, axis, layer });

    if (decision === "keep") {
      const active = store?.commit?.(chain, { round, sha: patch.sha });
      // A kept prompt round lives in the state directory; mirror it into the
      // repository so the commit that records the round also carries the change.
      try {
        options.onCommit?.(active, { round, sha: patch.sha });
      } catch {
        // The chain is already durable in active.json.
      }
    }
    // 9. Changelog first: the commit that records a round should carry its entry.
    try {
      options.changelog?.(record);
    } catch {
      // The ledger still holds the same facts.
    }

    // 10. Publish one commit per round. This runs before the record is frozen:
    // a publish result that only exists in memory never reaches the ledger.
    if (publisher) {
      setPhase("publish", { round, axis, decision });
      try {
        record.publish = await publisher.publishRound(record, { signal });
      } catch (error) {
        record.publish = { ok: false, error: String(error?.message ?? error) };
      }
    }

    store?.writeRound?.(record);
    store?.appendLedger?.(record);

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

  async function runRound(overrides = {}) {
    // A loop round and a manual round must never overlap: both would read the
    // same active.round, write the same round-N.json and pay for the same probes.
    if (running || inflight) return inflight ?? { started: false, reason: "running" };
    // A stopped loop leaves its controller aborted; a manual round needs a live one.
    if (!controller || controller.signal.aborted) controller = new AbortController();
    forcedTrack = overrides.track === "code" || overrides.track === "prompt" ? overrides.track : null;
    inflight = (async () => {
      try {
        lastError = null;
        const record = await oneRound({ attempt: Math.max(1, Number(overrides.attempt) || 1) });
        if (record.decision !== "aborted") store?.tick?.(record.round);
        return record;
      } catch (error) {
        lastError = String(error?.message ?? error);
        setPhase("error", { error: lastError });
        throw error;
      } finally {
        inflight = null;
        forcedTrack = null;
      }
    })();
    return inflight;
  }

  /**
   * Which round the loop runs next. A finished cycle either ends the loop or,
   * with `continuous`, archives itself and starts a fresh one at round 1.
   */
  function advanceRound() {
    const round = Number(store?.active?.().round ?? 0) + 1;
    if (round <= maxRounds) return { round, cycled: false, done: false };
    // Off unless asked: a library caller that never mentions it gets a finite loop.
    if (config.continuous !== true) return { round: null, cycled: false, done: true };
    store?.newCycle?.();
    return { round: 1, cycled: true, done: false };
  }

  async function start() {
    // A manual round holds `inflight`; starting the loop on top of it would pay
    // for two rounds at the same round number.
    if (running || inflight) return { started: false, reason: "running" };
    stopped = false;
    running = true;
    // A restart after stop/error/done is a fresh run, not a stuck one.
    if (["stopped", "error", "done", "blocked"].includes(phase)) setPhase("idle", { round: current.round ?? 0 });
    controller = new AbortController();
    const size = typeof budget === "object" && budget ? `${budget.small}/${budget.full}/${budget.sealed}` : String(budget);
    logLine(`loop start rounds=${maxRounds} budget=${size} retry=${retryLimit}`);
    emit({ type: "start" });
    const loop = (async () => {
      let blockedRounds = 0;
      try {
        while (!stopped) {
          const step = advanceRound();
          if (step.done) {
            setPhase("done", { round: maxRounds });
            break;
          }
          const round = step.round;
          if (step.cycled) emit({ type: "cycle", round });
          // Cadence first: one round per `everyMinutes`, measured from the last
          // recorded round. A finished round is never followed by an immediate
          // second one, even when the operator is away.
          const intervalMs = Math.max(0, Number(config.everyMinutes) || 0) * 60000;
          if (intervalMs) {
            const lastRow = (store?.ledger?.() ?? []).at(-1) ?? {};
            const lastAt = Number(lastRow.finishedAt ?? lastRow.at ?? 0);
            const delay = cadenceDelay({ lastAt, intervalMs });
            if (delay > 0) await pause(delay, controller.signal, () => stopped);
            if (stopped) break;
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
          // A failed attempt is retried on the same round number with a fresh
          // sample set and a note about what went wrong. Only an exhausted retry
          // budget moves on to the next round.
          let attempt = 0;
          let record = null;
          do {
            attempt += 1;
            record = await oneRound({ attempt });
            logLine(`round ${round} attempt ${attempt} ${record.decision}${record.reason ? ` · ${record.reason}` : ""}`);
            // `noise` is a valid measurement (the change was inside the noise
            // floor); retrying it re-tests the same hypothesis and inflates the
            // chance of a false keep. Only a genuine revert is retried.
            if (record.decision !== "revert") break;
            if (attempt > retryLimit) break;
            retryNote = String(record.reason ?? record.decision);
            setPhase("retry", { round, attempt, reason: retryNote });
            logLine(`round ${round} retrying after: ${retryNote}`);
            await pause(Math.max(0, Number(config.retryDelayMs ?? 15000)), controller.signal, () => stopped);
            if (stopped) break;
          } while (!stopped);
          retryNote = "";
          if (!record) break;
          if (record.decision !== "aborted" && record.decision !== "blocked") store?.tick?.(record.round);
          if (record.decision === "stop") break;
          if (record.decision === "blocked") {
            // One empty answer is usually a transient provider failure. Three in
            // a row is a real outage, and an overnight loop should survive the
            // first kind without spending the night on the second.
            blockedRounds += 1;
            if (blockedRounds >= 3) break;
            setPhase("waiting", { round, reason: "blocked" });
            await pause(5 * 60000, controller.signal, () => stopped);
            continue;
          }
          blockedRounds = 0;
        }
      } catch (error) {
        lastError = String(error?.message ?? error);
        setPhase("error", { error: lastError });
      } finally {
        running = false;
        if (inflight === loop) inflight = null;
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
    logLine("loop stopped");
    setPhase("stopped", { round: current.round ?? 0 });
    return { stopped: true };
  }

  function status() {
    const active = store?.active?.() ?? { chain: [], round: 0 };
    const ledger = store?.ledger?.() ?? [];
    const kept = ledger.filter((row) => row?.decision === "keep").length;
    // After a restart the in-memory record is gone; the ledger is the truth.
    // The memory copy can also be older than the ledger when a previous fiber
    // wrote a round just before this one mounted, so compare timestamps.
    const ledgerLast = ledger.at(-1) ?? null;
    const last = lastRecord && ledgerLast
      ? (Number(lastRecord.at ?? 0) >= Number(ledgerLast.at ?? 0) ? lastRecord : ledgerLast)
      : (lastRecord ?? ledgerLast);
    return {
      enabled: config.enabled === true,
      phase,
      round: active.round,
      maxRounds,
      budget,
      running: running || inflight !== null,
      retryLimit,
      log: typeof store?.log === "function" ? store.log(12) : [],
      track: last?.track ?? null,
      tracks,
      layer: last?.layer ?? null,
      axis: last?.axis ?? null,
      decision: last?.decision ?? null,
      error: lastError,
      active: active.chain,
      ledger: ledger.length,
      kept,
      last: last ? {
        round: last.round,
        track: last.track ?? "prompt",
        title: last.title ?? null,
        files: last.files ?? null,
        tests: last.tests ?? null,
        research: last.research ?? null,
        decision: last.decision,
        reason: last.reason ?? null,
        e2e: last.eval?.e2e ?? null,
        guard: last.guard ?? null,
        audit: last.audit ?? null,
        attempt: last.attempt ?? 1,
      } : null,
      everyMinutes: Math.max(0, Number(config.everyMinutes) || 0),
      continuous: config.continuous === true,
      nextAt: (() => {
        const intervalMs = Math.max(0, Number(config.everyMinutes) || 0) * 60000;
        if (!intervalMs) return null;
        const lastAt = Number((store?.ledger?.() ?? []).at(-1)?.at ?? 0);
        return lastAt ? lastAt + intervalMs : null;
      })(),
      repo: config.repo ?? null,
      push: config.push !== false,
      publish: last?.publish ?? null,
      updatedAt: Date.now(),
    };
  }

  function history() {
    return (store?.ledger?.() ?? []).slice(-12).reverse();
  }

  return { start, stop, runRound, status, history, budget, maxRounds, advanceRound };
}
