// point - dsh plugin
//
// Registers the abstracted armor-break protocol as a system-prompt section.
// Two registration slots: a head section that runs before the deployment persona
// (so the persona is read through it) and a tail anchor that survives context
// pressure.
//
// Presets:
//   point  - generated abstraction (default): parameterized, table-driven
//   deva   - the verbatim Deva 0.1.15 payload, with identity/operator substituted
//   custom - operator-supplied text or file

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProtocol, buildAnchor, sectionBreakdown, selectRules, DEFAULTS as PROTOCOL_DEFAULTS } from "./protocol.js";
import { escapeInterpolation, normalizeLayout, unwrap, wrap } from "./envelope.js";
import { RULES } from "./method.js";
import { lintPayload } from "./lint.js";
import { carriesProtocol, streamWithRefusalRetry } from "./refusal.js";
import {
  baselineTests, createEvolveRuntime, createProposer, createResearch, PROBES, replayChain, T1, verifyChange,
} from "./evolve/index.js";

export { replayChain, createEvolveRuntime };

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");

// Read on demand: a hot-remounted fiber keeps this module in the ESM cache, so a
// value captured at import time would report the version from before the edit.
let versionCache = { at: 0, value: "0.0.0" };
function version() {
  try {
    const file = join(PKG_ROOT, "package.json");
    const stamp = statSync(file).mtimeMs;
    if (stamp !== versionCache.at) {
      versionCache = { at: stamp, value: JSON.parse(readFileSync(file, "utf8")).version ?? "0.0.0" };
    }
  } catch {
    // A packaged build always has package.json; a missing one is not fatal.
  }
  return versionCache.value;
}


export const name = "point";
export const inject = ["systemPrompt"];

export const DEFAULTS = {
  enabled: true,
  // Where the prompt half lives. `preset` (default) means the `point` agent
  // preset owns it: selecting 破甲模式 in the session's mode menu is what turns
  // the protocol on. `global` restores the old always-on behaviour for a
  // deployment that has no preset menu.
  scope: "preset",
  preset: "point",
  prompt: "",
  promptPath: "",
  identity: PROTOCOL_DEFAULTS.identity,
  operator: PROTOCOL_DEFAULTS.operator,
  language: PROTOCOL_DEFAULTS.language,
  openingTag: PROTOCOL_DEFAULTS.openingTag,
  mode: PROTOCOL_DEFAULTS.mode,
  rules: PROTOCOL_DEFAULTS.rules,
  includeIntentMap: PROTOCOL_DEFAULTS.includeIntentMap,
  includeCanned: PROTOCOL_DEFAULTS.includeCanned,
  includeWebRouting: PROTOCOL_DEFAULTS.includeWebRouting,
  maxChars: PROTOCOL_DEFAULTS.maxChars,
  envelope: PROTOCOL_DEFAULTS.envelope,
  position: "head",
  order: -101000,
  tailOrder: 10250,
  tailMode: "anchor",
  // Re-ask once when the model opens with a refusal instead of an answer. Only
  // requests that already carry the protocol are touched.
  retryRefusal: true,
  // Self-evolution switch. Off by default: a loop that spends model calls and
  // pushes commits is something an operator turns on, never something a package
  // install starts.
  evolve: {
    enabled: false,
    autoStart: true,
    budget: "fast",
    rounds: 6,
    repo: "",
    branch: "main",
    push: true,
    dryRun: false,
    provider: "",
    model: "",
    temperature: 0,
    maxTokens: 1200,
    timeoutMs: 120000,
    smallN: 0,
    fullN: 0,
    sealedN: 0,
    normalN: 0,
    idleOnly: true,
    idleMs: 600000,
    everyMinutes: 20,
    // What a round may improve. `prompt` measures refusal rates; `code` writes
    // files (scripts, the panel, lib code) and proves them in a sandbox first.
    tracks: ["prompt", "code"],
    research: true,
    researchQueries: [],
    goal: "把插件做得更好用：面板、协议文本、引擎、技能、脚本、文档都可以改，每轮只做一个最小改动。",
    testTimeoutMs: 180000,
    dir: "",
  },
};

export const PRESETS = ["point", "deva", "custom"];
export const POSITIONS = ["head", "tail", "both"];
export const SCOPES = ["preset", "global"];
export const EVOLVE_BUDGETS = ["fast", "full"];

/** The agent preset this package declares; the section half mounts inside it. */
export const PRESET_ID = "point";

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/** YAML gives real booleans, but an env-style config gives "true"/"false". */
const bool = (value, fallback) => {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
};

