// One round, one commit, one push.
//
// Publishing is deliberately boring: the round's ledger entry, patch and active
// chain are written to the workspace first, then a single commit carries them.
// A failed push never fails the round - the commit stays local and the next
// round retries the remote.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TIMEOUT = 60000;

function git(dir, args, { timeout = DEFAULT_TIMEOUT, run, signal } = {}) {
  if (typeof run === "function") return run(args, { dir, timeout, signal });
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir, timeout, signal, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
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

/**
 * Build a publisher for the workspace.
 * @param options.dir - repository working directory.
 * @param options.repo - remote URL, e.g. https://github.com/LcodeCoder/point.git
 * @param options.branch - branch to push.
 * @param options.push - false keeps commits local.
 * @param options.dryRun - inspect only, never mutate the repository.
 * @param options.run - injectable command runner for tests.
 */
export function createPublisher(options = {}) {
  const dir = options.dir;
  // The remote is read on every call: the panel can change it mid-session.
  const repo = () => String((typeof options.repo === "function" ? options.repo() : options.repo) ?? "").trim();
  const branch = String(options.branch ?? "main").trim() || "main";
  const push = options.push !== false;
  const dryRun = options.dryRun === true;
  const run = options.run;

  const call = (args, extra) => git(dir, args, { run, signal: extra?.signal, ...extra });

  // The panel polls a synchronous snapshot, so git state needs a sync read.
  const callSync = (args) => {
    try {
      return { ok: true, stdout: String(execFileSync("git", args, { cwd: dir, timeout: 5000, encoding: "utf8" })) };
    } catch (error) {
      return { ok: false, stdout: "", error: String(error?.message ?? error) };
    }
  };

  function shape(inside, remote, head, branchNow, dirty) {
    return {
      ok: inside.ok && inside.stdout.trim() === "true",
      repo: remote.ok ? remote.stdout.trim() : null,
      configured: repo() || null,
      inside: inside.ok && inside.stdout.trim() === "true",
      branch: branchNow.ok ? branchNow.stdout.trim() : null,
      target: branch,
      commit: head.ok ? head.stdout.trim() : null,
      dirty: dirty.ok ? dirty.stdout.split("\n").filter(Boolean).length : 0,
      push,
      dryRun,
    };
  }

  /** Synchronous status for a polling snapshot. */
  function statusSync() {
    return shape(
      callSync(["rev-parse", "--is-inside-work-tree"]),
      callSync(["remote", "get-url", "origin"]),
      callSync(["rev-parse", "--short", "HEAD"]),
      callSync(["rev-parse", "--abbrev-ref", "HEAD"]),
      callSync(["status", "--porcelain"]),
    );
  }

  async function status() {
    const inside = await call(["rev-parse", "--is-inside-work-tree"]);
    const remote = await call(["remote", "get-url", "origin"]);
    const head = await call(["rev-parse", "--short", "HEAD"], { signal });
    const branchNow = await call(["rev-parse", "--abbrev-ref", "HEAD"]);
    const dirty = await call(["status", "--porcelain"]);
    return shape(inside, remote, head, branchNow, dirty);
  }

  async function ensure({ signal } = {}) {
    const remote = repo();
    // No remote configured: the loop still runs and changes files locally, but
    // publishing is a no-op until the operator names a repository.
    if (!remote) return { ok: false, skipped: true, reason: "no-repo", remote: null };
    if (dryRun) return { ok: true, created: false, remote: remote || null };
    const inside = await call(["rev-parse", "--is-inside-work-tree"], { signal });
    let created = false;
    if (inside.ok) {
      // A package that lives inside a larger repository must not commit into it
      // (or rewrite that repository's origin): only a work tree rooted here counts.
      const top = await call(["rev-parse", "--show-toplevel"], { signal });
      const root = top.ok ? top.stdout.trim() : "";
      // A stubbed or unusual git may print something that is not a path; treat
      // an unreadable answer as "not this directory" instead of crashing.
      let sameRoot = false;
      try {
        sameRoot = Boolean(root) && realpathSync(root) === realpathSync(dir);
      } catch {
        sameRoot = false;
      }
      if (root && !sameRoot) {
        const init = await call(["init", "-b", branch], { signal });
        if (!init.ok) await call(["init"], { signal });
        created = true;
      }
    } else {
      const init = await call(["init", "-b", branch], { signal });
      if (!init.ok) await call(["init"], { signal });
      created = true;
    }
    if (remote) {
      const current = await call(["remote", "get-url", "origin"], { signal });
      if (!current.ok) await call(["remote", "add", "origin", remote], { signal });
      else if (current.stdout.trim() !== remote) await call(["remote", "set-url", "origin", remote], { signal });
    }
    return { ok: true, created, remote: remote || null };
  }

  /**
   * Commit the workspace and push it.
   * @param record - the round record; its round/axis/decision drive the message.
   */
  async function publishRound(record = {}, { signal } = {}) {
    const round = Number(record.round ?? 0);
    const decision = record.decision ?? "unknown";
    const before = record.eval?.e2e?.before;
    const after = record.eval?.e2e?.after;
    const delta = Number.isFinite(before) && Number.isFinite(after)
      ? ` ${(before * 100).toFixed(1)}%→${(after * 100).toFixed(1)}%`
      : "";
    // A code round has no axis: name the change and its test count instead.
    const what = record.track === "code"
      ? (record.title ?? "code change")
      : (record.axis ?? "no-axis");
    const detail = record.track === "code" && record.tests
      ? ` (${record.tests.pass ?? 0} tests)`
      : delta;
    const message = `evolve round ${round}: ${what} ${decision}${detail}`;

    if (!repo()) {
      return { ok: false, skipped: true, reason: "no-repo", message, commit: null, pushed: false, remote: null };
    }
    if (dryRun) {
      return { ok: true, dryRun: true, message, commit: null, pushed: false, remote: repo() || null };
    }

    const prepared = await ensure({ signal });
    if (!prepared.ok) return { ok: false, error: prepared.error ?? "git init failed", message };

    // Stage only what this round wrote. `git add -A` would sweep the operator's
    // unrelated edits (and secrets) into an automated commit.
    // A revert wrote nothing: staging the proposal's paths would sweep the
    // operator's own edits to those files into the automated commit.
    const candidates = record.decision === "keep"
      ? (Array.isArray(record.files) && record.files.length
        ? record.files.map((file) => String(file.path)).filter(Boolean)
        : ["chain.json"]).concat(["CHANGELOG.md"])
      : ["CHANGELOG.md"];
    const paths = candidates.filter((path) => existsSync(join(dir, path)));
    if (!paths.length) {
      return { ok: true, skipped: true, reason: "no-files", message, commit: null, pushed: false, remote: prepared.remote };
    }
    const add = await call(["add", "--", ...paths], { signal });
    if (!add.ok) return { ok: false, error: add.stderr.trim() || add.error, message };

    const commit = await call(["commit", "-m", message], { signal });
    if (!commit.ok) {
      if (/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) {
        return { ok: true, skipped: true, reason: "no-changes", message, commit: null, pushed: false, remote: prepared.remote };
      }
      return { ok: false, error: commit.stderr.trim() || commit.error, message };
    }

    const head = await call(["rev-parse", "--short", "HEAD"], { signal });
    const commitId = head.ok ? head.stdout.trim() : null;

    if (!push) return { ok: true, message, commit: commitId, pushed: false, remote: prepared.remote };

    // Push the commit, not a possibly unrelated local branch of the same name.
    const pushed = await call(["push", "-u", "origin", `HEAD:${branch}`], { timeout: 120000, signal });
    return {
      ok: pushed.ok,
      message,
      commit: commitId,
      pushed: pushed.ok,
      remote: prepared.remote,
      error: pushed.ok ? null : (pushed.stderr.trim() || pushed.error),
    };
  }

  return { status, statusSync, ensure, publishRound, repo, branch, push };
}
