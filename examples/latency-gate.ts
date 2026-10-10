import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compatible, type EngineManifest } from "../src/index.ts";

const manifest = JSON.parse(await readFile(new URL("./local-jev.json", import.meta.url), "utf8")) as EngineManifest;
const result = compatible(manifest, { maxP95Ms: 250 });
assert.equal(result.compatible, false);
assert.ok(result.reasons.some(reason => reason.includes("current benchmark")));
console.log(JSON.stringify({ engineId: manifest.id, caseId: "missing_current_benchmark", compatible: false }, null, 2));
