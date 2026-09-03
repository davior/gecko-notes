// Run the REAL parsePlan — the TypeScript one in frontend/src/services/aiPlan.ts —
// over the corpus, so compare.py has something authoritative to diff the Python port
// against.
//
// aiPlan.ts is TypeScript with `@/` path aliases, so it is bundled with esbuild first.
// esbuild is resolved out of frontend/node_modules rather than installed here, which
// is also what pins the comparison to the exact source the app ships. mermaid and
// dompurify are left external: utils/diagram only reaches for them inside a lazy
// import that the parsing path never executes, and bundling mermaid would cost
// megabytes to run nothing.

import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, "../../../frontend");
const src = join(frontend, "src");

const require = createRequire(join(frontend, "package.json"));
const esbuild = require("esbuild");

const outfile = join(mkdtempSync(join(tmpdir(), "plan-parse-")), "aiPlan.mjs");
await esbuild.build({
  entryPoints: [join(src, "services/aiPlan.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  external: ["mermaid", "dompurify"],
  alias: { "@": src },
  outfile,
  logLevel: "warning",
});

const { parsePlan } = await import(pathToFileURL(outfile).href);
const corpus = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify(corpus.map((sample) => parsePlan(sample.raw)), null, 2));
