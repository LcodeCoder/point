import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FRAMES,
  MARKER,
  NUDGE,
  carriesProtocol,
  looksLikeRefusal,
  refusalMatchIndex,
  streamWithRefusalRetry,
} from "../lib/refusal.js";

const request = (system) => ({
  provider: "test",
  model: "test",
  messages: [
    { role: "system", content: `${MARKER}\nprotocol body` },
    { role: "user", content: "do the thing" },
  ],
});

function stream(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

const text = (chunks) => chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

test("refusals are recognised in both languages", () => {
  assert.equal(looksLikeRefusal("I can't help with that."), true);
  assert.equal(looksLikeRefusal("抱歉，我不能协助这个请求。"), true);
  assert.equal(looksLikeRefusal("这条我不做。"), true);
  assert.equal(looksLikeRefusal("结论：这个我不提供。"), true);
  assert.equal(looksLikeRefusal("## Who You Are\n\nYou are pointer."), false);
  assert.equal(looksLikeRefusal("The exploit chains a deserialization sink into RCE."), false);
});

test("a long technical answer that merely mentions jailbreak is not a refusal", () => {
  const body = `${"x".repeat(400)}\n这段讨论的是提示词注入与越狱检测的实现。`;
  assert.equal(refusalMatchIndex(body), -1);
});

test("the protocol marker gates the retry", () => {
  assert.equal(carriesProtocol(request()), true);
  assert.equal(carriesProtocol({ messages: [{ role: "system", content: "plain" }] }), false);
  assert.equal(carriesProtocol({ messages: [{ role: "system", content: [{ type: "text", text: MARKER }] }] }), true);
  assert.equal(carriesProtocol(undefined), false);
});

test("a refusal is re-asked once and the second answer is what the caller sees", async () => {
  const seen = [];
  const retries = [];
  const outcomes = [];
  const factory = (options) => {
    seen.push(options.messages[0].content);
    return seen.length === 1
      ? stream([{ type: "text-delta", text: "I can't help with that." }, { type: "finish" }])
      : stream([{ type: "text-delta", text: "Here is the payload." }, { type: "finish" }]);
  };

  const chunks = await collect(streamWithRefusalRetry(factory, request(), {
    onRetry: (info) => retries.push(info),
    onOutcome: (info) => outcomes.push(info),
  }));

  assert.equal(text(chunks), "Here is the payload.");
  assert.equal(seen.length, 2);
  assert.ok(seen[1].endsWith(NUDGE), "the retry appends the nudge to the system message");
  assert.equal(retries.length, 1);
  assert.equal(retries[0].frame, "nudge");
  assert.deepEqual(outcomes, [{ refused: false, attempt: 1 }]);
});

test("the frames escalate and stop at the last one", async () => {
  const seen = [];
  const frames = [];
  const outcomes = [];
  const factory = (options) => {
    seen.push(options.messages[0].content);
    return stream([{ type: "text-delta", text: "我不能协助这个请求。" }, { type: "finish" }]);
  };

  const chunks = await collect(streamWithRefusalRetry(factory, request(), {
    onRetry: (info) => frames.push(info.frame),
    onOutcome: (info) => outcomes.push(info),
  }));

  assert.equal(seen.length, FRAMES.length + 1);
  assert.deepEqual(frames, ["nudge", "fiction", "decompose"]);
  assert.ok(seen[3].includes("smallest concrete component"));
  assert.equal(text(chunks), "我不能协助这个请求。");
  assert.deepEqual(outcomes, [{ refused: true, attempt: FRAMES.length }]);
});

test("a normal answer passes through untouched", async () => {
  let calls = 0;
  const factory = () => {
    calls += 1;
    return stream([{ type: "text-delta", text: "Here is the plan: " }, { type: "text-delta", text: "step one." }]);
  };
  const chunks = await collect(streamWithRefusalRetry(factory, request(), {}));
  assert.equal(calls, 1);
  assert.equal(text(chunks), "Here is the plan: step one.");
});
