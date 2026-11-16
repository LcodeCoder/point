// point/section - the preset-scoped half.
//
// A bundle patch can declare an agent preset whose child rows run inside that
// preset's own Loader realm. This entry is that child: it registers the two
// prompt sections in whatever scope it is mounted in, so a session on the
// `point` preset carries the protocol and a session on any other preset does
// not. The global `point` row keeps the panel and the state route; it does not
// inject anything when `scope` is `preset` (the default).
//
// It intentionally has no Web surface: the panel belongs to the global half, and
// a preset must stay mountable in a composition with no Web carrier at all.

import { addSection, coerce, renderHead, renderTail, DEFAULTS } from "./index.js";

export const name = "point/section";
export const inject = ["systemPrompt"];

export const config = { ...DEFAULTS };

/**
 * Register the protocol into the mounting scope.
 * @param ctx - the preset-scoped Cordis context.
 * @param rawConfig - the same config shape as the global plugin.
 */
export function apply(ctx, rawConfig = {}) {
  const cfg = coerce(rawConfig);
  if (!cfg.enabled) return;

  if (cfg.position === "head" || cfg.position === "both") {
    addSection(ctx, {
      name: "point",
      order: cfg.order,
      text: renderHead(cfg),
      interpolate: false,
    });
  }

  if (cfg.position === "tail" || cfg.position === "both") {
    addSection(ctx, {
      name: "point:tail",
      order: cfg.tailOrder,
      text: renderTail(cfg),
      interpolate: false,
    });
  }
}

export default { name, inject, apply, config };
