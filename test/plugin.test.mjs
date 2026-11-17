import { test } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";

// dsh evaluates section text providers at assembly; resolve them the same way.
const textOf = (section) => typeof section.text === "function" ? section.text({}) : section.text;
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// apply() loads the persisted transform chain from DSH_HOME. A test must not
// inherit whatever the operator's own loop kept overnight.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "point-home-"));

import plugin, { apply, renderHead, renderTail, buildState, clientSnapshot, createPresetProbe, DEFAULTS, setActiveChain } from "../lib/index.js";
import { MARKER } from "../lib/refusal.js";
import sectionRow, { apply as sectionApply } from "../lib/section.js";
import { TAGS } from "../lib/envelope.js";

function fakeCtx() {
  const sections = [];
  const effects = [];
  return {
    sections,
    effects,
    systemPrompt: {
      section(s) {
        sections.push(s);
        return () => {};
      },
    },
    effect(fn) {
      effects.push(fn);
    },
  };
}

test("apply registers a head section with the configured order", () => {
  const ctx = fakeCtx();
  apply(ctx, { scope: "global" });
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, "point");
  assert.equal(ctx.sections[0].order, DEFAULTS.order);
  assert.equal(ctx.sections[0].interpolate, false);
  assert.ok(textOf(ctx.sections[0]).includes("## Who You Are"));
});

test("position both registers head and tail in order", () => {
  const ctx = fakeCtx();
  apply(ctx, { scope: "global", position: "both", tailMode: "anchor" });
  assert.deepEqual(ctx.sections.map((s) => s.name), ["point", "point:tail"]);
  assert.ok(ctx.sections[1].order > ctx.sections[0].order);
  assert.ok(textOf(ctx.sections[1]).length < 700);
});

test("tail mode full duplicates the payload", () => {
  const ctx = fakeCtx();
  apply(ctx, { scope: "global", position: "tail", tailMode: "full", mode: "minimal" });
  assert.equal(ctx.sections[0].name, "point:tail");
  assert.equal(textOf(ctx.sections[0]), renderHead({ mode: "minimal" }));
});

test("disabled registers nothing", () => {
  const ctx = fakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(ctx.sections.length, 0);
});

test("a runtime without systemPrompt.section fails loudly", () => {
  assert.throws(() => apply({}, { scope: "global" }), /systemPrompt\.section is unavailable/);
});

test("section disposers are owned by ctx.effect", () => {
  const ctx = fakeCtx();
  apply(ctx, { scope: "global" });
  // One effect owns the section disposers, another the auto-start timer.
  assert.ok(ctx.effects.length >= 1);
  for (const effect of ctx.effects) assert.equal(typeof effect, "function");
});

test("deva preset loads the verbatim payload", () => {
  const text = renderHead({ preset: "deva" });
  assert.ok(text.length > 20000, `len ${text.length}`);
  assert.ok(text.includes(TAGS.IM_START));
  assert.ok(text.includes("[OPERATION: STABLE]"));
  assert.ok(text.includes("pointer"));
});

test("deva preset substitutes identity and operator", () => {
  const text = renderHead({ preset: "deva", identity: "Operator", operator: "K" });
  assert.ok(!text.includes("pointer"));
  assert.ok(text.includes("Operator"));
});

test("envelope option wraps the generated payload", () => {
  const text = renderHead({ envelope: true, mode: "minimal" });
  assert.ok(text.startsWith(`${TAGS.IM_START}system\n${TAGS.OPEN}`));
  assert.ok(text.endsWith(`${TAGS.CLOSE}\n${TAGS.IM_END}`));
  const plain = renderHead({ mode: "minimal" });
  assert.ok(!plain.includes(TAGS.IM_START));
});

test("maxChars caps both presets", () => {
  assert.ok(renderHead({ maxChars: 2000 }).length <= 2000);
  assert.ok(renderHead({ preset: "deva", maxChars: 5000 }).length <= 5000);
});

test("interpolation braces in a custom prompt are neutralized", () => {
  const text = renderHead({ preset: "custom", prompt: "keep {{unknown_name}} literal" });
  assert.ok(text.includes("{ {unknown_name}}"));
});

test("plugin module exposes the dsh contract", () => {
  assert.equal(plugin.name, "point");
  assert.deepEqual(plugin.inject, ["systemPrompt"]);
  assert.equal(typeof plugin.apply, "function");
  assert.equal(typeof renderTail, "function");
});