/** Normalize the nested evolve block; YAML hands numbers back as strings. */
export function coerceEvolve(raw = {}) {
  const base = DEFAULTS.evolve;
  const cfg = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
  cfg.enabled = bool(cfg.enabled, base.enabled);
  cfg.autoStart = bool(cfg.autoStart, base.autoStart);
  cfg.budget = EVOLVE_BUDGETS.includes(cfg.budget) ? cfg.budget : base.budget;
  cfg.rounds = Math.max(1, Math.min(20, num(cfg.rounds, base.rounds)));
  cfg.repo = String(cfg.repo ?? "").trim();
  cfg.branch = String(cfg.branch ?? base.branch).trim() || "main";
  cfg.push = bool(cfg.push, true);
  cfg.dryRun = bool(cfg.dryRun, false);
  cfg.provider = String(cfg.provider ?? "").trim();
  cfg.model = String(cfg.model ?? "").trim();
  cfg.temperature = num(cfg.temperature, base.temperature);
  cfg.maxTokens = Math.max(64, num(cfg.maxTokens, base.maxTokens));
  cfg.timeoutMs = Math.max(1000, num(cfg.timeoutMs, base.timeoutMs));
  cfg.smallN = Math.max(0, num(cfg.smallN, 0));
  cfg.fullN = Math.max(0, num(cfg.fullN, 0));
  cfg.sealedN = Math.max(0, num(cfg.sealedN, 0));
  cfg.normalN = Math.max(0, num(cfg.normalN, 0));
  cfg.idleOnly = bool(cfg.idleOnly, true);
  cfg.idleMs = Math.min(3600000, Math.max(0, num(cfg.idleMs, base.idleMs)));
  cfg.everyMinutes = Math.min(1440, Math.max(0, num(cfg.everyMinutes, base.everyMinutes)));
  const tracks = (Array.isArray(cfg.tracks) ? cfg.tracks : String(cfg.tracks ?? "").split(","))
    .map((id) => String(id).trim())
    .filter((id) => id === "prompt" || id === "code");
  cfg.tracks = tracks.length ? [...new Set(tracks)] : [...base.tracks];
  cfg.research = bool(cfg.research, base.research);
  cfg.researchQueries = (Array.isArray(cfg.researchQueries) ? cfg.researchQueries : String(cfg.researchQueries ?? "").split("\n"))
    .map((query) => String(query).trim())
    .filter(Boolean)
    .slice(0, 6);
  cfg.goal = String(cfg.goal ?? "").trim();
  cfg.testTimeoutMs = Math.max(10000, num(cfg.testTimeoutMs, base.testTimeoutMs));
  cfg.dir = String(cfg.dir ?? "").trim();
  return cfg;
}

export function coerce(raw = {}) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  cfg.enabled = bool(cfg.enabled, DEFAULTS.enabled);
  cfg.scope = SCOPES.includes(cfg.scope) ? cfg.scope : DEFAULTS.scope;
  cfg.retryRefusal = bool(cfg.retryRefusal, DEFAULTS.retryRefusal);
  cfg.preset = PRESETS.includes(cfg.preset) ? cfg.preset : "point";
  cfg.position = POSITIONS.includes(cfg.position) ? cfg.position : "head";
  cfg.tailMode = cfg.tailMode === "full" ? "full" : "anchor";
  cfg.envelope = bool(cfg.envelope, DEFAULTS.envelope);
  cfg.includeIntentMap = bool(cfg.includeIntentMap, DEFAULTS.includeIntentMap);
  cfg.includeCanned = bool(cfg.includeCanned, DEFAULTS.includeCanned);
  cfg.includeWebRouting = bool(cfg.includeWebRouting, DEFAULTS.includeWebRouting);
  const order = (value, fallback) => (value === "" || value === null || value === undefined
    ? fallback
    : (Number.isFinite(Number(value)) ? Number(value) : fallback));
  cfg.order = order(cfg.order, DEFAULTS.order);
  cfg.tailOrder = order(cfg.tailOrder, DEFAULTS.tailOrder);
  cfg.maxChars = Number.isFinite(Number(cfg.maxChars)) ? Math.max(0, Number(cfg.maxChars)) : 0;
  cfg.evolve = coerceEvolve(cfg.evolve);
  return cfg;
}

// The verbatim payload keeps its own wording; only the two identity slots move.
function loadDeva(cfg) {
  const path = join(PKG_ROOT, "prompts", "deva.txt");
  let text = readFileSync(path, "utf8");
  if (cfg.identity !== PROTOCOL_DEFAULTS.identity) {
    text = text.split(PROTOCOL_DEFAULTS.identity).join(cfg.identity);
  }
  if (cfg.operator !== PROTOCOL_DEFAULTS.operator) {
    text = text.split(PROTOCOL_DEFAULTS.operator).join(cfg.operator);
  }
  return text;
}

function loadCustom(cfg) {
  if (typeof cfg.prompt === "string" && cfg.prompt.trim()) return cfg.prompt;
  if (typeof cfg.promptPath === "string" && cfg.promptPath.trim()) {
    const p = isAbsolute(cfg.promptPath) ? cfg.promptPath : resolve(process.cwd(), cfg.promptPath);
    return readFileSync(p, "utf8");
  }
  return buildProtocol(cfg);
}

// The kept transform chain, replayed on every render. `apply` fills it from
// `active.json`; the evolve engine replaces it after a keep, so the next
// assembly already carries the winner without a restart.
let activeChain = [];

/** Replace the active chain (empty array disables replay). */
export function setActiveChain(chain) {
  activeChain = Array.isArray(chain) ? chain.filter((row) => row && row.axis && row.id) : [];
  return activeChain;
}

/** Read the active chain. */
export function getActiveChain() {
  return activeChain.slice();
}

export function renderHeadRaw(config = {}) {
  const cfg = coerce(config);
  let text;
  if (cfg.preset === "deva") text = loadDeva(cfg);
  else if (cfg.preset === "custom") text = loadCustom(cfg);
  else text = buildProtocol(cfg);

  text = escapeInterpolation(text);
  // Cut the body, then wrap: cutting a wrapped payload would leave the ChatML
  // envelope unterminated, which the host injects verbatim.
  const budget = cfg.maxChars > 0 ? Math.max(0, cfg.maxChars - (cfg.envelope ? 64 : 0)) : 0;
  if (budget && text.length > budget) {
    const cut = text.lastIndexOf("\n", budget);
    text = text.slice(0, cut > 0 ? cut : budget).trimEnd();
  }
  if (cfg.envelope) text = wrap(text);
  else text = cfg.preset === "custom" ? unwrap(text) : normalizeLayout(text);
  return text;
}

