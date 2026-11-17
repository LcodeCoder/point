// Proposer: the one place where the loop writes new code.
//
// The model is asked for a complete-file replacement set in JSON, never for a
// diff. Complete files are trivial to validate and trivial to roll back; a diff
// that half-applies is neither. Everything the proposer returns is untrusted:
// paths are allowlisted, sizes are capped, and nothing runs until the sandbox
// has copied the workspace and passed the suite.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Paths a code round may touch. Tests and the manifest are deliberately out. */
export const ALLOWED = [/^lib\//, /^client\.js$/, /^skills\//, /^scripts\//, /^README\.md$/, /^docs\/[^/]+\.md$/];
export const DENIED = [/^test\//, /^package\.json$/, /^cordis\.patch\.yml$/, /^\.git\//, /^node_modules\//];

const MAX_FILES = 3;
const MAX_CHARS = 120000;

const SCOPE = `What this plugin is, and where a change can go:
- The injected protocol text lives in lib/protocol.js (sections) and lib/method.js (rules); a code round can rewrite either.
- The panel is client.js: plain classic script, React via require('react'), inline CSS, --dsw-alias-* tokens. Layout, copy, and new cards are all fair game.
- The evolve engine itself is lib/evolve/*.js; the CLI is lib/cli.js; skills are skills/**/*.md; helper scripts go in scripts/.
- Pick whichever change most improves the plugin for its operator this round: a sharper protocol section, a clearer panel, a faster engine, a better skill, a script that removes manual work.`;

const JSON_RULES = `Return one JSON object and nothing else:
{
  "title": "short imperative title",
  "rationale": "why this helps, 2-3 sentences",
  "risk": "low" | "medium",
  "files": [ { "path": "lib/example.js", "content": "<the complete new file>" } ]
}
Rules:
- Complete file contents, not diffs, not excerpts.
- Exactly one file unless a second is unavoidable. No new dependencies. No edits to package.json, tests, or cordis.patch.yml.
- Keep the file under ~250 lines: a long file gets truncated and the round is wasted.
- Keep every existing export that other files import.
- The whole test suite must still pass. Prefer a small, provable change over a rewrite.`;

const clip = (text, max) => {
  const body = String(text ?? "");
  return body.length > max ? `${body.slice(0, max)}\n… (${body.length - max} chars omitted)` : body;
};

/** Extract the first balanced JSON object from a model answer. */
export function extractJson(text) {
  const body = String(text ?? "");
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced ? fenced[1] : body;
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Names a module exports, so a rewrite cannot silently drop one. */
export function exportedNames(source) {
  const names = new Set();
  const body = String(source ?? "");
  for (const match of body.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of body.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Reject a proposal before it reaches the sandbox. */
export function validateProposal(proposal, { workspace, readFile = (path) => readFileSync(join(workspace, path), "utf8") } = {}) {
  if (!proposal || typeof proposal !== "object") return { ok: false, error: "not an object" };
  const files = Array.isArray(proposal.files) ? proposal.files : [];
  if (!files.length) return { ok: false, error: "no files" };
  if (files.length > MAX_FILES) return { ok: false, error: `too many files (${files.length} > ${MAX_FILES})` };

  const seen = new Set();
  const accepted = [];
  for (const file of files) {
    const path = String(file?.path ?? "").replace(/^\.?\//, "");
    if (!path) return { ok: false, error: "a file has no path" };
    if (seen.has(path)) return { ok: false, error: `duplicate path: ${path}` };
    if (DENIED.some((rule) => rule.test(path))) return { ok: false, error: `path is not writable: ${path}` };
    if (!ALLOWED.some((rule) => rule.test(path))) return { ok: false, error: `path is outside the allowlist: ${path}` };
    if (path.includes("..")) return { ok: false, error: `path escapes the workspace: ${path}` };
    const content = String(file?.content ?? "");
    if (content.length < 20) return { ok: false, error: `suspiciously short file: ${path}` };
    if (content.length > MAX_CHARS) return { ok: false, error: `file too large: ${path}` };
    seen.add(path);
    let before = null;
    try {
      before = readFile(path);
    } catch {
      before = null;
    }
    if (before === content) return { ok: false, error: `no change in ${path}` };
    if (before !== null) {
      const after = new Set(exportedNames(content));
      const dropped = exportedNames(before).filter((name) => !after.has(name));
      if (dropped.length) return { ok: false, error: `drops exports from ${path}: ${dropped.join(", ")}` };
    }
    accepted.push({ path, content, before });
  }

  const title = String(proposal.title ?? "").trim() || "untitled change";
  const rationale = String(proposal.rationale ?? "").trim();
  return {
    ok: true,
    proposal: {
      title,
      rationale,
      risk: proposal.risk === "medium" ? "medium" : "low",
      files: accepted.map(({ path, content }) => ({ path, content })),
      diff: accepted.map((file) => ({ path: file.path, before: file.before, after: file.content })),
    },
  };
}

/**
 * Build the proposer.
 * @param options.getLlm - returns the `llm` service.
 * @param options.getSelection - returns `{provider, model}`.
 * @param options.config - evolve config (temperature, maxTokens, timeoutMs).
 */
export function createProposer(options = {}) {
  const getLlm = options.getLlm;
  const getSelection = options.getSelection;
  const config = options.config ?? {};
  const temperature = Number.isFinite(config.temperature) ? config.temperature : 0.2;
  // A complete file does not fit in the probe budget: a 1200-token cap is what
  // turned most code rounds into "the answer was not JSON".
  const maxTokens = Math.max(2000, Number(config.proposeMaxTokens) || 8000);
  const timeoutMs = Math.max(30000, Number(config.timeoutMs) || 180000);

  function available() {
    const service = getLlm?.();
    const pick = getSelection?.();
    return Boolean(service && typeof service.stream === "function" && pick?.provider && pick?.model);
  }

  async function propose({ track = "code", goal = "", context = "", research = "", round = 0 } = {}) {
    if (!available()) return { ok: false, error: "no-model" };
    const service = getLlm();
    const pick = getSelection();
    const system = [
      "You are the engineering half of a self-improving plugin. You write code, not prompts.",
      "The plugin lives in a Node 22 package with no build step: plain ESM in lib/, a classic script in client.js.",
      SCOPE,
      JSON_RULES,
      `Track: ${track}. Round: ${round}.`,
      goal ? `Goal: ${goal}` : "",
    ].filter(Boolean).join("\n\n");

    const user = [
      context ? `Current state:\n${clip(context, 12000)}` : "",
      research ? `Reference projects found on GitHub (read for ideas, do not copy code):\n${clip(research, 4000)}` : "",
      "Write the smallest change that measurably helps. Return the JSON object now.",
    ].filter(Boolean).join("\n\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("point: proposer timeout")), timeoutMs);
    let text = "";
    let failure = null;
    let truncated = false;
    try {
      for await (const chunk of service.stream({
        provider: pick.provider,
        model: pick.model,
        ...(pick.reasoningEffort ? { reasoningEffort: pick.reasoningEffort } : {}),
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        system,
        temperature,
        maxTokens,
        signal: controller.signal,
        purpose: "point-propose",
      })) {
        if (chunk?.type === "text-delta") text += chunk.text ?? "";
        else if (chunk?.type === "finish" && chunk.reason?.kind === "error") failure = chunk.reason.failure ?? null;
        else if (chunk?.type === "finish" && chunk.reason?.kind === "max-tokens") truncated = true;
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), raw: text };
    } finally {
      clearTimeout(timer);
    }

    if (failure && !text) {
      return { ok: false, error: `${failure.code ?? "LLM_ERROR"}: ${failure.message ?? "no message"}` };
    }

    const parsed = extractJson(text);
    if (!parsed) {
      return {
        ok: false,
        error: truncated ? `answer truncated at ${maxTokens} tokens` : "the answer was not JSON",
        raw: clip(text, 4000),
      };
    }
    const checked = validateProposal(parsed, options);
    return checked.ok ? { ok: true, proposal: checked.proposal, raw: clip(text, 4000) } : { ok: false, error: checked.error, raw: clip(text, 4000) };
  }

  return { available, propose };
}