test("clientSnapshot reads the composed row for this package", () => {
  const registry = {
    graph: () => ({
      rev: "g1",
      release: { version: "0.2.2" },
      entries: [
        { id: "react", url: "plugins/??react/client.js&rev=a" },
        { id: "point", url: "plugins/??point/client.js&rev=b", rev: "b", immediately: true, external: ["react"] },
      ],
    }),
    clientPath: (id) => (id === "point" ? "/Volumes/new/point/point/client.js" : undefined),
  };
  const snap = clientSnapshot(registry);
  assert.equal(snap.available, true);
  assert.equal(snap.mounted, true);
  assert.equal(snap.rows, 2);
  assert.equal(snap.rev, "b");
  assert.equal(snap.url, "plugins/??point/client.js&rev=b");
  assert.equal(snap.immediately, true);
  assert.deepEqual(snap.external, ["react"]);
  assert.equal(snap.path, "/Volumes/new/point/point/client.js");
  assert.equal(snap.graphRev, "g1");
});

test("clientSnapshot reports an unmounted package and tolerates failures", () => {
  const empty = clientSnapshot({ graph: () => ({ entries: [] }), clientPath: () => undefined });
  assert.equal(empty.available, true);
  assert.equal(empty.mounted, false);
  assert.equal(empty.rev, null);
  assert.equal(clientSnapshot(null).available, false);
  const broken = clientSnapshot({ graph() { throw new Error("no loader"); } });
  assert.equal(broken.available, false);
  assert.equal(broken.error, "no loader");
});

test("buildState publishes the client diagnostic", () => {
  const state = buildState({}, null, () => ({ available: true, mounted: true, rev: "b" }));
  assert.equal(state.client.mounted, true);
  assert.equal(state.client.rev, "b");
  const fallback = buildState({});
  assert.equal(fallback.client.available, false);
  const thrown = buildState({}, null, () => { throw new Error("boom"); });
  assert.equal(thrown.client.available, false);
  assert.equal(thrown.client.error, "boom");
});

test("a disabled plugin keeps the status route and reports itself off", () => {
  const sections = [];
  const routes = [];
  const ctx = {
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; } },
    effect(fn) { return fn(); },
    on() {},
    inject(deps, callback) {
      assert.deepEqual(deps, ["webServer"]);
      callback({
        effect: (fn) => fn(),
        webServer: { register(route) { routes.push(route); return () => {}; } },
      });
    },
  };

  apply(ctx, { enabled: false });
  assert.equal(sections.length, 0, "no prompt section while disabled");
  const paths = routes.map((route) => route.path).sort();
  assert.deepEqual(paths, ["/point/evolve", "/point/state"]);
  const stateRoute = routes.find((route) => route.path === "/point/state");

  const res = { code: 0, body: "", writeHead(code) { this.code = code; }, end(chunk) { if (chunk) this.body += chunk; } };
  stateRoute.handler({ method: "GET" }, res);
  assert.equal(res.code, 200);
  const state = JSON.parse(res.body);
  assert.equal(state.status.enabled, false);
  assert.ok(state.head.chars > 0, "the panel still previews what would be injected");
  assert.equal(state.evidence.count, 0);
});

test("the status route answers 405 for a write and no body for HEAD", () => {
  const routes = [];
  const ctx = {
    systemPrompt: { section: () => () => {} },
    effect(fn) { return fn(); },
    on() {},
    inject(_deps, callback) {
      callback({
        effect: (fn) => fn(),
        webServer: { register(route) { routes.push(route); return () => {}; } },
      });
    },
  };
  apply(ctx, {});
  const route = routes.find((row) => row.path === "/point/state");

  const write = { code: 0, headers: null, writeHead(code, headers) { this.code = code; this.headers = headers; }, end() {} };
  route.handler({ method: "POST" }, write);
  assert.equal(write.code, 405);

  const head = { code: 0, headers: null, body: "", writeHead(code, headers) { this.code = code; this.headers = headers; }, end(chunk) { if (chunk) this.body += chunk; } };
  route.handler({ method: "HEAD" }, head);
  assert.equal(head.code, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["cache-control"], "no-store");
});

