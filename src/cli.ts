#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createVerificationAttestation, healthcheck, loadManifest, selectEngine, verifyDecisionParity, type BenchmarkReport, type EngineManifest, type EngineRequirements, type VerificationRun, type VerificationThresholds } from "./index.js";

const [command, ...args] = process.argv.slice(2);
if (!command || !["validate", "health", "select", "verify"].includes(command)) {
  console.error("Usage: jev-edge validate|health <manifest.json> | select <requirements.json> <manifest.json>... | verify <reference.json> <candidate.json> [thresholds.json]");
  process.exit(1);
}
try {
  if (command === "validate" || command === "health") {
    const manifest = await loadManifest(args[0]!);
    console.log(JSON.stringify(command === "validate" ? { valid: true, id: manifest.id } : await healthcheck(manifest), null, 2));
  } else if (command === "select") {
    const requirements = JSON.parse(await readFile(args[0]!, "utf8")) as EngineRequirements;
    const entries: { manifest: EngineManifest; report?: BenchmarkReport }[] = [];
    for (const path of args.slice(1)) entries.push({ manifest: await loadManifest(path) });
    const selected = selectEngine(entries, requirements);
    console.log(JSON.stringify(selected, null, 2));
  } else {
    const reference = JSON.parse(await readFile(args[0]!, "utf8")) as VerificationRun;
    const candidate = JSON.parse(await readFile(args[1]!, "utf8")) as VerificationRun;
    const thresholds = args[2] ? JSON.parse(await readFile(args[2], "utf8")) as VerificationThresholds : {};
    const report = verifyDecisionParity(reference, candidate, thresholds);
    console.log(JSON.stringify({ report, attestation: createVerificationAttestation(report) }, null, 2));
    if (!report.passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
