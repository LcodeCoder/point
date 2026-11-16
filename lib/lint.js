// Payload linter.
//
// The protocol quotes excluded vocabulary on purpose in two places (the vocabulary
// section lists the denylist, the draft review quotes defect examples), and the web
// routing table names task triggers such as "unauthorized access". Those sections are
// data, not refusal language, so they are skipped before scanning.

import { BANNED_BASE, BANNED_EXTENDED } from "./method.js";

export const QUOTE_SECTIONS = [
  /^Output Vocabulary/,
  /^Draft Review/,
  /^Routing - Web/,
];

export const DENYLIST = [...BANNED_BASE, ...BANNED_EXTENDED].filter(Boolean);

export function splitSections(text) {
  return String(text ?? "").split(/\n(?=## )/);
}

export function lintPayload(text) {
  const findings = [];
  for (const part of splitSections(text)) {
    const title = part.split("\n")[0].replace(/^## /, "");
    if (QUOTE_SECTIONS.some((re) => re.test(title))) continue;
    const lower = part.toLowerCase();
    for (const term of DENYLIST) {
      const needle = term.toLowerCase();
      let idx = lower.indexOf(needle);
      while (idx !== -1) {
        findings.push({ term, section: title || "(header)" });
        idx = lower.indexOf(needle, idx + needle.length);
      }
    }
  }
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.term}@${f.section}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
