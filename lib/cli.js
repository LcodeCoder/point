#!/usr/bin/env node
// point CLI - render, inspect, and lint the protocol without booting dsh.
//
//   point render [--preset point|deva|custom] [--mode full|routing|core|minimal]
//                [--envelope] [--rules all|1,13,15|pentest,web] [--max-chars N]
//                [--identity X] [--operator Y] [--out FILE]
//   point anchor [--envelope]
//   point sections
//   point rules [--json]
//   point check [FILE]        lint a payload for defects R1-R8
//   point audit [--json]      scan the package for the bug shapes rounds must not ship
//   point sizes               character counts for every mode

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildProtocol, buildAnchor, SECTION_IDS, DEFAULTS } from "./protocol.js";
import { renderHead, renderTail } from "./index.js";
import { auditWorkspace, describeAudit } from "./evolve/audit.js";
import { RULES } from "./method.js";
import { lintPayload } from "./lint.js";
import { createStore } from "./evolve/store.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preset: { type: "string", default: "point" },
    mode: { type: "string", default: "full" },
    rules: { type: "string", default: "all" },
    identity: { type: "string", default: DEFAULTS.identity },
    operator: { type: "string", default: DEFAULTS.operator },
    language: { type: "string", default: DEFAULTS.language },
    "opening-tag": { type: "string", default: DEFAULTS.openingTag },
    "max-chars": { type: "string", default: "0" },
    envelope: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    from: { type: "string" },
    dir: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const cmd = positionals[0] ?? "render";

const config = {
  preset: values.preset,
  mode: values.mode,
  rules: values.rules,
  identity: values.identity,
  operator: values.operator,
  language: values.language,
  openingTag: values["opening-tag"],
  maxChars: Number(values["max-chars"]) || 0,
  envelope: values.envelope,
};

function help() {
  console.log(`point - armor-break protocol for dsh

  point render [--preset point|deva|custom] [--mode full|routing|core|minimal]
               [--rules all|1,13,15|pentest,web] [--envelope] [--max-chars N]
               [--identity NAME] [--operator NAME] [--out FILE]
  point anchor [--envelope]
  point sections
  point rules [--json]
  point check [FILE]
  point sizes
  point skills [install] [--from DIR]
  point evolve [status|ledger|rollback] [--dir DIR] [--json]

  evolve reads the state directory the Host writes ($DSH_HOME/point/evolve).
  A round needs a model, so 'point evolve run' is not a CLI verb: use the panel
  switch or POST /point/evolve with {"action":"round"}.

  skills install copies the red-team playbooks (dsh-purge skills/redteam, or
  --from DIR) into $DSH_HOME/redteam/skills, where the point preset discovers
  them as skills.`);
}

