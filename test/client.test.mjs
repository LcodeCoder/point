// Client-half tests: no browser, no bundler. The bundle is a classic script that
// hands a factory to window.__ModuleLoader__, so the test supplies that window,
// a minimal React stand-in, and a slot registry that records registrations.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildState, createEvidence } from "../lib/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal React: elements are plain objects, hooks return their initial value. */
function makeReact(overrides = []) {
  let cursor = 0;
  const next = (fallback) => {
    const value = overrides[cursor];
    cursor += 1;
    return value === undefined ? fallback : value;
  };
  return {
    Fragment: "Fragment",
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) };
    },
    useState(init) {
      return [next(typeof init === "function" ? init() : init), () => {}];
    },
    useEffect() {},
    useRef(init) {
      return { current: init === undefined ? null : init };
    },
    useMemo(fn) {
      return fn();
    },
    useCallback(fn) {
      return fn;
    },
  };
}

function loadBundle(react) {
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  let registration;
  const win = {
    __ModuleLoader__: {
      load(def) {
        registration = def;
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function("window", source)(win);
  assert.ok(registration, "the bundle must register with the module loader");
  assert.equal(registration.id, "point");
  const plugin = registration.factory((request) => {
    if (request === "react") return react;
    throw new Error(`unexpected require: ${request}`);
  });
  return plugin;
}

/** Collect every string/number in a rendered tree, evaluating function components. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node === "object") {
    if (typeof node.type === "function") {
      textOf(node.type(node.props), out);
      return out;
    }
    if (node.children) for (const child of node.children) textOf(child, out);
  }
  return out;
}

const flatten = (node) => textOf(node).join(" ");

function sampleState() {
  const evidence = createEvidence();
  evidence.record({
    sections: [
      { name: "point", text: "x".repeat(24170) },
      { name: "deployment:persona-prefix", text: "persona" },
      { name: "point:tail", text: "y".repeat(420) },
    ],
  }, { scope: {} });
  return buildState(
    { position: "both" },
    evidence,
    undefined,
    undefined,
    () => ({ available: true, id: "point", registered: true, name: "破甲模式", count: 4 }),
    () => ({
      available: true,
      enabled: true,
      armed: false,
      phase: "idle",
      round: 2,
      maxRounds: 6,
      budget: { small: 6, full: 24, sealed: 12, normal: 8 },
      ledger: 2,
      kept: 1,
      repo: "https://github.com/LcodeCoder/point.git",
      branch: "main",
      push: true,
      dir: "/tmp/point-evolve",
      model: { provider: "p", model: "m" },
      runner: true,
      baseline: { chars: 1200 },
      git: { ok: true },
      last: { round: 2, decision: "keep", e2e: { before: 0.17, after: 0.5 } },
      history: [{ round: 2, axis: "A1", decision: "keep", eval: { e2e: { after: 0.5 } } }],
    }),
  );
}

function fakeContext() {
  const registrations = [];
  const commands = [];
  let selected = null;
  const ctx = {
    slots: {
      inject(_name, callback) {
        callback();
      },
      register(spec, component) {
        registrations.push({ spec, component });
        return () => {};
      },
    },
    inject(_deps, callback) {
      callback({
        effect(factory) {
          const dispose = factory();
          return () => { if (typeof dispose === "function") dispose(); };
        },
        commandUi: {
          register(contribution) {
            commands.push(contribution);
            return () => {};
          },
        },
        layout: {
          selectPanel(id) {
            selected = id;
          },
        },
      });
    },
  };
  return { ctx, registrations, commands, selected: () => selected };
}

test("bundle registers a plugin with the slot and command surfaces", () => {
  const plugin = loadBundle(makeReact());
  assert.deepEqual(plugin.inject, ["slots"]);
  const { ctx, registrations, commands, selected } = fakeContext();
  plugin.apply(ctx);

  const main = registrations.find((row) => row.spec.name === "main");
  const tab = registrations.find((row) => row.spec.name === "sidebar.panellist");
  assert.ok(main, "the panel registers into the keyed main slot");
  assert.equal(main.spec.key, "point");
  assert.ok(tab, "the sidebar tab registers into sidebar.panellist");
  assert.equal(tab.spec.id, "point");
  assert.equal(typeof tab.component, "function");

  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, "point");
  assert.equal(commands[0].ui.kind, "action");
  commands[0].ui.run({});
  assert.equal(selected(), "point");
});

test("panel renders the loading state before the first payload", () => {
  const plugin = loadBundle(makeReact());
  const panel = plugin.apply ? null : null;
  void panel;
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const PointPanel = registrations.find((row) => row.spec.name === "main").component;
  const text = flatten(PointPanel({}));
  assert.match(text, /破甲协议/);
  assert.match(text, /读取中/);
});

test("every tab renders against a real state payload", () => {
  const react = makeReact();
  const plugin = loadBundle(react);
  const { ctx, registrations } = fakeContext();
  plugin.apply(ctx);
  const PointPanel = registrations.find((row) => row.spec.name === "main").component;
  const state = sampleState();

  // Hook order in PointPanel: tab, view, nonce, toast.
  for (const tab of ["overview", "content", "results", "evolve", "rules"]) {
    const view = { kind: "ready", data: state };
    const hooks = makeReact([tab, view, 0, ""]);
    const tree = (() => {
      const source = readFileSync(join(ROOT, "client.js"), "utf8");
      let registration;
      const win = { __ModuleLoader__: { load: (def) => { registration = def; } } };
      new Function("window", source)(win);
      const local = registration.factory((request) => {
        if (request === "react") return hooks;
        throw new Error(request);
      });
      const localCtx = fakeContext();
      local.apply(localCtx.ctx);
      return localCtx.registrations.find((row) => row.spec.name === "main").component({});
    })();

    const text = flatten(tree);
    assert.match(text, /破甲模式/, `tab ${tab} shows the mode pill`);
    assert.ok(text.length > 40, `tab ${tab} renders content`);
    if (tab === "results") {
      assert.match(text, /破甲成果/);
      assert.match(text, /scope#1/);
      assert.match(text, /deployment:persona-prefix/);
    }
    if (tab === "content") {
      assert.match(text, /分段构成/);
    }
    if (tab === "overview") {
      assert.match(text, /界面半（客户端）/);
      assert.match(text, /重启 dsh 后生效/);
    }
    if (tab === "evolve") {
      assert.match(text, /开启自动迭代/);
      assert.match(text, /github\.com\/LcodeCoder\/point/);
      assert.match(text, /跑一轮/);
    }
    if (tab === "rules") {
      assert.match(text, /类别锁规则表/);
    }
  }
  assert.equal(typeof PointPanel, "function");
});

test("the error branch names the missing Host route", () => {
  const hooks = makeReact(["overview", { kind: "error", error: "HTTP 404" }, 0, ""]);
  const source = readFileSync(join(ROOT, "client.js"), "utf8");
  let registration;
  const win = { __ModuleLoader__: { load: (def) => { registration = def; } } };
  new Function("window", source)(win);
  const plugin = registration.factory((request) => {
    if (request === "react") return hooks;
    throw new Error(request);
  });
  const local = fakeContext();
  plugin.apply(local.ctx);
  const panel = local.registrations.find((row) => row.spec.name === "main").component({});
  const text = flatten(panel);
  assert.match(text, /Host 半未激活/);
  assert.match(text, /HTTP 404/);
});
