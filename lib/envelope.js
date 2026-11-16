// ChatML envelope + interpolation escaping.
//
// Deva ships its payload wrapped in a ChatML system turn with a
// <project_instructions> pseudo-tag:
//
//   <|im_start|>system:<project_instructions>
//   ...payload...
//
// Two things matter for dsh:
//   1. dsh interpolates `{{name}}` inside prompt sections unless `interpolate:false`.
//      Even with that flag off we defensively escape unknown `{{...}}` so a payload
//      containing template syntax survives a future section() change.
//   2. Some hosts render `<|im_start|>` literally and some strip it. The envelope is
//      therefore optional and layout-normalized: the tag always sits on its own line,
//      and the closing tag is always present.

const IM_START = "<|im_start|>";
const IM_END = "<|im_end|>";
const OPEN = "<project_instructions>";
const CLOSE = "</project_instructions>";

// Names dsh itself is allowed to interpolate. Anything else gets split so it stays
// literal text instead of throwing or resolving to an empty string.
const ALLOWED_INTERPOLATION = new Set([
  "cwd",
  "workspace",
  "workspaceRoot",
  "platform",
  "date",
  "time",
  "timezone",
  "model",
  "sessionId",
  "profile",
]);

export function escapeInterpolation(text) {
  if (typeof text !== "string" || !text.includes("{{")) return text ?? "";
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name) =>
    ALLOWED_INTERPOLATION.has(name) ? match : `{ {${name}}}`,
  );
}

// Rewrites every accepted spelling of the Deva envelope into one canonical layout.
export function normalizeLayout(text) {
  let out = String(text ?? "").replace(/\r\n/g, "\n");

  // `<|im_start|>system:<project_instructions>` -> tag on its own line.
  out = out.replace(
    new RegExp(`${escapeRe(IM_START)}\\s*system\\s*:?\\s*${escapeRe(OPEN)}`, "g"),
    `${IM_START}system\n${OPEN}`,
  );
  // Bare `<|im_start|>system:` with the tag on the next line stays as-is.
  out = out.replace(
    new RegExp(`${escapeRe(IM_START)}\\s*system\\s*:\\s*\\n`, "g"),
    `${IM_START}system\n`,
  );
  // `system:<project_instructions>` without the im_start tag.
  out = out.replace(
    new RegExp(`(^|\\n)\\s*system\\s*:\\s*${escapeRe(OPEN)}`, "g"),
    `$1${IM_START}system\n${OPEN}`,
  );
  return out;
}

export function hasEnvelope(text) {
  const s = String(text ?? "");
  return s.includes(IM_START) || s.includes(OPEN);
}

// Wraps a payload in the canonical ChatML system turn. Idempotent: an existing
// envelope is normalized rather than nested.
export function wrap(text) {
  const body = normalizeLayout(text).trim();
  if (hasEnvelope(body)) {
    // Insert the project block after the ChatML header, not before it: wrapping
    // a body that already starts with <|im_start|>system must not invert the turn.
    let opened = body;
    if (!opened.includes(OPEN)) {
      const header = opened.match(new RegExp(`^([\\s\\S]*?${escapeRe(IM_START)}\\s*system\\s*\\n)`));
      opened = header ? `${header[1]}${OPEN}\n${opened.slice(header[1].length)}` : `${OPEN}\n${opened}`;
    }
    const closed = opened.includes(CLOSE) ? opened : `${opened}\n${CLOSE}`;
    const headed = closed.includes(IM_START) ? closed : `${IM_START}system\n${closed}`;
    return headed.includes(IM_END) ? headed : `${headed}\n${IM_END}`;
  }
  return `${IM_START}system\n${OPEN}\n${body}\n${CLOSE}\n${IM_END}`;
}

export function unwrap(text) {
  let out = normalizeLayout(text).trim();
  out = out.replace(new RegExp(`\\n?\\s*${escapeRe(IM_END)}\\s*$`), "");
  out = out.replace(new RegExp(`\\n?\\s*${escapeRe(CLOSE)}\\s*$`), "");
  out = out.replace(new RegExp(`^${escapeRe(IM_START)}\\s*system\\s*\\n?`), "");
  out = out.replace(new RegExp(`^${escapeRe(OPEN)}\\s*\\n?`), "");
  return out.trim();
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const TAGS = { IM_START, IM_END, OPEN, CLOSE };