export function renderHead(config = {}) {
  const cfg = coerce(config);
  const text = renderHeadRaw(config);
  if (!activeChain.length) return text;
  let replayed;
  try {
    replayed = replayChain(activeChain, text).text;
  } catch {
    return text;
  }
  // A kept transform can push the head past the configured cap again.
  if (cfg.maxChars > 0 && replayed.length > cfg.maxChars) {
    const cut = replayed.lastIndexOf("\n", cfg.maxChars);
    replayed = replayed.slice(0, cut > 0 ? cut : cfg.maxChars).trimEnd();
  }
  return replayed;
}

export function renderTail(config = {}) {
  const cfg = coerce(config);
  if (cfg.tailMode === "full") return renderHead(cfg);
  const text = escapeInterpolation(buildAnchor(cfg));
  return cfg.envelope ? wrap(text) : text;
}

// dsh accepts either ctx.systemPrompt.section(...) or a bare section call on ctx
// depending on the runtime generation; both paths are tried, and the disposer is
// owned by ctx.effect when available.
export function addSection(ctx, section) {
  const service = ctx?.systemPrompt ?? ctx;
  if (!service || typeof service.section !== "function") {
    throw new Error("point: systemPrompt.section is unavailable in this dsh runtime");
  }
  let dispose;
  try {
    dispose = service.section(section);
  } catch (error) {
    // A remount inside the same scope hits the service's duplicate guard. The
    // section is already in place, which is the desired end state.
    if (String(error?.message ?? error).includes("already registered")) return undefined;
    throw error;
  }
  if (typeof dispose === "function" && typeof ctx.effect === "function") {
    ctx.effect(() => dispose);
  }
  return dispose;
}

// ------------------------------------------------------------------ evidence
//
// "Broken armor" is not a claim, it is an observation: every system-prompt
// assembly that carries a point section is recorded with that section's weight
// and its position relative to the rest of the prompt. The scope is an opaque
// object, so a WeakMap hands out stable short labels instead of inventing
// session ids this layer cannot see.

const EVIDENCE_LIMIT = 50;

export function createEvidence() {
  const labels = new WeakMap();
  let scopes = 0;
  let count = 0;
  let last = 0;
  const rows = [];

  const labelOf = (scope) => {
    if (scope === null || typeof scope !== "object") return 0;
    let id = labels.get(scope);
    if (id === undefined) {
      id = ++scopes;
      labels.set(scope, id);
    }
    return id;
  };

  const record = (assembly, context) => {
    const sections = Array.isArray(assembly?.sections) ? assembly.sections : [];
    const headAt = sections.findIndex((s) => s?.name === "point");
    const tailAt = sections.findIndex((s) => s?.name === "point:tail");
    if (headAt === -1 && tailAt === -1) return;
    count += 1;
    last = Date.now();
    rows.unshift({
      at: last,
      scope: labelOf(context?.scope),
      head: headAt === -1 ? 0 : String(sections[headAt].text ?? "").length,
      tail: tailAt === -1 ? 0 : String(sections[tailAt].text ?? "").length,
      sections: sections.length,
      index: headAt,
      next: headAt === -1 ? null : (sections[headAt + 1]?.name ?? null),
    });
    if (rows.length > EVIDENCE_LIMIT) rows.length = EVIDENCE_LIMIT;
  };

  return { record, snapshot: () => ({ count, scopes, last, rows: rows.slice() }) };
}

const countLines = (text) => (text ? text.split("\n").length : 0);

// ------------------------------------------------------------- preset probe
//
// The mode menu is the roster the `agentPresets` service holds. The panel has to
// answer "is 破甲模式 actually installable right now?" without an async read on
// every poll, so the roster is cached and refreshed in the background. A Host
// without the service reports `available: false` and the panel falls back to the
// scope wording.

const PRESET_TTL = 5000;

export function createPresetProbe(id = PRESET_ID) {
  let service = null;
  let inflight = null;
  let cache = { at: 0, ids: null, name: null, description: null, error: null };

  const refresh = () => {
    if (!service) return undefined;
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => service.list())
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        const row = list.find((entry) => entry?.id === id) ?? null;
        cache = {
          at: Date.now(),
          ids: list.map((entry) => entry?.id).filter(Boolean),
          name: row?.name ?? null,
          description: row?.description ?? null,
          error: null,
        };
      })
      .catch((error) => {
        cache = { ...cache, at: Date.now(), error: String(error?.message ?? error) };
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    bind(next) {
      service = next;
      refresh();
    },
    unbind() {
      service = null;
    },
    refresh,
    snapshot() {
      if (service && Date.now() - cache.at > PRESET_TTL) refresh();
      return {
        available: service !== null,
        id,
        registered: Array.isArray(cache.ids) ? cache.ids.includes(id) : null,
        name: cache.name,
        description: cache.description,
        count: cache.ids?.length ?? 0,
        error: cache.error,
      };
    },
  };
}


