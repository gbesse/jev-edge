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
  const url = new URL(options.path ?? "/health", manifest.endpoint);
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
  const url = new URL(options.apiPath ?? "/v1/decide", manifest.endpoint);
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
