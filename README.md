# KINETIX OS — Closed-Loop Spatial ERP Orchestrator

**Meta Global AI Developer Hackathon** | **Track:** Indie Developer | **Pillar:** *Push the Frontier*  
**Frontend Repository:** [Gabyresina15/kinetix-ui](https://github.com/Gabyresina15/kinetix-ui)

KINETIX OS turns a raw workbench camera frame and a single spoken operator directive into an audited, multi-tool transactional DAG over physical inventory. Rather than acting as a passive image captioner or static RAG chatbot, KINETIX OS binds 2D spatial geometry to real ERP state transitions, WebAssembly-isolated pricing policies, studio asset synthesis, and a **$50 USD Zero-Trust financial guardrail** before dispatching external supplier claims.

---

## 1. Closed-Loop Spatial Control Architecture

```mermaid
flowchart LR
  Cam["2D Workbench Frame + Operator Voice"] --> Spark["Muse Spark Open 1026 (Baseten 2M TPM)"]
  Spark -->|"Normalized bboxes + DAG Plan"| Sam["SAM 3.1 Pixel Refinement (Meta Model API)"]
  Sam -->|"IoU & Centroid Validated Crops"| Sharp["Sharp Spatial Cropper + PII Crop Gate"]
  Sharp --> DAG["Concurrent Transactional DAG (Promise.allSettled)"]

  DAG --> T1["1. Quarantine & Supplier Claim"]
  DAG --> T2["2. Canonical SKU Stock Upsert"]
  DAG --> T3["3. Visual-DNA Studio Synthesis (Muse Image 1.0)"]
  DAG --> T4["4. Commercial Policy Synth (Muse Wonder 1.0)"]

  T1 -->|">= $50 USD Held"| Guard["Zero-Trust Human Guardrail (Press C)"]
  Guard -->|"Authorized"| TG["Telegram Live Photo Webhook + MongoDB"]
  T2 --> DB[("MongoDB inventory_catalog + Audit Ledger")]
  T3 --> DB
  T4 -->|"Untrusted JS Policy"| WASM["QuickJS WebAssembly Sandbox (4MB / 50ms)"]
  WASM -->|"3 Financial Invariants PASS"| DB
```

---

## 2. Meta AI Stack & Role Matrix

| Model / Tool | Provider & Endpoint | Exact Role in KINETIX OS | Implementation |
| :--- | :--- | :--- | :--- |
| **`meta-models/muse-spark-open-1026`** | **Baseten** (`/v1/chat/completions`, 2M TPM) | Multimodal spatial scene understanding, non-overlapping 2D object grounding, Visual-DNA extraction, and multi-tool JSON DAG planning with live SSE reasoning deltas (`SPARK_REASONING_DELTA`). | `src/services/modelProviders.ts`, `src/prompts/sparkSystemPrompt.ts` |
| **`sam-3.1`** | **Meta Model API** (`/v1/responses`) | Pixel-accurate bounding-box refinement using adaptive search padding (8%–16%) validated against IoU (`>= 0.05`), centroid containment, and area-ratio (`0.1x–3.0x`) guardrails. | `src/services/modelProviders.ts` (`refineMasksWithSam31`) |
| **`muse-image-1.0`** | **Meta Model API** (`/v1/images/generations`) | Crop-to-Studio catalog synthesis (`1024x1024` with automatic `512x512` fallback) driven by structured Visual DNA (`containerGeometry`, `exactColorPalette`, `detectedBrandOrText`, `surfaceMaterial`). | `src/services/modelProviders.ts`, `src/contracts/orchestratorCore.ts` |
| **`muse-wonder-1.0`** | **Meta Model API** (`/v1/chat/completions`) | Translates natural-language commercial rules (margins, VAT, overstock volume discounts, scarcity buffers) into executable JavaScript functions evaluated inside **QuickJS WebAssembly**. | `src/services/modelProviders.ts`, `src/services/wasmPricingSandbox.ts` |
| **`Muse Code`** | Meta Coding Agent | Accelerated TypeScript SSE contract, Zod salvage parser, and QuickJS WASM harness development. | Codebase tooling |

---

## 3. Key Systems Engineering Guarantees

1. **QuickJS WebAssembly Policy Sandbox (`src/services/wasmPricingSandbox.ts`):**
   - Replaces Node's non-isolated `node:vm` with `quickjs-emscripten` running inside isolated WASM linear memory (`4 MB` memory ceiling, `256 KB` stack cap, `50 ms` hard CPU interrupt deadline).
   - Zero access to Node `process`, `require`, filesystem, or network (`typeof process === 'undefined'` even across prototype-chain probes).
   - **Pre-Commit Financial Invariants:** Every synthesized pricing policy must pass three deterministic checks inside WASM before mutating SKU prices:
     1. *No-Loss Floor:* `price > unitCost`
     2. *Anti-Gouging Ceiling:* `price <= unitCost * 4.5`
     3. *Cost Monotonicity:* `calculatePrice(cost * 1.2) > calculatePrice(cost)`
2. **Separated Canonical State vs. Append-Only Audit Log (`src/services/spatialCropperAndDb.ts`):**
   - `inventory_catalog` stores the canonical 31-SKU ERP state (`sku`, `name`, `stock`, `standardInboundLot`, `baseCostUsd`, `sellPriceUsd`).
   - `inventory_mutations`, `supplier_claims`, and `catalog_items` store immutable audit events (falling back automatically to `data/ledger/*.json` if MongoDB is offline).
3. **Zero-Trust `$50` Financial Guardrail (`POST /api/confirm-guardrail`):**
   - Any physical defect claim `>= $50.00 USD` freezes in `HELD_WAITING_VOICE_AUTH` and withholds external webhook dispatch until an operator explicitly authorizes it (`[PRESS C]`), at which point the cropped defect evidence is dispatched via Telegram Bot API (`sendPhoto`) and recorded in MongoDB.

---

## 4. Judge Quickstart (Zero API Keys & Zero MongoDB Required)

You can run the full deterministic pipeline and automated test suite locally in under 60 seconds using the recorded Baseten `muse-spark-open-1026` golden fixture (`fixtures/golden-path/golden-spark-replay.json`):

```bash
git clone https://github.com/Gabyresina15/kinetix-os.git
cd kinetix-os
npm install

# 1. Run automated unit & integration tests (WASM RCE isolation, 50ms loop interrupt, invariants, SSE replay)
npm test

# 2. Start orchestrator in deterministic REPLAY mode on http://localhost:4000
npm run replay
```

### Running in `LIVE` Mode (Baseten + Meta Model API)

1. Copy `.env.example` to `.env` and populate `BASETEN_API_KEY` and `META_MODEL_API_KEY` (plus optional `MONGO_URI`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`).
2. *(Optional)* Seed MongoDB with the 31 canonical hardware SKUs:
   ```bash
   npm run seed
   ```
3. Start the live orchestrator:
   ```bash
   npm run dev
   ```

### One-Command Docker Compose

```bash
docker compose up --build
```

---

## 5. HTTP & SSE API Surface

- `POST /api/orchestrate-stream` — Multimodal SSE stream (`VISION_SCAN_STARTED` → `EDGE_PII_SHIELD` → `SPATIAL_LOCK` → `SPARK_REASONING_DELTA` → `SPARK_REASONING_TRACE` → `SPARK_PLAN_LOCKED` → `TOOL_MUTATED` / `TOOL_FAILED` → `ORCHESTRATION_COMPLETE`).
- `POST /api/confirm-guardrail` — Human-in-the-loop authorization & Telegram photo dispatch for held `>= $50` supplier claims.
- `POST /api/triage/resolve` — Supervisor human-in-the-loop resolution for unverified/triage SKUs (`STOCK` or `CLAIM`).
- `POST /api/reset-demo` — Restores the clean 31-SKU canonical catalog state.
- `GET /api/live-ledger` — Returns current canonical inventory snapshot.
- `GET /api/health` — Reports orchestrator mode, MongoDB connectivity, provider readiness, and live QuickJS WASM isolation probe.

---

## 6. Hackathon Timeline & Disclosure

- **Hackathon Window:** Built specifically for the Meta Global AI Developer Hackathon (October 27 – November 4, 2026).
- **Timestamp Note:** Initial empty/scaffold commits (`Initial commit` boilerplate) were created on the evening of October 26 (~21:00 ART / UTC-3) while setting up the local TypeScript workspace; 100% of the spatial orchestration engine, Meta Model API (`sam-3.1`, `muse-image-1.0`, `muse-wonder-1.0`) and Baseten (`meta-models/muse-spark-open-1026`) integrations, QuickJS WASM sandbox, MongoDB persistence, and tactical UI were developed during the hackathon period.
- **License:** [MIT](./LICENSE)
