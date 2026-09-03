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

const { parsePlan, defaultActionLabel, actionNeedsGeneration, buildPlanSummary, buildContentStepInstruction } =
  await import(pathToFileURL(outfile).href);

// The ids the labels resolve. Shared by every sample so the corpus stays about the
// actions rather than about bookkeeping; anything not in here has to render as the
// bare id, which is itself worth pinning.
const LABELS = new Map(Object.entries({
  n1: "First note",
  n2: "Second note",
  n3: "Third note",
  f1: "Research",
  c1: "Ideas",
  r1: "Summarise",
}));

const corpus = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = corpus.map((sample) => {
  const plan = parsePlan(sample.raw);
  return {
    plan,
    labels: plan.actions.map((a) => defaultActionLabel(a, LABELS)),
    summary: buildPlanSummary(plan),
    steps: plan.actions.flatMap((a, i) =>
      actionNeedsGeneration(a) ? [buildContentStepInstruction(a, i, LABELS)] : []),
  };
});
console.log(JSON.stringify(out, null, 2));