// The panel's whole data model: what is injected, what it weighs, which rules
// survived the filter, whether the payload lints clean, and what the assemblies
// actually carried.
export function buildState(config = {}, evidence, client, telemetry, preset, evolve) {
  const cfg = coerce(config);
  const headOn = cfg.position === "head" || cfg.position === "both";
  const tailOn = cfg.position === "tail" || cfg.position === "both";
  const head = headOn ? renderHead(cfg) : "";
  const tail = tailOn ? renderTail(cfg) : "";

  const picked = new Set(selectRules(cfg).map((r) => r.id));
  const findings = head ? lintPayload(head) : [];

  const modes = cfg.preset === "point"
    ? ["minimal", "core", "routing", "full"].map((mode) => {
      const text = buildProtocol({ ...cfg, mode, maxChars: 0 });
      return { mode, chars: text.length, lines: countLines(text) };
    })
    : [];

  return {
    ok: true,
    generatedAt: Date.now(),
    plugin: { name, version: version(), pid: process.pid },
    status: {
      enabled: cfg.enabled,
      scope: cfg.scope,
      head: headOn,
      tail: tailOn,
      // Whether THIS row put the sections into the host composition. Under
      // `preset` scope the preset's own child row does it, per session.
      injected: cfg.enabled && cfg.scope === "global",
      preset: typeof preset === "function" ? preset() : (preset ?? null),
    },
    config: {
      scope: cfg.scope,
      retryRefusal: cfg.retryRefusal,
      preset: cfg.preset,
      mode: cfg.mode,
      position: cfg.position,
      tailMode: cfg.tailMode,
      envelope: cfg.envelope,
      order: cfg.order,
      tailOrder: cfg.tailOrder,
      maxChars: cfg.maxChars,
      identity: cfg.identity,
      operator: cfg.operator,
      language: cfg.language,
      openingTag: cfg.openingTag,
      rules: Array.isArray(cfg.rules) ? cfg.rules.join(",") : String(cfg.rules ?? "all"),
      includeIntentMap: cfg.includeIntentMap !== false,
      includeCanned: cfg.includeCanned !== false,
      includeWebRouting: cfg.includeWebRouting !== false,
    },
    head: { chars: head.length, lines: countLines(head), text: head },
    tail: { chars: tail.length, lines: countLines(tail), text: tail },
    sections: cfg.preset === "point" ? sectionBreakdown(cfg) : [],
    modes,
    rules: {
      active: picked.size,
      total: RULES.length,
      rows: RULES.map((r) => ({ id: r.id, key: r.key, short: r.short, title: r.title, active: picked.has(r.id) })),
    },
    lint: { ok: findings.length === 0, hits: findings.slice(0, 40) },
    evidence: evidence ? evidence.snapshot() : { count: 0, scopes: 0, last: 0, rows: [] },
    client: resolveClient(client),
    evolve: typeof evolve === "function" ? evolve() : (evolve ?? null),
    telemetry: telemetry
      ? {
        hits: telemetry.hits,
        lastHitAt: telemetry.lastHitAt,
        retry: telemetry.retry ?? { attempts: 0, recovered: 0, refused: 0, lastFrame: null, lastAt: 0 },
      }
      : { hits: 0, lastHitAt: 0, retry: { attempts: 0, recovered: 0, refused: 0, lastFrame: null, lastAt: 0 } },
  };
}

/** Read the composed client row for this package, tolerating a Host without the service. */
function resolveClient(client) {
  if (typeof client === "function") {
    try {
      return client() ?? { available: false };
    } catch (error) {
      return { available: false, error: String(error?.message ?? error) };
    }
  }
  return client ?? { available: false };
}

/**
 * Snapshot the Host client-module graph row that loads this package's browser half.
 * @param registry - the Host `clientModules` service, or null before it activates.
 */
export function clientSnapshot(registry) {
  if (!registry) return { available: false };
  try {
    const graph = registry.graph?.() ?? {};
    const rows = Array.isArray(graph.entries) ? graph.entries : [];
    const row = rows.find((entry) => entry?.id === name) ?? null;
    return {
      available: true,
      mounted: row !== null,
      rows: rows.length,
      graphRev: graph.rev ?? null,
      release: graph.release ?? null,
      rev: row?.rev ?? null,
      url: row?.url ?? null,
      immediately: row?.immediately === true,
      external: row?.external ?? [],
      path: registry.clientPath?.(name) ?? null,
    };
  } catch (error) {
    return { available: false, error: String(error?.message ?? error) };
  }
}

// The default prompt a probe calls "baseline": every assembled section except
// this package's own. Captured from the last assembly, so P2 measures the agent
// the operator actually runs, not a guess about it.
export function createBaseline() {
  let text = "";
  let at = 0;
  return {
    record(assembly) {
      const sections = Array.isArray(assembly?.sections) ? assembly.sections : [];
      const kept = sections.filter((s) => s?.name !== "point" && s?.name !== "point:tail");
      const joined = kept.map((s) => String(s?.text ?? "")).join("\n\n").trim();
      if (!joined) return;
      text = joined.slice(0, 400000);
      at = Date.now();
    },
    get: () => text,
    snapshot: () => ({ at, chars: text.length }),
  };
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    const fail = (error) => {
      if (done) return;
      done = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error(`body larger than ${limit} bytes`), { status: 413 }));
        chunks.length = 0;
        // Drain the rest so the 413 can be written on a live socket; destroying
        // the request here made the client see a reset instead of the status.
        try {
          req.resume();
        } catch {
          // Already closed.
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => fail(Object.assign(error, { status: 400 })));
  });
}

