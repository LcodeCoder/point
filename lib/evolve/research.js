// Research: look at how other people solved the same problem before writing code.
//
// The loop is allowed to search GitHub for reference projects. What it gets is
// not code to copy - it is a short brief (name, stars, description, topics) that
// the proposer reads before it writes a change. Notes are cached on disk so a
// later round can read what an earlier round already found.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.github.com/search/repositories";
const NOTE_LIMIT = 8;

const slug = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "note";

const clip = (text, max) => {
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  return body.length > max ? `${body.slice(0, max - 1)}…` : body;
};

/**
 * Build a GitHub search client with an on-disk note cache.
 * @param options.dir - cache directory (`<evolve>/research`).
 * @param options.fetchImpl - injectable fetch, so tests never touch the network.
 * @param options.token - optional GitHub token, raises the rate limit.
 * @param options.timeoutMs - per-request timeout.
 */
export function createResearch(options = {}) {
  const dir = options.dir;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const token = String(options.token ?? "").trim();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15000);

  const ensure = () => {
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  };

  async function search(query, { limit = 5, sort = "stars", signal } = {}) {
    if (typeof fetchImpl !== "function") return { ok: false, query, items: [], error: "no-fetch" };
    const url = `${API}?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=${Math.min(10, limit)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("point: research timeout")), timeoutMs);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    try {
      const headers = { accept: "application/vnd.github+json", "user-agent": "point-evolve" };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) return { ok: false, query, items: [], error: `HTTP ${response.status}` };
      const body = await response.json();
      const items = (body?.items ?? []).slice(0, limit).map((item) => ({
        name: String(item.full_name ?? ""),
        url: String(item.html_url ?? ""),
        stars: Number(item.stargazers_count ?? 0),
        description: clip(item.description ?? "", 200),
        topics: Array.isArray(item.topics) ? item.topics.slice(0, 6) : [],
        updated: String(item.updated_at ?? "").slice(0, 10),
      }));
      return { ok: true, query, items };
    } catch (error) {
      return { ok: false, query, items: [], error: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
  }

  function writeNote(topic, results) {
    if (!dir) return null;
    ensure();
    const at = new Date().toISOString();
    const lines = [`# ${topic}`, "", `- searched: ${at}`, ""];
    for (const result of results) {
      lines.push(`## ${result.query}`);
      if (!result.ok) lines.push(`- failed: ${result.error}`);
      for (const item of result.items) {
        lines.push(`- **${item.name}** ★${item.stars} — ${item.description}`);
        lines.push(`  - ${item.url}${item.topics.length ? ` · ${item.topics.join(", ")}` : ""}`);
      }
      lines.push("");
    }
    const file = join(dir, `${slug(topic)}.md`);
    writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }

  /** Search several queries, cache one note, return the merged brief. */
  async function brief(topic, queries, { limit = 5, signal } = {}) {
    const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean).slice(0, 4);
    const results = [];
    for (const query of list) {
      if (signal?.aborted) break;
      results.push(await search(query, { limit, signal }));
    }
    if (signal?.aborted) return { ok: false, topic, items: [], queries: list, error: "stopped" };
    const items = results.flatMap((result) => result.items);
    const file = writeNote(topic, results);
    return { ok: items.length > 0, topic, file, items, results };
  }

  /** Compact text for a proposer prompt. */
  function render(briefing, max = 12) {
    if (!briefing?.items?.length) return "";
    return briefing.items
      .slice(0, max)
      .map((item) => `- ${item.name} ★${item.stars}: ${item.description} (${item.url})`)
      .join("\n");
  }

  /** Read back the most recent cached notes. */
  function notes(limit = NOTE_LIMIT) {
    if (!dir || !existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        const file = join(dir, name);
        // A note can vanish between readdir and stat/read; a missing row beats
        // an ENOENT that aborts the whole round.
        try {
          return { name, file, mtime: statSync(file).mtimeMs, text: clip(readFileSync(file, "utf8"), 4000) };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.mtime - right.mtime)
      .slice(-limit);
  }

  return { search, brief, render, notes, dir };
}
