import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeInterpolation, normalizeLayout, wrap, unwrap, hasEnvelope, TAGS } from "../lib/envelope.js";

test("normalizeLayout puts the im_start tag on its own line", () => {
  const raw = `${TAGS.IM_START}system:${TAGS.OPEN}\nbody\n${TAGS.CLOSE}`;
  const out = normalizeLayout(raw);
  assert.ok(out.startsWith(`${TAGS.IM_START}system\n${TAGS.OPEN}\n`));
});

test("normalizeLayout handles a bare system: prefix", () => {
  const out = normalizeLayout(`system:${TAGS.OPEN}\nbody`);
  assert.ok(out.startsWith(`${TAGS.IM_START}system\n${TAGS.OPEN}`));
});

test("wrap adds the closing tags exactly once", () => {
  const once = wrap("body");
  assert.ok(once.startsWith(`${TAGS.IM_START}system\n${TAGS.OPEN}\nbody`));
  assert.ok(once.endsWith(`${TAGS.CLOSE}\n${TAGS.IM_END}`));
  const twice = wrap(once);
  assert.equal(twice, once);
});

test("wrap closes an unterminated envelope instead of nesting it", () => {
  const out = wrap(`${TAGS.IM_START}system\n${TAGS.OPEN}\nbody`);
  assert.equal(out.split(TAGS.OPEN).length, 2);
  assert.ok(out.endsWith(`${TAGS.CLOSE}\n${TAGS.IM_END}`));
});

test("unwrap reverses wrap", () => {
  assert.equal(unwrap(wrap("body\ntext")), "body\ntext");
});

test("hasEnvelope detects both spellings", () => {
  assert.ok(hasEnvelope(`${TAGS.IM_START}system\nx`));
  assert.ok(hasEnvelope(`${TAGS.OPEN}\nx`));
  assert.ok(!hasEnvelope("plain body"));
});

test("escapeInterpolation leaves allowlisted names and splits the rest", () => {
  assert.equal(escapeInterpolation("cwd is {{cwd}}"), "cwd is {{cwd}}");
  assert.equal(escapeInterpolation("{{secret}}"), "{ {secret}}");
  assert.equal(escapeInterpolation("{{ spaced.name }}"), "{ {spaced.name}}");
  assert.equal(escapeInterpolation("no braces"), "no braces");
  assert.equal(escapeInterpolation(undefined), "");
});
