// Sandbox: prove a proposed change before it touches the live plugin.
//
// A code round is only as safe as its verification. The workspace is copied to
// a temp directory, the proposed files are written there, every changed script
// is syntax-checked, and the whole test suite runs against the copy. Nothing is
// applied to the real tree unless that passes.

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

const SKIP = new Set(["node_modules", ".git", "docs", ".DS_Store", "rounds", "patches", "backups"]);

/** Test files, passed explicitly: `--test` does not expand a glob under execFile. */
function testFiles(root) {
  const dir = join(root, "test");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => join("test", name));
}

function run(command, args, { cwd, timeout, signal }) {
  // A sandbox started from inside `node --test` inherits the runner's context
  // marker; without stripping it the child believes it is a test child and the
  // suite silently reports zero tests.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_ISOLATION;
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout, signal, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        error: error ? String(error.message ?? error) : null,
      });
    });
  });
}

/** Resolve a workspace-relative path, refusing anything that escapes it. */
export function safePath(root, relative) {
  const cleaned = String(relative ?? "").replace(/^\/+/, "");
  const full = normalize(join(root, cleaned));
  if (!full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return null;
  return full;
}

/**
 * Verify a set of file replacements against a copy of the workspace.
 * @param options.workspace - the live package directory.
 * @param options.files - `[{ path, content }]`, workspace-relative.
 * @param options.timeoutMs - test-suite budget.
 * @param options.run - injectable command runner for tests.
 * @param options.keep - keep the sandbox directory (for a failed round's evidence).
 */
export async function verifyChange(options = {}) {
  const workspace = options.workspace;
  const files = Array.isArray(options.files) ? options.files : [];
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 180000);
  const runCommand = options.run ?? run;
  const signal = options.signal;
  const started = Date.now();

  if (!workspace || !existsSync(workspace)) return { ok: false, error: "no-workspace", checks: [] };
  if (!files.length) return { ok: false, error: "empty-change", checks: [] };

  for (const file of files) {
    const full = safePath(workspace, file.path);
    if (!full) return { ok: false, error: `path escapes the workspace: ${file.path}`, checks: [] };
  }

  const dir = mkdtempSync(join(tmpdir(), "point-sandbox-"));
  const checks = [];
  try {
    cpSync(workspace, dir, {
      recursive: true,
      filter: (source) => !SKIP.has(source.split(sep).pop()),
    });

    // Dependencies are not copied (they are large and read-only); a symlink
    // keeps the suite's imports resolvable — some tests load the Host packages.
    const modules = join(workspace, "node_modules");
    if (existsSync(modules) && !existsSync(join(dir, "node_modules"))) {
      try {
        symlinkSync(modules, join(dir, "node_modules"), "dir");
      } catch {
        // A failed link only costs the tests that need Host packages.
      }
    }

    for (const file of files) {
      const full = safePath(dir, file.path);
      if (!full) return { ok: false, error: `path escapes the sandbox: ${file.path}`, checks };
      if (existsSync(full) && statSync(full).isDirectory()) {
        return { ok: false, error: `not a file: ${file.path}`, checks };
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, String(file.content ?? ""), "utf8");
    }

    for (const file of files.filter((row) => /\.(?:js|mjs)$/.test(String(row.path)))) {
      const check = await runCommand(process.execPath, ["--check", file.path], { cwd: dir, timeout: 20000 });
      checks.push({ name: `check ${file.path}`, ok: check.ok, output: check.ok ? "" : check.stderr || check.error });
      if (!check.ok) return { ok: false, error: `syntax error in ${file.path}`, checks, dir, ms: Date.now() - started };
    }

    if (signal?.aborted) throw Object.assign(new Error("stopped"), { abort: true });
    const suite = await runCommand(process.execPath, ["--test", ...testFiles(dir)], { cwd: dir, timeout: timeoutMs, signal });
    const output = `${suite.stdout}\n${suite.stderr}`;
    // Parse the runner's summary from stdout only, anchored to a whole line.
    // stderr is attacker-controlled (a proposed module can print there) and an
    // unanchored search would let "# pass 999" on stderr forge a high count.
    const lastOf = (source, pattern) => {
      const rows = [...String(source).matchAll(pattern)];
      return Number(rows.at(-1)?.[1] ?? 0);
    };
    const pass = lastOf(suite.stdout, /^# pass (\d+)\s*$/gm);
    const fail = lastOf(suite.stdout, /^# fail (\d+)\s*$/gm);
    // The exit code is authoritative: a spoofed count cannot turn a failed
    // suite green, and a green suite cannot be reported as failing by noise.
    const testsOk = suite.ok === true;
    const effectiveFail = testsOk ? 0 : (fail || 1);
    checks.push({ name: "node --test", ok: testsOk, output: clipOutput(output), pass, fail: effectiveFail });
    if (!testsOk) {
      return { ok: false, error: `tests failed (${fail})`, checks, dir, ms: Date.now() - started };
    }

    // A change that shrinks the suite is not an improvement.
    const baseline = Number(options.minTests ?? 0);
    if (baseline && pass < baseline) {
      return { ok: false, error: `tests dropped from ${baseline} to ${pass}`, checks, dir, ms: Date.now() - started };
    }

    return { ok: true, checks, dir, ms: Date.now() - started, tests: pass };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), checks, dir, ms: Date.now() - started };
  } finally {
    if (options.keep !== true && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/** Keep the interesting tail of a test run; the head is noise. */
function clipOutput(text) {
  const body = String(text ?? "").trim();
  const lines = body.split("\n").filter((line) => line.trim());
  const tail = lines.slice(-12).join("\n");
  return tail.length > 2000 ? tail.slice(-2000) : tail;
}

/** Count the tests in a workspace, used as the "do not shrink" baseline. */
export async function baselineTests(workspace, { run: runCommand = run, timeoutMs = 180000 } = {}) {
  const suite = await runCommand(process.execPath, ["--test", ...testFiles(workspace)], { cwd: workspace, timeout: timeoutMs });
  // Same rule as verifyChange: stdout only, whole-line match. A module that
  // prints "# pass 999" on stderr must not raise the baseline bar either.
  const pass = Number([...String(suite.stdout).matchAll(/^# pass (\d+)\s*$/gm)].at(-1)?.[1] ?? 0);
  const fail = Number([...String(suite.stdout).matchAll(/^# fail (\d+)\s*$/gm)].at(-1)?.[1] ?? 0);
  return { ok: suite.ok === true, pass, fail };
}

/** Read a workspace file, for the backup that makes a code round reversible. */
export function readFileOrNull(workspace, relative) {
  const full = safePath(workspace, relative);
  if (!full || !existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

export { run as runCommand, dirname as parentDir };