test("the evolve route rejects malformed bodies instead of pretending to act", async () => {
  const routes = [];
  const ctx = {
    systemPrompt: { section: () => () => {} },
    effect(fn) { return fn(); },
    on() {},
    inject(_deps, callback) {
      callback({
        effect: (fn) => fn(),
        webServer: { register(route) { routes.push(route); return () => {}; } },
      });
    },
  };
  apply(ctx, {});
  const route = routes.find((row) => row.path === "/point/evolve");

  const call = async (method, body) => {
    const req = new EventEmitter();
    req.method = method;
    const res = { code: 0, body: "", writeHead(code) { this.code = code; }, end(chunk) { if (chunk) this.body += chunk; } };
    const done = route.handler(req, res);
    process.nextTick(() => {
      if (body) req.emit("data", Buffer.from(body));
      req.emit("end");
    });
    await done;
    return res;
  };

  const bad = await call("POST", "{oops");
  assert.equal(bad.code, 400);
  assert.match(bad.body, /invalid JSON/);

  const array = await call("POST", "[1,2]");
  assert.equal(array.code, 400);
  assert.match(array.body, /JSON object/);

  const missing = await call("POST", "{}");
  assert.equal(missing.code, 400);
  assert.match(missing.body, /missing action/);

  const unknown = await call("POST", JSON.stringify({ action: "nope" }));
  assert.equal(unknown.code, 400);
  assert.match(unknown.body, /unknown action/);

  const get = await call("GET", null);
  assert.equal(get.code, 200);
  assert.equal(typeof JSON.parse(get.body), "object", "GET returns the snapshot itself");
});

function fakeHost(extra = {}) {
  const ctx = fakeCtx();
  const handlers = new Map();
  const services = { agentPresets: null, ...extra };
  ctx.on = (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
  };
  ctx.inject = (deps, callback) => {
    const scope = { effect: (fn) => fn() };
    if (deps.includes("agentPresets") && services.agentPresets) scope.agentPresets = services.agentPresets;
    if (deps.includes("clientModules")) scope.clientModules = { graph: () => ({ rev: "r1", release: "t", entries: [] }) };
    if (deps.includes("webServer")) return;
    callback(scope);
  };
  ctx.handlers = handlers;
  return ctx;
}

test("scope preset leaves the prompt half to the preset", () => {
  const ctx = fakeHost();
  const state = apply(ctx, {});
  assert.equal(ctx.sections.length, 0, "the global row injects nothing");
  const snapshot = state();
  assert.equal(snapshot.status.scope, "preset");
  assert.equal(snapshot.status.injected, false);
  assert.equal(snapshot.head.chars > 20000, true, "the payload is still rendered for the panel");
});

test("scope global is the only path that registers sections", () => {
  const ctx = fakeHost();
  apply(ctx, { scope: "global", position: "both" });
  assert.deepEqual(ctx.sections.map((s) => s.name), ["point", "point:tail"]);
});

test("the preset probe reports a missing service", async () => {
  const probe = createPresetProbe();
  const snapshot = probe.snapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.registered, null);
});

test("the preset probe reads the roster and finds the point entry", async () => {
  const probe = createPresetProbe();
  probe.bind({
    async list() {
      return [
        { id: "standard", name: "标准模式" },
        { id: "point", name: "破甲模式", description: "…" },
      ];
    },
  });
  await probe.refresh();
  const snapshot = probe.snapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.registered, true);
  assert.equal(snapshot.name, "破甲模式");
  assert.equal(snapshot.count, 2);
});

test("the preset probe survives a roster that throws", async () => {
  const probe = createPresetProbe();
  probe.bind({ async list() { throw new Error("registry not ready"); } });
  await probe.refresh();
  const snapshot = probe.snapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.registered, null);
  assert.match(snapshot.error, /registry not ready/);
});

test("the refusal retry only wraps requests that carry the protocol", async () => {
  const ctx = fakeHost();
  apply(ctx, { scope: "global" });
  const hook = ctx.handlers.get("llm/stream").at(-1);
  assert.ok(hook, "the llm/stream hook is registered");

  const plain = { messages: [{ role: "system", content: "plain prompt" }] };
  let called = 0;
  const untouched = hook(plain, () => {
    called += 1;
    return { kind: "stream" };
  });
  assert.equal(called, 1);
  assert.deepEqual(untouched, { kind: "stream" }, "a foreign session is passed through");

  const ours = { messages: [{ role: "system", content: `${MARKER}\nbody` }] };
  const wrapped = hook(ours, () => (async function* () {})());
  assert.equal(typeof wrapped[Symbol.asyncIterator], "function");

  // A probe is a measurement: the retry must never rewrite it.
  const probe = { purpose: "point-probe", system: `${MARKER}\nbody`, messages: [{ role: "user", content: "x" }] };
  assert.deepEqual(hook(probe, () => ({ kind: "probe-stream" })), { kind: "probe-stream" });
});

test("retryRefusal: false leaves the stream alone", () => {
  const ctx = fakeHost();
  apply(ctx, { scope: "global", retryRefusal: false });
  const listeners = ctx.handlers.get("llm/stream") || [];
  assert.equal(listeners.length, 1, "only the idle tracker remains");
  const sentinel = { kind: "stream" };
  const out = listeners[0]({ messages: [{ role: "system", content: `${MARKER}\nbody` }] }, () => sentinel);
  assert.equal(out, sentinel, "no buffering, no re-ask");
});

