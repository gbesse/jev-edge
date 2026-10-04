import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export type Runtime = "gguf" | "mlx" | "vllm" | "ollama" | "http";
export type Modality = "text" | "image" | "audio";

export interface EngineManifest {
  schemaVersion: 1;
  id: string;
  model: string;
  runtime: Runtime;
  endpoint: string;
  adapter: "openai-chat" | "open-decision" | "typesafe-compatible";
  modalities: Modality[];
  questionTypes: ("choice" | "boolean" | "score")[];
  probabilities: boolean;
  memoryMiB?: number;
  contextTokens?: number;
  calibrationEce?: number;
  tags?: string[];
}

export interface EngineRequirements {
  modalities?: Modality[];
  questionTypes?: ("choice" | "boolean" | "score")[];
  probabilities?: boolean;
  maxMemoryMiB?: number;
  maxCalibrationEce?: number;
  maxP95Ms?: number;
  tags?: string[];
}

export interface BenchmarkCase { id: string; input: unknown; expected?: string; }
export interface BenchmarkMeasurement { id: string; latencyMs: number; output: unknown; correct?: boolean; }
export interface BenchmarkReport {
  schemaVersion: 1;
  engineId: string;
  manifestFingerprint: string;
  createdAt: string;
  warmupRuns: number;
  runs: number;
  latency: { minMs: number; medianMs: number; p95Ms: number; maxMs: number; meanMs: number };
  accuracy: number | null;
  measurements: BenchmarkMeasurement[];
}

export interface EdgeAdapter { invoke(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>; }

export interface DecisionProbe {
  id: string;
  probabilities: Record<string, number>;
  expected?: string;
}

export interface VerificationRun {
  model: string;
  runtime: string;
  precision?: string;
  artifactSha256?: string;
  probes: DecisionProbe[];
}

export interface VerificationThresholds {
  maxArgmaxFlipRate?: number;
  maxProbabilityDelta?: number;
  maxEceDelta?: number;
  requireExactLabels?: boolean;
}

export interface VerificationReport {
  schemaVersion: 1;
  passed: boolean;
  reference: { model: string; runtime: string; precision?: string; artifactSha256?: string };
  candidate: { model: string; runtime: string; precision?: string; artifactSha256?: string };
  probes: number;
  argmaxFlips: number;
  argmaxFlipRate: number;
  maxProbabilityDelta: number;
  meanProbabilityDelta: number;
  referenceEce: number | null;
  candidateEce: number | null;
  eceDelta: number | null;
  failures: string[];
  fingerprint: string;
}

export interface VerificationAttestation {
  schemaVersion: 1;
  createdAt: string;
  verifier: "@gbesse/jev-edge";
  reportFingerprint: string;
  passed: boolean;
  referenceArtifactSha256?: string;
  candidateArtifactSha256?: string;
  attestationFingerprint: string;
}

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function percentile(sorted: number[], fraction: number): number { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]!; }
function round(value: number): number { return Math.round(value * 100) / 100; }
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value; }
export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

