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

## Security model

Endpoints must resolve syntactically to `localhost`, `127.0.0.1` or `[::1]`; redirects are rejected. This prevents accidental remote configuration but does not make a local server trustworthy or stop it from making its own network calls. Run models with normal process, filesystem and network isolation.

```sh
npm install
npm run release:check
```

MIT licensed. Jev Edge is independent of model and runtime vendors.
