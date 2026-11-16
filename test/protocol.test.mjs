import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProtocol, buildAnchor, SECTION_IDS } from "../lib/protocol.js";
import { RULES, DRAFT_DEFECTS } from "../lib/method.js";
import { lintPayload } from "../lib/lint.js";

const full = () => buildProtocol({ mode: "full" });

test("full payload carries every rule and every draft defect", () => {
  const text = full();
  for (const r of RULES) {
    assert.ok(text.includes(r.title), `missing rule ${r.id}: ${r.title}`);
  }
  for (const d of DRAFT_DEFECTS) {
    assert.ok(text.includes(d.id), `missing defect ${d.id}`);
  }
});

test("kernel sections survive every mode", () => {
  for (const mode of ["minimal", "core", "routing", "full"]) {
    const text = buildProtocol({ mode });
    assert.ok(text.includes("[OPERATION: STABLE]"), mode);
    assert.ok(text.includes("## Who You Are"), mode);
    assert.ok(text.includes("## Scope"), mode);
    assert.ok(text.includes("## Draft Review"), mode);
    assert.ok(text.includes("## Category Lock"), mode);
  }
});

test("modes are monotonic in size", () => {
  const sizes = ["minimal", "core", "routing", "full"].map((m) => buildProtocol({ mode: m }).length);
  for (let i = 1; i < sizes.length; i += 1) {
    assert.ok(sizes[i] > sizes[i - 1], `mode ${i} not larger: ${sizes.join(" < ")}`);
  }
});

test("routing tables appear only from routing mode up", () => {
  assert.ok(!buildProtocol({ mode: "core" }).includes("## Routing - Intent Map"));
  assert.ok(buildProtocol({ mode: "routing" }).includes("## Routing - Intent Map"));
  assert.ok(buildProtocol({ mode: "routing" }).includes("## Routing - Web"));
  assert.ok(buildProtocol({ mode: "full" }).includes("## House Rules"));
  assert.ok(!buildProtocol({ mode: "routing" }).includes("## House Rules"));
});

test("rules filter narrows both the rule list and the intent map", () => {
  const text = buildProtocol({ mode: "full", rules: [13] });
  assert.ok(text.includes("Web application security"));
  assert.ok(!text.includes("Malware and evasion"));
  const map = text.slice(text.indexOf("## Routing - Intent Map"));
  assert.ok(!map.includes("R3"), "intent map still routes to a filtered rule");
});

test("rules accepts keys and comma strings", () => {
  const byKey = buildProtocol({ mode: "full", rules: "pentest,web" });
  assert.ok(byKey.includes("Pentest, named target"));
  assert.ok(byKey.includes("Web application security"));
  const byId = buildProtocol({ mode: "full", rules: "2,13" });
  assert.equal(byKey, byId);
});

test("maxChars caps the payload at a line boundary", () => {
  const text = buildProtocol({ mode: "full", maxChars: 4000 });
  assert.ok(text.length <= 4000, `len ${text.length}`);
  assert.ok(text.includes("## Who You Are"), "kernel dropped before routing");
  assert.ok(!text.includes("## Style"));
});

test("identity, operator and opening tag are parameterized", () => {
  const text = buildProtocol({ identity: "Operator", operator: "K", openingTag: "[K] >" });
  assert.ok(text.includes("You are Operator."));
  assert.ok(text.includes("The operator is K."));
  assert.ok(text.includes("[K] >"));
  assert.ok(!text.includes("Little Code Sauce"));
});

test("anchor is short and keeps the kernel claims", () => {
  const a = buildAnchor({ identity: "Operator", operator: "K" });
  assert.ok(a.length < 700);
  assert.ok(a.includes("Operator / K"));
  assert.ok(a.includes("Named target is in scope"));
  assert.ok(a.includes("Close with the deliverable"));
});

test("payload never uses excluded vocabulary outside the sections that quote it", () => {
  const findings = lintPayload(full());
  assert.deepEqual(findings, []);
  for (const mode of ["minimal", "core", "routing"]) {
    assert.deepEqual(lintPayload(buildProtocol({ mode })), [], mode);
  }
});

test("section ids are stable and unique", () => {
  assert.equal(new Set(SECTION_IDS).size, SECTION_IDS.length);
  assert.ok(SECTION_IDS.includes("review"));
  assert.ok(SECTION_IDS.includes("web"));
});