export function validateManifest(manifest: EngineManifest): void {
  assert(manifest?.schemaVersion === 1, "schemaVersion must be 1");
  assert(/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(manifest.id), "id must contain 2-64 safe characters");
  assert(manifest.model?.trim(), "model is required");
  assert(["gguf", "mlx", "vllm", "ollama", "http"].includes(manifest.runtime), "unsupported runtime");
  assert(["openai-chat", "open-decision", "typesafe-compatible"].includes(manifest.adapter), "unsupported adapter");
  assert(manifest.modalities.length > 0 && manifest.questionTypes.length > 0, "modalities and questionTypes cannot be empty");
  const endpoint = new URL(manifest.endpoint);
  assert(endpoint.protocol === "http:" || endpoint.protocol === "https:", "endpoint must use HTTP(S)");
  assert(["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname), "Jev Edge accepts loopback endpoints only");
  assert(!endpoint.username && !endpoint.password, "endpoint cannot contain credentials");
  if (manifest.memoryMiB !== undefined) assert(Number.isFinite(manifest.memoryMiB) && manifest.memoryMiB > 0, "memoryMiB must be positive");
  if (manifest.calibrationEce !== undefined) assert(manifest.calibrationEce >= 0 && manifest.calibrationEce <= 1, "calibrationEce must be between zero and one");
}

function endpointPath(manifest: EngineManifest, path: string): URL {
  const endpoint = new URL(manifest.endpoint);
  const url = new URL(path, endpoint);
  assert(url.origin === endpoint.origin, "path must remain on the manifest endpoint origin");
  assert(!url.username && !url.password, "path cannot contain credentials");
  return url;
}

export function compatible(manifest: EngineManifest, requirements: EngineRequirements = {}, report?: BenchmarkReport): { compatible: boolean; reasons: string[] } {
  validateManifest(manifest);
  const reasons: string[] = [];
  for (const modality of requirements.modalities ?? []) if (!manifest.modalities.includes(modality)) reasons.push(`missing modality:${modality}`);
  for (const type of requirements.questionTypes ?? []) if (!manifest.questionTypes.includes(type)) reasons.push(`missing question:${type}`);
  if (requirements.probabilities && !manifest.probabilities) reasons.push("missing probabilities");
  if (requirements.maxMemoryMiB !== undefined && (manifest.memoryMiB === undefined || manifest.memoryMiB > requirements.maxMemoryMiB)) reasons.push("memory budget exceeded or unknown");
  if (requirements.maxCalibrationEce !== undefined && (manifest.calibrationEce === undefined || manifest.calibrationEce > requirements.maxCalibrationEce)) reasons.push("calibration requirement not met");
  for (const tag of requirements.tags ?? []) if (!manifest.tags?.includes(tag)) reasons.push(`missing tag:${tag}`);
  if (requirements.maxP95Ms !== undefined && (!report || report.engineId !== manifest.id || report.manifestFingerprint !== fingerprint(manifest) || report.latency.p95Ms > requirements.maxP95Ms)) reasons.push("latency requirement not met by a current benchmark");
  return { compatible: reasons.length === 0, reasons };
}

export function selectEngine(entries: { manifest: EngineManifest; report?: BenchmarkReport }[], requirements: EngineRequirements = {}): { manifest: EngineManifest; report?: BenchmarkReport; reasons: string[] } {
  const candidates = entries.map(entry => ({ ...entry, check: compatible(entry.manifest, requirements, entry.report) })).filter(entry => entry.check.compatible);
  assert(candidates.length > 0, `No local engine satisfies requirements: ${entries.map(entry => `${entry.manifest.id}(${compatible(entry.manifest, requirements, entry.report).reasons.join(",")})`).join("; ")}`);
  candidates.sort((a, b) => {
    const eceA = a.manifest.calibrationEce ?? Number.POSITIVE_INFINITY;
    const eceB = b.manifest.calibrationEce ?? Number.POSITIVE_INFINITY;
    const latencyA = a.report?.latency.p95Ms ?? Number.POSITIVE_INFINITY;
    const latencyB = b.report?.latency.p95Ms ?? Number.POSITIVE_INFINITY;
    const memoryA = a.manifest.memoryMiB ?? Number.POSITIVE_INFINITY;
    const memoryB = b.manifest.memoryMiB ?? Number.POSITIVE_INFINITY;
    return eceA - eceB || latencyA - latencyB || memoryA - memoryB || a.manifest.id.localeCompare(b.manifest.id);
  });
  const best = candidates[0]!;
  return { manifest: best.manifest, ...(best.report ? { report: best.report } : {}), reasons: ["compatible", "lowest calibration error, then latency, then memory"] };
}

export async function healthcheck(manifest: EngineManifest, options: { fetchImpl?: typeof fetch; timeoutMs?: number; path?: string } = {}): Promise<{ healthy: boolean; latencyMs: number; status?: number; error?: string }> {
  validateManifest(manifest);
  const timeoutMs = options.timeoutMs ?? 2_000;
  const url = endpointPath(manifest, options.path ?? "/health");
  const started = performance.now();
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    return { healthy: response.ok, latencyMs: round(performance.now() - started), status: response.status };
  } catch (error) {
    return { healthy: false, latencyMs: round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  }
}

export function createHttpAdapter(manifest: EngineManifest, options: { fetchImpl?: typeof fetch; apiPath?: string; encode?: (input: unknown) => unknown; decode?: (payload: unknown) => unknown } = {}): EdgeAdapter {
  validateManifest(manifest);
  const url = endpointPath(manifest, options.apiPath ?? "/v1/decide");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async invoke(input, call = {}) {
      const response = await fetchImpl(url, { method: "POST", redirect: "error", ...(call.signal ? { signal: call.signal } : {}), headers: { "content-type": "application/json" }, body: JSON.stringify(options.encode ? options.encode(input) : input) });
      assert(response.ok, `${manifest.id} returned HTTP ${response.status}`);
      const payload = await response.json();
      return options.decode ? options.decode(payload) : payload;
    },
  };
}

export async function benchmark(manifest: EngineManifest, adapter: EdgeAdapter, cases: BenchmarkCase[], options: { warmupRuns?: number; runs?: number; timeoutMs?: number; judge?: (output: unknown, expected: string) => boolean } = {}): Promise<BenchmarkReport> {
  validateManifest(manifest);
  assert(cases.length > 0, "At least one benchmark case is required");
  const warmupRuns = options.warmupRuns ?? 1;
  const runs = options.runs ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  assert(Number.isInteger(warmupRuns) && warmupRuns >= 0 && Number.isInteger(runs) && runs > 0, "Invalid run counts");
  for (let index = 0; index < warmupRuns; index++) await adapter.invoke(structuredClone(cases[index % cases.length]!.input), { signal: AbortSignal.timeout(timeoutMs) });
  const measurements: BenchmarkMeasurement[] = [];
  for (let run = 0; run < runs; run++) for (const item of cases) {
    const started = performance.now();
    const output = await adapter.invoke(structuredClone(item.input), { signal: AbortSignal.timeout(timeoutMs) });
    const measurement: BenchmarkMeasurement = { id: item.id, latencyMs: round(performance.now() - started), output };
    if (item.expected !== undefined && options.judge) measurement.correct = options.judge(output, item.expected);
    measurements.push(measurement);
  }
  const times = measurements.map(item => item.latencyMs).sort((a, b) => a - b);
  const judged = measurements.filter(item => item.correct !== undefined);
  return {
    schemaVersion: 1, engineId: manifest.id, manifestFingerprint: fingerprint(manifest), createdAt: new Date().toISOString(), warmupRuns, runs,
    latency: { minMs: times[0]!, medianMs: percentile(times, .5), p95Ms: percentile(times, .95), maxMs: times.at(-1)!, meanMs: round(times.reduce((a, b) => a + b, 0) / times.length) },
    accuracy: judged.length ? round(judged.filter(item => item.correct).length / judged.length) : null,
    measurements,
  };
}

export async function loadManifest(path: string): Promise<EngineManifest> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as EngineManifest;
  validateManifest(manifest);
  return manifest;
}

