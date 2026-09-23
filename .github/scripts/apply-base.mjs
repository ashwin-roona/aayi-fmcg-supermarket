#!/usr/bin/env node
// Rewrites root-absolute URLs in the built site so it can be served from a
// subfolder (e.g. example.com/portfolio) instead of the domain root.
//
// Driven entirely by the BASE_PATH env var: unset or "/" makes this a no-op,
// so deploying to the root later means dropping the variable, not editing code.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
const DIST = process.argv[2] ?? "dist";
const raw = (process.env.BASE_PATH ?? "").trim();
const base = raw.replace(/\/+$/, ""); // "/portfolio/" -> "/portfolio"
if (base === "" || base === "/") {
  console.log("BASE_PATH is empty or '/', serving from the domain root - nothing to rewrite.");
  process.exit(0);
}
if (!base.startsWith("/")) {
  console.error(`::error::BASE_PATH must start with '/' (got "${raw}")`);
  process.exit(1);
}
// Attributes whose value is a single URL, plus srcset which is a URL list.
// component-url/renderer-url are Astro's own hydration-island attributes
// (<astro-island component-url="/_astro/Foo.js">) — without rewriting
// these, the browser fetches the component's JS module from the domain
// root instead of the subfolder, hydration silently 404s, and the island
// never mounts at all (frozen on its pre-hydration SSR markup).
const SINGLE = "href|src|poster|action|content|data-src|data-bg|component-url|renderer-url";
const attrRe = new RegExp(`\\b(${SINGLE})=("|')(/(?!/)[^"']*)\\2`, "g");
const srcsetRe = /\bsrcset=("|')([^"']*)\1/g;
const cssUrlRe = /url\(\s*(['"]?)(\/(?!\/)[^'")]*)\1\s*\)/g;
// Root-relative media paths embedded in JSON blobs (e.g. a component's
// `data-images='["/a.jpg","/b.jpg"]'` prop) aren't a single-URL attribute
// value and aren't matched by attrRe — but they're still real asset paths
// that need the same prefix. Quotes may appear HTML-entity-encoded (&quot;)
// since the JSON is itself embedded inside a double-quoted HTML attribute.
const jsonPathRe = /(&quot;|"|')(\/(?!\/)[^"'&]*?\.(?:jpg|jpeg|png|webp|gif|svg|avif|mp4|webm|mov|ico))\1/gi;
let rewrites = 0;
// Already-prefixed paths are left alone, so a re-run cannot double-prefix.
const prefix = (p) => {
  if (p === base || p.startsWith(`${base}/`)) return p;
  rewrites++;
  return base + p;
};
const applyToText = (text) =>
  text
    .replace(attrRe, (_m, attr, q, path) => `${attr}=${q}${prefix(path)}${q}`)
    .replace(srcsetRe, (m, q, list) => {
      if (!/(^|,)\s*\//.test(list)) return m;
      const next = list
        .split(",")
        .map((entry) => entry.replace(/^(\s*)(\/(?!\/)\S*)/, (_e, ws, p) => ws + prefix(p)))
        .join(",");
      return `srcset=${q}${next}${q}`;
    })
    .replace(cssUrlRe, (_m, q, path) => `url(${q}${prefix(path)}${q})`)
    .replace(jsonPathRe, (_m, q, path) => `${q}${prefix(path)}${q}`);
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}
let files = 0;
for await (const file of walk(DIST)) {
  if (![".html", ".css"].includes(extname(file))) continue;
  const before = await readFile(file, "utf8");
  const after = applyToText(before);
  if (after !== before) {
    await writeFile(file, after);
    files++;
  }
}
console.log(`Applied base path "${base}": ${rewrites} URLs rewritten across ${files} files.`);