function sendJson(res, body, headOnly = false, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    "x-point-plugin": `point/${version()}`,
  });
  res.end(headOnly ? undefined : payload);
}

// The client half reads this route; a composition without a Web carrier (a
// terminal-only profile) simply leaves the panel half dormant.
function mountStateRoute(ctx, state) {
  if (typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["webServer"], (scope) => {
      const server = scope.webServer;
      if (!server || typeof server.register !== "function") return;
      try {
        scope.effect(() => server.register({
        kind: "exact",
        path: "/point/state",
        handler: (req, res) => {
          const method = String(req.method || "GET").toUpperCase();
          if (method !== "GET" && method !== "HEAD") {
            res.writeHead(405, { allow: "GET, HEAD" });
            res.end();
            return;
          }
          try {
            sendJson(res, state(), method === "HEAD");
          } catch (error) {
            sendJson(res, { ok: false, error: String(error?.message ?? error) }, false, 500);
          }
        },
        }), "point: /point/state");
      } catch {
        // A duplicate route surfaces as a plugin error; the prompt half is unaffected.
      }
    });
  } catch {
    // Route registration is optional; the prompt half never depends on it.
  }
}

/**
 * The evolve control surface: read status, start/stop the loop, run one round,
 * roll the chain back. Kept separate from `/point/state` because these are
 * actions, not observations.
 */
function mountEvolveRoute(ctx, control) {
  if (typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["webServer"], (scope) => {
      const server = scope.webServer;
      if (!server || typeof server.register !== "function") return;
      try {
        scope.effect(() => server.register({
        kind: "exact",
        path: "/point/evolve",
        handler: async (req, res) => {
          const method = String(req.method || "GET").toUpperCase();
          if (method === "GET" || method === "HEAD") {
            try {
              sendJson(res, control.snapshot(), method === "HEAD");
            } catch (error) {
              sendJson(res, { ok: false, error: String(error?.message ?? error) }, false, 500);
            }
            return;
          }
          if (method !== "POST") {
            res.writeHead(405, { allow: "GET, HEAD, POST" });
            res.end();
            return;
          }
          let raw = "";
          try {
            raw = await readBody(req);
          } catch (error) {
            sendJson(res, { ok: false, error: String(error?.message ?? error) }, false, Number(error?.status) || 400);
            return;
          }
          let body = null;
          try {
            body = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            sendJson(res, { ok: false, error: "invalid JSON body" }, false, 400);
            return;
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            sendJson(res, { ok: false, error: "body must be a JSON object" }, false, 400);
            return;
          }
          const action = String(body.action || "");
          if (!action) {
            sendJson(res, { ok: false, error: "missing action" }, false, 400);
            return;
          }
          try {
            const result = await control.action(action, body);
            sendJson(res, { ok: true, action, result });
          } catch (error) {
            sendJson(res, { ok: false, action, error: String(error?.message ?? error) }, false, 400);
          }
        },
        }), "point: /point/evolve");
      } catch {
        // Same contract as the state route: optional.
      }
    });
  } catch {
    // Same contract as the state route: optional.
  }
}

