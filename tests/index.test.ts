import test from "node:test";
import assert from "node:assert/strict";
import { benchmark, compatible, createHttpAdapter, healthcheck, selectEngine, validateManifest, type EngineManifest } from "../src/index.js";

const manifest: EngineManifest = { schemaVersion: 1, id: "local-jev", model: "fixture", runtime: "vllm", endpoint: "http://127.0.0.1:8000", adapter: "open-decision", modalities: ["text"], questionTypes: ["choice", "boolean"], probabilities: true, memoryMiB: 2048, calibrationEce: .03 };

test("rejects remote endpoints and incompatible requirements", () => {
  assert.throws(() => validateManifest({ ...manifest, endpoint: "https://example.com" }), /loopback/);
  assert.deepEqual(compatible(manifest, { modalities: ["image"] }).reasons, ["missing modality:image"]);
});

test("selects by calibration, latency, then memory", () => {
  const selected = selectEngine([{ manifest }, { manifest: { ...manifest, id: "less-calibrated", calibrationEce: .2, memoryMiB: 100 } }], { probabilities: true });
  assert.equal(selected.manifest.id, "local-jev");
});

test("benchmarks warmups separately and reports accuracy", async () => {
  let calls = 0;
  const report = await benchmark(manifest, { invoke: async input => { calls++; await new Promise(resolve => setTimeout(resolve, 1)); return input; } }, [{ id: "yes", input: "yes", expected: "yes" }], { warmupRuns: 2, runs: 3, judge: (output, expected) => output === expected });
  assert.equal(calls, 5);
  assert.equal(report.measurements.length, 3);
  assert.equal(report.accuracy, 1);
  assert.ok(report.latency.p95Ms >= report.latency.minMs);
});

test("HTTP adapter and health check remain on explicit loopback endpoint", async () => {
  const fetchImpl: typeof fetch = async (input, init) => init?.method === "GET" ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ ok: true, url: String(input) }), { status: 200 });
  const adapter = createHttpAdapter(manifest, { fetchImpl });
  assert.deepEqual(await adapter.invoke({ x: 1 }), { ok: true, url: "http://127.0.0.1:8000/v1/decide" });
  assert.equal((await healthcheck(manifest, { fetchImpl })).healthy, true);
});
