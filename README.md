# Kinetix OS — Spatial ERP Orchestrator

Backend core for the Meta Global AI Developer Hackathon (Kinetix Labs).

## Quick Start

```bash
cd kinetix-os
npm install
npm run start
```

In another terminal:

```bash
curl -N -X POST http://localhost:4000/api/orchestrate-stream
```

You should see the SSE events stream:

- `EDGE_PII_SHIELD`
- `SPATIAL_LOCK`
- `SPARK_PLAN_LOCKED`
- `TOOL_MUTATED` (x4)
- `ORCHESTRATION_COMPLETE`

## Structure

- `src/services/spatialNormalizer.ts` — Converts raw SAM masks into semantic zones (LEFT / CENTER / RIGHT / BOTTOM_PII)
- `src/prompts/sparkSystemPrompt.ts` — System prompt for Muse Spark with spatial grounding
- `src/contracts/orchestratorCore.ts` — Zod schemas + safe `node:vm` sandbox for Muse Code
- `src/server.ts` — Fastify SSE endpoint with golden-path mock

## Next Steps

1. Wrap real model calls inside the existing `withStepSafety` RECORD/REPLAY pattern.
2. Connect actual Meta Model API / SAM / Muse endpoints.
3. Build the tactical console frontend that consumes this SSE stream.
