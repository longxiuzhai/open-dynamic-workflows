#!/usr/bin/env node
/**
 * Embed the dashboard HTML into a TypeScript string constant.
 *
 * The SEA binary has no files on disk and the npm package ships only `dist/`, so
 * the dashboard cannot be `readFileSync`'d at runtime. Instead we inline it as a
 * plain string in `src/dashboard.generated.ts`: `tsc` emits it into `dist/`, and
 * esbuild bundles it straight into the single-file binary. JSON.stringify gives
 * a normal double-quoted literal, so the HTML's own backticks/`${}` are inert.
 *
 * Run by `npm run build` (before tsc). Commit the generated file so `npm test`
 * (tsx, no build step) and a plain `dist/` build both work without re-running.
 *
 * Usage: node scripts/embed-dashboard.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = `${root}src/dashboard.html`;
const out = `${root}src/dashboard.generated.ts`;

const html = readFileSync(src, "utf8");
const banner =
  "/**\n" +
  " * GENERATED FILE — do not edit by hand.\n" +
  " * Source: src/dashboard.html · regenerate: node scripts/embed-dashboard.mjs\n" +
  " */\n\n";

writeFileSync(out, `${banner}export const DASHBOARD_HTML = ${JSON.stringify(html)};\n`, "utf8");
console.error(`embedded ${html.length} bytes of dashboard HTML → src/dashboard.generated.ts`);
