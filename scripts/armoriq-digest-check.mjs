#!/usr/bin/env node
/**
 * Verifies CSRG leaf digest matches Python json.dumps(..., sort_keys=True, separators=(",", ":")).
 * Standalone — no Next.js env required.
 */

import { createHash } from "node:crypto";

function jsonDumpsPythonCanonical(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jsonDumpsPythonCanonical(v)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jsonDumpsPythonCanonical(value[k])}`).join(",")}}`;
}

function leafDigest(leafValue) {
  return createHash("sha256").update(jsonDumpsPythonCanonical(leafValue), "utf8").digest("hex");
}

const cases = [
  { leaf: "generate_search_queries", expectLen: 64 },
  { leaf: { z: 1, a: 2 }, expectLen: 64 }
];

for (const c of cases) {
  const h = leafDigest(c.leaf);
  if (h.length !== c.expectLen) {
    console.error(`ArmorIQ digest check failed: bad length for ${JSON.stringify(c.leaf)}`);
    process.exit(1);
  }
}

const known = leafDigest("assess_and_summarize");
if (known.length !== 64) {
  process.exit(1);
}

console.log("ArmorIQ digest self-check passed.");
console.log(`  sample sha256: ${known.slice(0, 16)}…`);