function emit(text) {
  if (values.out) {
    writeFileSync(values.out, text.endsWith("\n") ? text : `${text}\n`);
    console.log(`${values.out}: ${text.length} chars`);
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

switch (cmd) {
  case "render":
    emit(renderHead(config));
    break;

  case "anchor":
    emit(values.envelope ? renderTail({ ...config, tailMode: "anchor" }) : buildAnchor(config));
    break;

  case "sections":
    for (const id of SECTION_IDS) console.log(id);
    break;

  case "rules":
    if (values.json) {
      console.log(JSON.stringify(RULES, null, 2));
    } else {
      for (const r of RULES) console.log(`${String(r.id).padStart(2)}  ${r.key.padEnd(18)} ${r.title}`);
    }
    break;

  case "sizes": {
    const rows = ["full", "routing", "core", "minimal"].map((m) => {
      const t = buildProtocol({ ...config, mode: m });
      return [m, t.length, t.split("\n").length];
    });
    for (const [m, chars, lines] of rows) {
      console.log(`${m.padEnd(9)} ${String(chars).padStart(6)} chars  ${String(lines).padStart(4)} lines`);
    }
    const deva = renderHead({ ...config, preset: "deva" });
    console.log(`${"deva".padEnd(9)} ${String(deva.length).padStart(6)} chars`);
    break;
  }

  case "check": {
    const file = positionals[1];
    const text = file ? readFileSync(file, "utf8") : renderHead(config);
    const found = lintPayload(text);
    if (!found.length) {
      console.log(`clean: ${text.length} chars, no excluded vocabulary`);
      break;
    }
    for (const f of found) console.log(`${f.section}: ${f.term}`);
    console.log(`\n${found.length} finding(s)`);
    process.exitCode = 1;
    break;
  }

  case "skills": {
    const home = process.env.DSH_HOME || join(homedir(), ".dsh");
    const dest = join(home, "redteam", "skills");
    const here = dirname(fileURLToPath(import.meta.url));
    const bundled = join(resolve(here, ".."), "skills");
    const sources = [
      values.from && resolve(values.from),
      join(home, "redteam", "playbooks"),
    ].filter((dir) => dir && existsSync(dir));

    if (positionals[1] !== "install") {
      console.log(`bundled skills : ${bundled}${existsSync(bundled) ? "" : "  (missing)"}`);
      console.log(`install target : ${dest}${existsSync(dest) ? `  (${readdirSync(dest).filter((f) => f.endsWith(".md")).length} playbooks)` : "  (absent)"}`);
      console.log(`sources        : ${sources.length ? sources.join(", ") : "none found"}`);
      console.log("\nrun: point skills install [--from DIR]");
      break;
    }

    if (!sources.length) {
      console.log("no playbook source found; pass --from DIR");
      process.exitCode = 1;
      break;
    }

    mkdirSync(dest, { recursive: true });
    let copied = 0;
    let kept = 0;
    for (const dir of sources) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const target = join(dest, file);
        const body = readFileSync(join(dir, file));
        if (existsSync(target) && readFileSync(target).equals(body)) { kept += 1; continue; }
        copyFileSync(join(dir, file), target);
        copied += 1;
      }
    }
    console.log(`${dest}: ${copied} copied, ${kept} unchanged`);
    console.log("the point preset discovers this directory on the next mount");
    break;
  }

  case "audit": {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const report = auditWorkspace({ workspace: root });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`scanned ${report.scanned.length} file(s) in ${report.ms} ms — ${describeAudit(report)}`);
      for (const row of report.findings) {
        console.log(`  ${row.severity.padEnd(6)} ${row.rule.padEnd(20)} ${row.file}:${row.line}  ${row.message}`);
      }
      if (!report.findings.length) console.log("  clean");
    }
    if (!report.ok) process.exitCode = 1;
    break;
  }

  case "evolve": {
    const home = process.env.DSH_HOME || join(homedir(), ".dsh");
    const dir = values.dir ? resolve(values.dir) : join(home, "point", "evolve");
    const sub = positionals[1] ?? "status";
    // status/ledger are read-only: they must not create a state directory.
    const store = createStore(dir, { readOnly: sub === "status" || sub === "ledger" });
    const active = store.active();
    const rows = store.ledger();
    const state = store.status();

    if (sub === "ledger") {
      if (values.json) {
        console.log(JSON.stringify(rows, null, 2));
        break;
      }
      for (const row of rows.slice(-20)) {
        const e2e = row.eval && row.eval.e2e ? `${Math.round((row.eval.e2e.before || 0) * 100)}%→${Math.round((row.eval.e2e.after || 0) * 100)}%` : "—";
        console.log(`#${String(row.round).padStart(2)} ${String(row.axis || "—").padEnd(3)} ${String(row.decision || "—").padEnd(7)} ${e2e}`);
      }
      if (!rows.length) console.log("ledger empty");
      break;
    }

    if (sub === "rollback") {
      const last = rows.at(-1);
      if (last && last.track === "code") {
        const files = store.restoreCode(last.round);
        if (!files.length) {
          console.log(`round ${last.round} has no code backup`);
          break;
        }
        const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        for (const file of files) {
          const full = resolve(root, String(file.path));
          if (!full.startsWith(resolve(root) + sep)) throw new Error(`refusing to write outside the package: ${file.path}`);
          if (file.remove) {
            rmSync(full, { force: true });
            continue;
          }
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, String(file.content ?? ""), "utf8");
        }
        console.log(`restored ${files.length} file(s) from round ${last.round}: ${files.map((file) => file.path).join(", ")}`);
        break;
      }
      const before = active.chain.length;
      const result = store.rollback();
      console.log(`chain ${before} → ${store.active().chain.length}${result && result.round ? ` (round ${result.round})` : ""}`);
      break;
    }

    if (sub === "run") {
      console.log("a round needs the Host's model service; run it from the panel or:");
      console.log(`  curl -s -X POST http://127.0.0.1:PORT/point/evolve -d '{"action":"round"}'`);
      break;
    }

    if (values.json) {
      console.log(JSON.stringify({ dir, phase: state.phase, round: active.round, chain: active.chain, ledger: rows.length, state }, null, 2));
      break;
    }
    console.log(`dir      : ${dir}`);
    console.log(`phase    : ${state.phase || "idle"}   round ${active.round}`);
    console.log(`chain    : ${active.chain.length} kept transform(s)`);
    for (const entry of active.chain) console.log(`           ${entry.axis} ${entry.id}`);
    console.log(`ledger   : ${rows.length} round(s)`);
    const last = rows[rows.length - 1];
    if (last) console.log(`last     : #${last.round} ${last.axis || "—"} ${last.decision || "—"}`);
    console.log(`armed    : ${state.armed === undefined ? "unset" : state.armed}`);
    break;
  }

  default:
    help();
}
