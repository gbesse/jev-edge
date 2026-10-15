# Jev Edge

Manifest, benchmark and select local decision engines across GGUF, MLX, vLLM, Ollama and custom HTTP runtimes.

Jev Edge is a control plane, not another model server. It does not scan the LAN, download weights, execute arbitrary model commands or silently send inputs to a hosted fallback.

## Engine manifests

```sh
jev-edge validate examples/local-jev.json
jev-edge health examples/local-jev.json
jev-edge select examples/requirements.json examples/local-jev.json
```

A manifest declares the runtime, loopback endpoint, adapter contract, modalities, question types, probability support, memory, calibration and operational tags. Selection fails closed when a required measurement is unknown.

## Benchmark

```ts
import { benchmark, createHttpAdapter } from "@gbesse/jev-edge";

const adapter = createHttpAdapter(manifest);
const report = await benchmark(manifest, adapter, cases, {
  warmupRuns: 2,
  runs: 5,
  judge: (output, expected) => output.choice === expected,
});
```

Reports bind to a SHA-256 fingerprint of the complete manifest. A latency requirement therefore cannot reuse measurements from a changed model or endpoint. Warmup calls are excluded from latency and accuracy.

## Conversion and quantization verification

```sh
jev-edge verify examples/reference-run.json examples/quantized-run.json
```

`verify` compares a reference run such as Transformers FP16 with a converted
or quantized runtime. It fails on argmax changes, excessive probability drift
or calibration regression and emits a content-addressed attestation suitable
for CI artifacts. Supply an optional third JSON file to override thresholds.
The exported `sha256File` helper can bind both runs to their exact artifacts.

## Security model

Endpoints must resolve syntactically to `localhost`, `127.0.0.1` or `[::1]`; redirects are rejected. This prevents accidental remote configuration but does not make a local server trustworthy or stop it from making its own network calls. Run models with normal process, filesystem and network isolation.

Health-check `path` and adapter `apiPath` overrides must keep the manifest's origin (scheme, host and port) and cannot contain credentials. An override that changes the destination is rejected before a request is made.

```sh
npm install
npm run release:check
```

MIT licensed. Jev Edge is independent of model and runtime vendors.

## Contrôle d’adoption · Adoption check · Comprobación de adopción

[Français : essayer un cas synthétique](examples/adoption-check.md) · [English: try a synthetic case](examples/adoption-check.md) · [Español: pruebe un caso sintético](examples/adoption-check.md).

## Finite measurements and complete parity receipts / Mesures finies / Mediciones finitas

EN: Benchmarks now enforce a wall-clock deadline even when adapters ignore AbortSignal, stop further dispatch after failure, snapshot inputs and require Boolean judges. Latency constraints reject nonfinite budgets and cannot pass a NaN measurement. Parity receipts bind full reference/candidate probe fingerprints and resolved thresholds; duplicate reference IDs, nonfinite thresholds and changed truth labels are rejected. Hashes are unsigned consistency records. Cancellation cannot terminate external side effects or synchronous JavaScript; no new real-engine benchmark is claimed.

FR : Les benchmarks appliquent désormais un délai réel même si l’adaptateur ignore AbortSignal, arrêtent les appels après échec, capturent les entrées et exigent des juges booléens. Les contraintes de latence refusent budgets non finis et mesures NaN. Les reçus de parité lient empreintes complètes des sondes et seuils résolus ; ID de référence dupliqués, seuils non finis et vérités modifiées sont refusés. Les hashes sont des contrôles de cohérence non signés. L’annulation n’arrête pas les effets externes ni le JavaScript synchrone ; aucun nouveau benchmark de moteur réel n’est revendiqué.

ES: Benchmarks aplican un plazo real aunque adaptadores ignoren AbortSignal, detienen llamadas tras fallos, capturan entradas y exigen jueces booleanos. Restricciones de latencia rechazan presupuestos no finitos y mediciones NaN. Recibos de paridad vinculan huellas completas de sondas y umbrales resueltos; rechazan ID duplicados, umbrales no finitos y verdades cambiadas. Hashes son controles de consistencia sin firma. Cancelar no detiene efectos externos ni JavaScript síncrono; no afirma benchmarks nuevos de motores reales.