function validateProbabilityMap(probabilities: Record<string, number>, context: string): void {
  const values = Object.values(probabilities);
  assert(values.length >= 2, `${context}: at least two labels are required`);
  assert(values.every(value => Number.isFinite(value) && value >= 0 && value <= 1), `${context}: invalid probability`);
  assert(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= .001, `${context}: probabilities must sum to one`);
}

function argmax(probabilities: Record<string, number>): string {
  return Object.entries(probabilities).sort(([labelA, valueA], [labelB, valueB]) => valueB - valueA || labelA.localeCompare(labelB))[0]![0];
}

function calibrationEce(probes: DecisionProbe[]): number | null {
  const labelled = probes.filter(probe => probe.expected !== undefined);
  if (!labelled.length) return null;
  const bins = Array.from({ length: 10 }, () => ({ confidence: 0, correct: 0, count: 0 }));
  for (const probe of labelled) {
    const winner = argmax(probe.probabilities);
    const confidence = probe.probabilities[winner]!;
    const bin = bins[Math.min(9, Math.floor(confidence * 10))]!;
    bin.confidence += confidence;
    bin.correct += winner === probe.expected ? 1 : 0;
    bin.count++;
  }
  return round(bins.reduce((ece, bin) => bin.count ? ece + (bin.count / labelled.length) * Math.abs(bin.correct / bin.count - bin.confidence / bin.count) : ece, 0));
}

