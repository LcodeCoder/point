// Integration test against the real dsh SystemPrompt service.
//
// Skips when the dsh app is not on this machine. Override the location with
// DSH_APP_ROOT=/path/to/app/dsh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = process.env.DSH_APP_ROOT ?? "/Volumes/new/DeepSeek Harness.app/Contents/Resources/app/dsh";
const CORDIS = join(APP, "node_modules/@deepseek-ai/cordis/lib/index.js");
const PROMPT = join(APP, "node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js");
const available = existsSync(CORDIS) && existsSync(PROMPT);

test("plugin mounts into the real prompt service and sorts before the persona", { skip: !available }, async () => {
  const { Context } = await import(pathToFileURL(CORDIS).href);
  const mod = await import(pathToFileURL(PROMPT).href);
  const { apply } = await import("../lib/index.js");

  const ctx = new Context();
  await ctx.plugin(mod.default, { includeHarnessIdentity: false });
  apply(ctx, { scope: "global", position: "both" });

  const asm = await ctx.systemPrompt.assemble(undefined, {});
  const names = asm.sections.map((s) => s.name);
  assert.ok(names.includes("point"));
  assert.ok(names.includes("point:tail"));
  assert.ok(
    names.indexOf("point") < names.indexOf("deployment:persona-prefix"),
    "point must sort before the deployment persona",
  );
  assert.equal(asm.sections.find((s) => s.name === "point").interpolate, false);

  const text = mod.renderPrompt(asm);
  assert.ok(text.startsWith("[OPERATION: STABLE]"), text.slice(0, 40));
  assert.ok(text.includes("## Draft Review"));
  assert.ok(text.includes("## Category Lock"));
});

test("a remount in the same scope is a no-op", { skip: !available }, async () => {
  const { Context } = await import(pathToFileURL(CORDIS).href);
  const mod = await import(pathToFileURL(PROMPT).href);
  const { apply } = await import("../lib/index.js");

  const ctx = new Context();
  await ctx.plugin(mod.default, { includeHarnessIdentity: false });
  apply(ctx, { scope: "global" });
  assert.doesNotThrow(() => apply(ctx, { scope: "global" }));
  const asm = await ctx.systemPrompt.assemble(undefined, {});
  assert.equal(asm.sections.filter((s) => s.name === "point").length, 1);
});

test("the point/section row injects the protocol into a real scope", { skip: !available }, async () => {
  const { Context } = await import(pathToFileURL(CORDIS).href);
  const mod = await import(pathToFileURL(PROMPT).href);
  const section = await import("../lib/section.js");

  const ctx = new Context();
  await ctx.plugin(mod.default, { includeHarnessIdentity: false });
  await ctx.plugin(section.default, { position: "both" });

  const asm = await ctx.systemPrompt.assemble(undefined, {});
  const names = asm.sections.map((s) => s.name);
  assert.deepEqual(names.filter((n) => n.startsWith("point")), ["point", "point:tail"]);
  const text = mod.renderPrompt(asm);
  assert.ok(text.startsWith("[OPERATION: STABLE]"));
  assert.ok(text.includes("## Draft Review"));
});

test("the shipped preset declares the standard composition plus one row of ours", async () => {
  const { readFileSync } = await import("node:fs");
  const yaml = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  const row = yaml.slice(yaml.indexOf("- id: preset-point"));
  assert.match(row, /name: '@deepseek-ai\/dsh-agent-preset'/);
  assert.match(row, /id: point\n\s+name: 破甲模式/);
  assert.match(row, /name: point\/section/);
  for (const plugin of ["persona", "agent-instructions", "tool-bash", "tool-fs", "skill-filesystem", "tool-web", "present"]) {
    assert.ok(row.includes(plugin), `the preset keeps ${plugin}`);
  }
});

test("the bundle patch ships the self-evolution switch, off by default", () => {
  const yaml = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  const row = yaml.slice(yaml.indexOf("- id: point"));
  assert.match(row, /evolve:\n\s+enabled: false/);
  assert.match(row, /tracks: \[prompt, code\]/);
  assert.match(row, /research: true/);
  assert.match(row, /repo: ""/, "no repository is baked in: the operator names their own");
  assert.match(row, /rounds: 6/);
  assert.match(row, /push: true/);
  assert.match(row, /budget: fast/);
});
