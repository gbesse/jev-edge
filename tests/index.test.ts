import test from "node:test";
import assert from "node:assert/strict";
import { benchmark, compatible, createHttpAdapter, createVerificationAttestation, healthcheck, selectEngine, validateManifest, verifyDecisionParity, type EngineManifest, type VerificationRun } from "../src/index.js";

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

test("path overrides cannot change the manifest origin or add credentials", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return new Response("{}"); };
  for (const path of ["https://example.com/collect", "//example.com/collect", "http://127.0.0.1:9000/decide", "http://user:password@127.0.0.1:8000/decide"]) {
    assert.throws(() => createHttpAdapter(manifest, { apiPath: path, fetchImpl }), /origin|credentials/);
    await assert.rejects(() => healthcheck(manifest, { path, fetchImpl }), /origin|credentials/);
  }
  assert.equal(calls, 0);
});

test("verification detects argmax flips and calibration drift", () => {
  const reference: VerificationRun = { model: "fixture", runtime: "python", precision: "fp16", probes: [
    { id: "a", expected: "allow", probabilities: { allow: .9, deny: .1 } },
    { id: "b", expected: "deny", probabilities: { allow: .1, deny: .9 } },
  ] };
  const candidate: VerificationRun = { ...reference, runtime: "llama.cpp", precision: "q4", probes: [
    { id: "a", expected: "allow", probabilities: { allow: .4, deny: .6 } },
    { id: "b", expected: "deny", probabilities: { allow: .12, deny: .88 } },
  ] };
  const report = verifyDecisionParity(reference, candidate);
  assert.equal(report.passed, false);
  assert.equal(report.argmaxFlips, 1);
  assert.match(report.failures.join(" "), /argmax/);
  assert.equal(createVerificationAttestation(report, "2026-10-04T00:00:00.000Z").reportFingerprint, report.fingerprint);
});

test("verification passes within explicit conversion tolerances", () => {
  const reference: VerificationRun = { model: "fixture", runtime: "python", probes: [{ id: "a", probabilities: { yes: .8, no: .2 } }] };
  const candidate: VerificationRun = { model: "fixture", runtime: "llama.cpp", probes: [{ id: "a", probabilities: { yes: .79, no: .21 } }] };
  assert.equal(verifyDecisionParity(reference, candidate, { maxProbabilityDelta: .011 }).passed, true);
});