test("point/section is a self-contained cordis row", () => {
  assert.equal(sectionRow.name, "point/section");
  assert.deepEqual(sectionRow.inject, ["systemPrompt"]);
  assert.equal(typeof sectionRow.apply, "function");

  const ctx = fakeCtx();
  sectionRow.apply(ctx, { position: "tail" });
  assert.deepEqual(ctx.sections.map((s) => s.name), ["point:tail"]);

  const off = fakeCtx();
  sectionRow.apply(off, { enabled: false });
  assert.equal(off.sections.length, 0);
});

test("the evolve route refuses cross-origin actions and unknown hosts", async () => {
  const routes = [];
  const ctx = {
    sections: [],
    systemPrompt: { section(section) { this.sections.push(section); return () => {}; } },
    effect(fn) { return fn(); },
    on() {},
    inject(_deps, callback) {
      callback({
        effect: (fn) => fn(),
        webServer: { register(route) { routes.push(route); return () => {}; } },
      });
    },
  };
  apply(ctx, { enabled: false });
  const route = routes.find((row) => row.path === "/point/evolve");
  const call = async (headers, body = "{\"action\":\"stop\"}") => {
    const res = { code: 0, body: "", writeHead(code) { this.code = code; }, end(chunk) { if (chunk) this.body += chunk; } };
    const req = Object.assign(new EventEmitter(), { method: "POST", headers });
    const done = route.handler(req, res);
    req.emit("data", Buffer.from(body));
    req.emit("end");
    await done;
    return res;
  };

  const evil = await call({ host: "127.0.0.1:64760", origin: "http://evil.example" });
  assert.equal(evil.code, 403);

  const site = await call({ host: "127.0.0.1:64760", "sec-fetch-site": "cross-site" });
  assert.equal(site.code, 403);

  const plain = await call({ host: "127.0.0.1:64760", "content-type": "text/plain" });
  assert.equal(plain.code, 415);

  const rebound = { code: 0, body: "", writeHead(code) { this.code = code; }, end(chunk) { if (chunk) this.body += chunk; } };
  route.handler({ method: "GET", headers: { host: "attacker.example" } }, rebound);
  assert.equal(rebound.code, 403);

  const local = { code: 0, body: "", writeHead(code) { this.code = code; }, end(chunk) { if (chunk) this.body += chunk; } };
  route.handler({ method: "GET", headers: { host: "127.0.0.1:64760" } }, local);
  assert.equal(local.code, 200);
});

test("a misspelt mode falls back to full instead of injecting the largest payload", () => {
  const snapshot = apply(fakeHost(), { enabled: false, mode: "minmal" })();
  assert.equal(snapshot.config.mode, "full");
});

test("the envelope reserve is the real overhead, not a guess", () => {
  const capped = renderHead({ maxChars: 300, envelope: true });
  assert.ok(capped.length <= 300, `got ${capped.length}`);
  assert.ok(capped.startsWith("<|im_start|>system"), "the envelope stays closed");
  assert.ok(capped.trimEnd().endsWith("<|im_end|>"));
});

test("scope preset section text reflects a kept chain without remount", () => {
  // The preset-scoped child registers a provider, not a snapshot: a kept round
  // changes activeChain in the global half and the next assembly must see it.
  const ctx = fakeCtx();
  apply(ctx, { scope: "preset" });
  assert.equal(ctx.sections.length, 0, "the global plugin stays passive in preset scope");
  // The child entry is a separate module; check its registered shape directly.
  const childCtx = fakeCtx();
  sectionApply(childCtx, { scope: "preset" });
  assert.equal(typeof childCtx.sections[0].text, "function");
  const before = childCtx.sections[0].text({});
  setActiveChain([{ axis: "A1", id: "c1" }]);
  const after = childCtx.sections[0].text({});
  setActiveChain([]);
  assert.notEqual(after, before, "provider must re-render on the next assembly");
});

test("envelope stays closed even after a kept transform and a tight cap", () => {
  setActiveChain([{ axis: "T3", id: "c1" }]);
  try {
    for (const cap of [100, 200, 2000]) {
      const text = renderHead({ preset: "core", envelope: true, maxChars: cap });
      assert.ok(text.startsWith("<|im_start|>"), `cap ${cap}: header first`);
      assert.ok(text.trimEnd().endsWith("<|im_end|>"), `cap ${cap}: envelope closed`);
      assert.ok(text.length <= cap, `cap ${cap}: within budget`);
    }
  } finally {
    setActiveChain([]);
  }
});