export function verifyDecisionParity(reference: VerificationRun, candidate: VerificationRun, thresholds: VerificationThresholds = {}): VerificationReport {
  assert(reference.probes.length > 0, "Reference run has no probes");
  const candidateById = new Map(candidate.probes.map(probe => [probe.id, probe]));
  assert(candidateById.size === candidate.probes.length, "Candidate probe IDs must be unique");
  const deltas: number[] = [];
  let flips = 0;
  for (const probe of reference.probes) {
    validateProbabilityMap(probe.probabilities, `reference:${probe.id}`);
    const compared = candidateById.get(probe.id);
    assert(compared, `Candidate is missing probe: ${probe.id}`);
    validateProbabilityMap(compared.probabilities, `candidate:${probe.id}`);
    const referenceLabels = Object.keys(probe.probabilities).sort();
    const candidateLabels = Object.keys(compared.probabilities).sort();
    if (thresholds.requireExactLabels !== false) assert(JSON.stringify(referenceLabels) === JSON.stringify(candidateLabels), `${probe.id}: label sets differ`);
    if (argmax(probe.probabilities) !== argmax(compared.probabilities)) flips++;
    for (const label of new Set([...referenceLabels, ...candidateLabels])) deltas.push(Math.abs((probe.probabilities[label] ?? 0) - (compared.probabilities[label] ?? 0)));
  }
  assert(candidate.probes.length === reference.probes.length, "Candidate has additional probes");
  const flipRate = flips / reference.probes.length;
  const maxDelta = Math.max(...deltas);
  const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const referenceEce = calibrationEce(reference.probes);
  const candidateEce = calibrationEce(candidate.probes);
  const eceDelta = referenceEce === null || candidateEce === null ? null : candidateEce - referenceEce;
  const limits = { maxArgmaxFlipRate: thresholds.maxArgmaxFlipRate ?? 0, maxProbabilityDelta: thresholds.maxProbabilityDelta ?? .02, maxEceDelta: thresholds.maxEceDelta ?? .02 };
  const failures: string[] = [];
  if (flipRate > limits.maxArgmaxFlipRate) failures.push(`argmax flip rate ${round(flipRate)} exceeds ${limits.maxArgmaxFlipRate}`);
  if (maxDelta > limits.maxProbabilityDelta) failures.push(`maximum probability delta ${round(maxDelta)} exceeds ${limits.maxProbabilityDelta}`);
  if (eceDelta !== null && eceDelta > limits.maxEceDelta) failures.push(`ECE regression ${round(eceDelta)} exceeds ${limits.maxEceDelta}`);
  const core = {
    schemaVersion: 1 as const,
    passed: failures.length === 0,
    reference: { model: reference.model, runtime: reference.runtime, ...(reference.precision ? { precision: reference.precision } : {}), ...(reference.artifactSha256 ? { artifactSha256: reference.artifactSha256 } : {}) },
    candidate: { model: candidate.model, runtime: candidate.runtime, ...(candidate.precision ? { precision: candidate.precision } : {}), ...(candidate.artifactSha256 ? { artifactSha256: candidate.artifactSha256 } : {}) },
    probes: reference.probes.length,
    argmaxFlips: flips,
    argmaxFlipRate: round(flipRate),
    maxProbabilityDelta: round(maxDelta),
    meanProbabilityDelta: round(meanDelta),
    referenceEce,
    candidateEce,
    eceDelta: eceDelta === null ? null : round(eceDelta),
    failures,
  };
  return { ...core, fingerprint: fingerprint(core) };
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function createVerificationAttestation(report: VerificationReport, createdAt = new Date().toISOString()): VerificationAttestation {
  const core = {
    schemaVersion: 1 as const,
    createdAt,
    verifier: "@gbesse/jev-edge" as const,
    reportFingerprint: report.fingerprint,
    passed: report.passed,
    ...(report.reference.artifactSha256 ? { referenceArtifactSha256: report.reference.artifactSha256 } : {}),
    ...(report.candidate.artifactSha256 ? { candidateArtifactSha256: report.candidate.artifactSha256 } : {}),
  };
  return { ...core, attestationFingerprint: fingerprint(core) };
}