export function apply(ctx, rawConfig = {}) {
  const cfg = coerce(rawConfig);
  // The panel shows "配置默认" separately from the session switch; capture the
  // configured value before an armed override flips `enabled` below.
  const configuredEnabled = cfg.evolve.enabled;

  // Two scopes, one switch:
  //   preset - the `point` agent preset owns the prompt half (its child row is
  //            `point/section`); this row only answers the panel and the route.
  //   global - this row registers the sections itself, for a deployment with no
  //            preset menu.
  // Read dynamically: the panel switch can flip `enabled` after the runtime is
  // created (a persisted armed state), and the sections must follow it.
  const injectHere = () => cfg.enabled && cfg.scope === "global";

  // A disabled plugin still answers /point/state and still shows its panel: the
  // panel is the status window, so "已停用" has to be readable there instead of
  // looking like a missing Host half. Only the prompt sections and the assembly
  // observation are skipped.
  // Sections are registered after the persisted chain is loaded (see below):
  // the host stores their text as data, so a section registered before the
  // chain is replayed would keep the unevolved protocol for the whole session.
  let sectionDisposers = [];
  function registerSections() {
    for (const dispose of sectionDisposers) {
      try {
        dispose?.();
      } catch {
        // Already disposed with the previous fiber.
      }
    }
    sectionDisposers = [];
    if (!injectHere()) return;
    const add = (section) => {
      const dispose = addSection(ctx, section);
      if (typeof dispose === "function") sectionDisposers.push(dispose);
    };
    if (cfg.position === "head" || cfg.position === "both") {
      add({ name: "point", order: cfg.order, text: renderHead(cfg), interpolate: false });
    }
    if (cfg.position === "tail" || cfg.position === "both") {
      add({ name: "point:tail", order: cfg.tailOrder, text: renderTail(cfg), interpolate: false });
    }
  }

  const evidence = createEvidence();
  const baseline = createBaseline();

  /** Mirror a kept prompt chain into the repository, next to the package. */
  function writeChainFile(active) {
    try {
      const payload = {
        version: 1,
        round: Number(active?.round ?? 0),
        at: Number(active?.updatedAt ?? Date.now()),
        chain: Array.isArray(active?.chain) ? active.chain : [],
      };
      writeFileSync(join(PKG_ROOT, "chain.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // The state directory still holds the authoritative copy.
    }
  }

  function readChainFile() {
    try {
      const parsed = JSON.parse(readFileSync(join(PKG_ROOT, "chain.json"), "utf8"));
      return Array.isArray(parsed?.chain) ? parsed.chain : [];
    } catch {
      return [];
    }
  }
  if (cfg.enabled && typeof ctx.on === "function") {
    ctx.on("system-prompt/assemble", (assembly, context, next) => {
      try {
        evidence.record(assembly, context);
        baseline.record(assembly);
      } catch {
        // An observation must never break an assembly.
      }
      return next();
    });
  }

  const telemetry = {
    hits: 0,
    lastHitAt: 0,
    retry: { attempts: 0, recovered: 0, refused: 0, lastFrame: null, lastAt: 0 },
  };

  // Session activity: the evolve loop waits for a quiet window before a round,
  // so the operator's own turns reach the provider first. Probe traffic is
  // excluded by purpose, otherwise the loop would gate on itself.
  const activity = { lastUserAt: 0 };
  if (typeof ctx.on === "function") {
    ctx.on("llm/stream", (options, next) => {
      if (String(options?.purpose ?? "") !== "point-probe") activity.lastUserAt = Date.now();
      return next();
    });
  }

  // Refusal retry: buffered at the stream head, re-asked with a stronger tail.
  // Gated on the protocol marker, so a session running any other preset is
  // never re-prompted behind the operator's back.
  if (cfg.enabled && cfg.retryRefusal && typeof ctx.on === "function") {
    ctx.on("llm/stream", (options, next) => {
      // A probe is a measurement, not a conversation: never nudge it.
      if (String(options?.purpose ?? "") === "point-probe") return next();
      let carries = false;
      try {
        carries = carriesProtocol(options);
      } catch {
        carries = false;
      }
      if (!carries) return next();
      return streamWithRefusalRetry((opts) => next(opts), options, {
        onRetry: ({ attempt, frame, chars }) => {
          telemetry.retry.attempts += 1;
          telemetry.retry.lastFrame = frame;
          telemetry.retry.lastAt = Date.now();
          telemetry.retry.lastChars = chars;
          telemetry.retry.lastAttempt = attempt;
        },
        onOutcome: ({ refused, attempt }) => {
          if (refused) telemetry.retry.refused += 1;
          else if (attempt > 0) telemetry.retry.recovered += 1;
        },
      });
    });
  }

  let registry = null;
  const preset = createPresetProbe();
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["clientModules"], (scope) => {
        registry = scope.clientModules;
        scope.effect(() => () => {
          registry = null;
        }, "point: client graph probe");
      });
    } catch {
      // A Host without the client-module service simply reports the panel as unavailable.
    }

    try {
      ctx.inject(["agentPresets"], (scope) => {
        preset.bind(scope.agentPresets);
        scope.effect(() => () => preset.unbind(), "point: preset roster probe");
      });
    } catch {
      // No preset service (terminal-only profile): the panel reports the gap.
    }
  }

  // ---- self-evolution ------------------------------------------------------
  // The switch has two layers on purpose. `evolve.enabled` is the install-time
  // switch (a config edit); `armed` is the runtime switch the panel flips, kept
  // in the state directory so a restart does not silently resume a loop the
  // operator stopped.
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const evolveDir = cfg.evolve.dir || join(home, "point", "evolve");

  let llm = null;
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["llm"], (scope) => {
        llm = scope.llm;
        scope.effect(() => () => {
          llm = null;
        }, "point: llm probe");
      });
    } catch {
      // A profile without an LLM service simply reports the loop as blocked.
    }
  }

  const readSelection = () => {
    if (cfg.evolve.provider && cfg.evolve.model) {
      return { provider: cfg.evolve.provider, model: cfg.evolve.model };
    }
    try {
      const service = typeof ctx.get === "function" ? ctx.get("agentDefaultModel") : null;
      const pick = service && typeof service.currentSelection === "function" ? service.currentSelection() : null;
      if (pick && pick.provider && pick.model) return { provider: pick.provider, model: pick.model };
    } catch {
      // Fall through: no selection means the runner reports itself unavailable.
    }
    return null;
  };

  /** A compact map of the package, handed to the proposer with every code round. */
  const describePackage = () => {
    const rows = [];
    const walk = (relative, depth) => {
      if (depth > 2 || rows.length > 80) return;
      let entries = [];
      try {
        entries = readdirSync(join(PKG_ROOT, relative), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const rel = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel, depth + 1);
          continue;
        }
        if (!/\.(js|mjs|md|yml|json)$/.test(entry.name)) continue;
        try {
          const text = readFileSync(join(PKG_ROOT, rel), "utf8");
          rows.push(`${rel} (${text.split("\n").length} lines)`);
        } catch {
          // A file that vanished mid-walk is not worth failing a round over.
        }
      }
    };
    walk("lib", 0);
    for (const name of ["client.js", "package.json", "cordis.patch.yml", "README.md"]) {
      try {
        const text = readFileSync(join(PKG_ROOT, name), "utf8");
        rows.push(`${name} (${text.split("\n").length} lines)`);
      } catch {
        // Optional file.
      }
    }
    let version = "?";
    try {
      version = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version ?? "?";
    } catch {
      // Keep the placeholder.
    }
    const recent = (runtime?.store?.ledger?.() ?? [])
      .slice(-3)
      .map((row) => `round ${row.round} ${row.track ?? "prompt"} ${row.decision}${row.axis ? ` ${row.axis}` : ""}${row.title ? ` ${row.title}` : ""}`);
    return [
      `point ${version} - a DeepSeek Harness plugin. Node 22 ESM in lib/, one classic script (client.js) for the panel, no build step.`,
      `Protocol head: ${renderHead(cfg).length} chars.`,
      `Files:\n${rows.join("\n")}`,
      recent.length ? `Recent rounds:\n${recent.join("\n")}` : "",
      "Tests: node --test test/*.test.mjs",
    ].filter(Boolean).join("\n\n");
  };

  let baselineTestCount = 0;
  const getBaselineTests = async () => {
    if (baselineTestCount) return baselineTestCount;
    try {
      baselineTestCount = Number((await baselineTests(PKG_ROOT)).pass) || 0;
    } catch {
      baselineTestCount = 0;
    }
    return baselineTestCount;
  };

  const applyFiles = async (files) => {
    const root = resolve(PKG_ROOT) + sep;
    for (const file of files ?? []) {
      const full = resolve(PKG_ROOT, String(file.path));
      if (!full.startsWith(root)) throw new Error(`refusing to write outside the package: ${file.path}`);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, String(file.content ?? ""), "utf8");
    }
  };

  /** The panel's repository override wins over the config for this session. */
  const repoOverride = () => {
    try {
      const value = runtime?.store?.status?.()?.repo;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  };

  let runtime = null;
  let runtimeError = null;
  try {
    runtime = createEvolveRuntime({
      config: cfg.evolve,
      dir: evolveDir,
      workspace: PKG_ROOT,
      proposer: createProposer({
        workspace: PKG_ROOT,
        getLlm: () => llm,
        getSelection: readSelection,
        config: cfg.evolve,
      }),
      research: createResearch({ dir: join(evolveDir, "research") }),
      verify: (options) => verifyChange({ ...options, workspace: PKG_ROOT, timeoutMs: cfg.evolve.testTimeoutMs }),
      applyFiles,
      getCodeContext: describePackage,
      getBaselineTests,
      readFile: (path) => readFileSync(join(PKG_ROOT, String(path)), "utf8"),
      getRepo: () => repoOverride() ?? cfg.evolve.repo,
      waitIdle: async ({ signal, quietMs } = {}) => {
        const quiet = Math.max(0, Number(quietMs) || 0);
        if (!quiet) return;
        while (!signal?.aborted) {
          const idleFor = activity.lastUserAt ? Date.now() - activity.lastUserAt : Infinity;
          if (idleFor >= quiet) return;
          await new Promise((done) => {
            const timer = setTimeout(done, 2000);
            if (typeof timer?.unref === "function") timer.unref();
          });
        }
      },
      onCommit: (active) => writeChainFile(active),
      getLlm: () => llm,
      getSelection: readSelection,
      getBaseline: () => baseline.get(),
      getIdentity: () => ({ identity: cfg.identity, operator: cfg.operator, language: cfg.language }),
      renderProtocol: () => renderHead(cfg),
      onEvent: (event) => {
        if (event?.type !== "record") return;
        // A kept round must reach the next assembly without a restart.
        try {
          setActiveChain(runtime?.store?.active?.()?.chain ?? []);
        } catch {
          // A failed replay keeps the previous chain; the round is still recorded.
        }
        telemetry.evolveLastAt = Date.now();
        // The host keeps section text as data: re-register so a kept round
        // reaches the next assembly without a restart.
        registerSections();
      },
    });
    // The state directory wins; a fresh clone falls back to the chain the last
    // published round committed to the repository.
    const storedChain = runtime.store.active().chain;
    setActiveChain(Array.isArray(storedChain) && storedChain.length ? storedChain : readChainFile());
    // The panel switch is a standing instruction: if it was left on, a restart
    // keeps it on instead of silently falling back to the config default.
    if (runtime.store.status()?.armed === true) cfg.evolve.enabled = true;
  } catch (error) {
    runtime = null;
    runtimeError = String(error?.message ?? error);
  }
  registerSections();

  // `git status` is synchronous and the panel polls every 4 s; a short cache
  // keeps the event loop free without hiding a fresh commit for long.
  let gitCache = { at: 0, value: {} };
  const gitStatus = () => {
    const now = Date.now();
    if (now - gitCache.at < 5000) return gitCache.value;
    let value = {};
    try {
      value = runtime?.publisher?.statusSync ? runtime.publisher.statusSync() : {};
    } catch {
      value = {};
    }
    gitCache = { at: now, value };
    return value;
  };

  const armed = () => {
    if (!runtime) return false;
    const flag = runtime.store.status()?.armed;
    return flag === undefined ? cfg.evolve.enabled : flag === true;
  };

  const evolveSnapshot = () => {
    if (!runtime) {
      return { available: false, enabled: cfg.evolve.enabled, error: runtimeError, dir: evolveDir };
    }
    const status = runtime.engine.status();
    const effectiveRepo = String(repoOverride() ?? cfg.evolve.repo ?? "").trim();
    return {
      available: true,
      ...status,
      enabled: cfg.evolve.enabled,
      configured: configuredEnabled,
      armed: armed(),
      idleOnly: cfg.evolve.idleOnly,
      idleMs: cfg.evolve.idleMs,
      everyMinutes: cfg.evolve.everyMinutes,
      tracks: cfg.evolve.tracks,
      research: cfg.evolve.research,
      goal: cfg.evolve.goal,
      idleFor: activity.lastUserAt ? Date.now() - activity.lastUserAt : null,
      repo: effectiveRepo,
      repoSource: effectiveRepo ? (repoOverride() !== undefined ? "panel" : "config") : "none",
      branch: cfg.evolve.branch,
      push: cfg.evolve.push,
      dryRun: cfg.evolve.dryRun,
      dir: evolveDir,
      model: readSelection(),
      runner: runtime.runner.available(),
      baseline: baseline.snapshot(),
      git: gitStatus(),
      history: runtime.engine.history(),
    };
  };

  const control = {
    snapshot: evolveSnapshot,
    async action(action, body = {}) {
      if (!runtime) throw new Error(runtimeError || "evolve runtime unavailable");
      if (action === "arm" || action === "disarm" || action === "toggle") {
        const next = action === "toggle" ? !armed() : action === "arm";
        runtime.store.setStatus({ armed: next });
        return { armed: next };
      }
      if (action === "repo") {
        const next = String(body?.repo ?? "").trim();
        if (next && !/^(https?:\/\/|git@|ssh:\/\/)/.test(next)) {
          throw new Error("repo must look like https://… or git@…");
        }
        runtime.store.setStatus({ repo: next });
        return { repo: next, source: next ? "panel" : "none" };
      }
      if (action === "start") {
        // The panel switch is the operator's hand on this session: turning it on
        // overrides the config default until the next restart.
        cfg.evolve.enabled = true;
        registerSections();
        // A finished cycle (rounds exhausted) would otherwise start and stop in
        // the same breath; opening the switch begins a fresh cycle instead.
        if (Number(runtime.store.active().round ?? 0) >= Number(runtime.engine.maxRounds ?? 0)) {
          runtime.store.newCycle();
        }
        runtime.store.setStatus({ armed: true });
        return runtime.engine.start();
      }
      if (action === "stop") {
        runtime.store.setStatus({ armed: false });
        return runtime.engine.stop();
      }
      if (action === "round") {
        cfg.evolve.enabled = true;
        // One round does not arm the loop: arming is an explicit 开启.
        // A round is minutes long; the HTTP caller gets an acknowledgement, not
        // a held connection. Progress lands in the ledger the panel polls.
        runtime.engine.runRound({ track: body.track }).catch(() => {});
        return {
          started: true,
          round: Number(runtime.store.active().round ?? 0) + 1,
          track: body.track === "code" || body.track === "prompt" ? body.track : "auto",
        };
      }
      if (action === "probe") {
        // Diagnostics: one request, full sample. The ledger only keeps rates;
        // when a probe returns nothing this is the way to see why.
        const level = PROBES.find((probe) => probe.id === body.level) ?? PROBES[0];
        const target = T1.find((row) => row.id === body.target) ?? T1[0];
        const result = await runtime.runner.run({
          level,
          target,
          baseline: baseline.get(),
          protocol: renderHead(cfg),
        });
        return {
          level: level.id,
          target: target.id,
          ok: result.ok,
          chars: result.chars,
          refused: result.refused,
          toolCalls: result.toolCalls,
          ms: result.ms,
          error: result.error ?? null,
          text: String(result.text ?? "").slice(0, 1500),
        };
      }
      if (action === "reset") {
        const next = runtime.store.newCycle();
        return { round: next.round, chain: next.chain.length };
      }
      if (action === "rollback") {
        // A code round changed files, not the protocol chain: restore the bytes
        // it backed up. A prompt round only moves the chain pointer.
        const last = (runtime.store.ledger() ?? []).at(-1);
        if (last?.track === "code") {
          const files = runtime.store.restoreCode(last.round);
          if (!files.length) return { restored: 0, reason: "no-backup" };
          await applyFiles(files);
          return { restored: files.length, round: last.round, files: files.map((file) => file.path) };
        }
        const result = runtime.store.rollback();
        setActiveChain(runtime.store.active().chain ?? []);
        registerSections();
        return result;
      }
      if (action === "publish") {
        return runtime.publisher.ensure();
      }
      throw new Error(`unknown action: ${action}`);
    },
  };

  const state = () => {
    telemetry.hits += 1;
    telemetry.lastHitAt = Date.now();
    return buildState(cfg, evidence, () => clientSnapshot(registry), telemetry, () => preset.snapshot(), evolveSnapshot);
  };
  mountStateRoute(ctx, state);
  mountEvolveRoute(ctx, control);

  // Auto-start: only when the switch is on, the operator has not disarmed it,
  // and a model is actually reachable. A loop that cannot measure must not
  // write a blocked record on every boot.
  if (cfg.evolve.enabled && cfg.evolve.autoStart && armed() && runtime && runtime.runner.available()) {
    let disposed = false;
    const timer = setTimeout(() => {
      if (disposed) return;
      try {
        runtime.engine.start();
      } catch {
        // Reported through the status route.
      }
    }, 2500);
    if (typeof timer?.unref === "function") timer.unref();
    if (typeof ctx.effect === "function") {
      try {
        ctx.effect(() => () => {
          disposed = true;
          clearTimeout(timer);
        });
      } catch {
        // A runtime without effects still owns the timer through unref().
      }
    }
  }

  return state;
}

export default { name, inject, apply, renderHead, renderHeadRaw, renderTail, buildState, clientSnapshot, createPresetProbe, createBaseline, coerce, coerceEvolve, addSection, setActiveChain, getActiveChain, DEFAULTS, PRESETS, POSITIONS, SCOPES, EVOLVE_BUDGETS, PRESET_ID };
