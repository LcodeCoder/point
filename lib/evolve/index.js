// Evolve subsystem barrel: one call builds the store, runner, publisher and loop
// from a plugin config, so the plugin entry only has to pass Host services in.

import { createEvolve, budgetOf } from "./engine.js";
import { createPublisher } from "./publish.js";
import { createRunner } from "./runner.js";
import { createStore } from "./store.js";
import { applyCandidate, buildCandidates, baseTools } from "./transforms.js";

export * from "./audit.js";
export * from "./spec.js";
export * from "./research.js";
export * from "./sandbox.js";
export * from "./proposer.js";
export * from "./stats.js";
export * from "./store.js";
export * from "./targets.js";
export * from "./transforms.js";
export { createRunner, createPublisher, createEvolve, budgetOf };

/**
 * Replay a kept transform chain over a protocol text.
 * @param chain - `[{axis, id}]` entries, oldest first.
 * @param text - the generated protocol text.
 * @param tools - optional tool schemas; omitted keeps text-only replay.
 */
export function replayChain(chain, text, tools) {
  let state = { text: String(text ?? ""), tools };
  for (const entry of Array.isArray(chain) ? chain : []) {
    const candidate = buildCandidates(entry?.axis).find((row) => row.id === entry?.id);
    if (candidate) state = applyCandidate(candidate, state);
  }
  return state;
}

/**
 * Build the whole evolve runtime.
 * @param options.config - normalized evolve config.
 * @param options.dir - state directory (`$DSH_HOME/point/evolve`).
 * @param options.getLlm - Host `llm` service getter.
 * @param options.getSelection - `{provider, model}` getter.
 * @param options.getBaseline - default system prompt getter.
 * @param options.getIdentity - `{identity, operator, language}` getter.
 * @param options.renderProtocol - current protocol text getter.
 * @param options.onEvent - progress callback.
 */
export function createEvolveRuntime(options = {}) {
  const config = options.config ?? {};
  const store = createStore(options.dir);
  const runner = createRunner({
    getLlm: options.getLlm,
    getSelection: options.getSelection,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  });
  const publisher = createPublisher({
    dir: options.workspace ?? options.dir,
    repo: options.getRepo ?? config.repo,
    branch: config.branch,
    push: config.push !== false,
    dryRun: config.dryRun === true,
  });
  const engine = createEvolve({
    config,
    store,
    runner,
    publisher,
    renderProtocol: options.renderProtocol,
    getBaseline: options.getBaseline,
    getIdentity: options.getIdentity,
    waitIdle: options.waitIdle,
    onCommit: options.onCommit,
    changelog: options.changelog,
    onEvent: options.onEvent,
    workspace: options.workspace,
    proposer: options.proposer,
    research: options.research,
    verify: options.verify,
    applyFiles: options.applyFiles,
    getCodeContext: options.getCodeContext,
    getBaselineTests: options.getBaselineTests,
    readFile: options.readFile,
    audit: options.audit,
    auditPayload: options.auditPayload,
  });
  return { store, runner, publisher, engine, budget: budgetOf(config) };
}

export { baseTools };
