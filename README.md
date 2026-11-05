# Kinetix OS — Autonomous Spatial ERP & Warehouse Ledger Orchestrator powered by Meta AI

> **Meta Global AI Developer Hackathon Submission**
> **Author:** Gabriel Sebastián Resina Barrientos (`@Gabyresina15`)
> **Repository:** Unified Monorepo (`src/` Fastify SSE Orchestrator + `client/` React/Vite Spatial HUD)

Kinetix OS is an autonomous **Spatial ERP & Warehouse Ledger Orchestrator** built for industrial receiving docks. A single multimodal capture (live camera frame or workbench benchmark scene + operator voice directive) executes a closed-loop transactional DAG across **five core Meta AI primitives**:

1. **Muse Spark Open (`meta-models/muse-spark-open-1026` on Baseten)** performs real-time streaming multimodal reasoning, spatial object localization, physical PII region flagging, and strict Zod-validated DAG action synthesis (with automatic truncated-JSON stream salvage).
2. **SAM 3.1 (`sam-3.1` via Meta Vision API)** refines bounding-box geometry via **Intersection-over-Union (`computeIoU >= 0.25`)**, centroid containment, and area-ratio validation (`0.35x - 1.85x`), preventing full-bench merge artifacts and falling back cleanly to de-overlapped Spark boxes.
3. **Muse Code (`muse-wonder-1.0` via Meta API)** dynamically translates natural-language warehouse commercial rules and anomaly context into an executable `calculatePrice(ctx)` JavaScript policy, verified inside a **bounded 50ms isolated execution sandbox** (`quickjs-wasm` WebAssembly VM + `node:vm` verifier with deterministic fallback).
4. **Muse Image (`muse-image-1.0` via Meta API)** synthesizes `512x512` (`1:1 Ref`) studio catalog assets from extracted Visual DNA (`containerGeometry`, `exactColorPalette`, `visibleBrandOrOcrText`, `surfaceMaterial`), complete with a full-screen **512x512 Studio Asset Inspector** and PNG download.
5. **Muse Voice Transcribe (`muse-voice-transcribe-1.0` via Meta Audio API)** transcribes `24kHz` 16-bit mono PCM `RIFF/WAVE` operator voice directives with a **34-term warehouse SKU vocabulary bias**.

---

## 1. Judge Quickstart (1-Command Verification)

This repository is a unified monorepo containing both the Fastify backend (`src/`, port `4000`) and the React + Vite frontend (`client/`, port `5173` proxying `/api` to `http://localhost:4000`).

```bash
# 1. Clone and install dependencies (root + client workspace)
git clone https://github.com/Gabyresina15/kinetix-os.git
cd kinetix-os
npm install
npm --prefix client install

# Option A: Instant Replay Mode (Zero API keys or MongoDB required — uses recorded golden traces)
npm run replay

# Option B: Live API Mode (Connects to Baseten Muse Spark Open + Meta AI APIs)
# Note: If API keys in .env are left as placeholders, npm run dev automatically falls back to deterministic Replay mode!
cp .env.example .env
npm run dev

# Restore the canonical 31-SKU ERP inventory & reset data/erp-audit-ledger.json to genesis
npm run reset

# Run the automated end-to-end verification test suite
npm test
```

### Interactive Judge Walkthrough (`http://localhost:5173`)

Once running, open **`http://localhost:5173`** in Chrome or Edge:

1. **Voice Directive (`MIC` / `Muse Voice Transcribe 1.0`):** Click **`MIC`** in the bottom-left control bar to record a `24kHz` PCM WAV voice directive (or use the pre-loaded benchmark prompt), then click **`STOP & TRANSCRIBE`** to transcribe with 34 warehouse SKU vocabulary bias terms.
2. **Concurrent Spatial DAG (`BENCH #1`):** Click **`RUN SPATIAL ORCHESTRATION (SPACEBAR)`** to trigger the real-time multimodal SSE pipeline (`VISION_SCAN_STARTED` -> `SPATIAL_LOCK` -> `SPARK_REASONING_TOKEN` -> `SPARK_PLAN_LOCKED` -> Stage 1 & Stage 2 `TOOL_MUTATED` -> `ORCHESTRATION_COMPLETE`).
3. **512x512 Studio Catalog Synthesis & Inspector (`Muse Image 1.0`):** In the **Crop-to-Studio Synthesis** panel on the right, click **`DOWNLOAD STUDIO ASSET`** to download the `512x512` PNG and open the full-screen **`MUSE IMAGE 1.0 // 512x512 STUDIO ASSET INSPECTOR`** modal comparing the raw camera crop (`RAW_CAMERA_ROI`) against the `1:1` studio render.
4. **Evidence-Based `$50 USD` Financial Guardrail & Telegram Dispatch:** Observe the guardrail intercept the `-$66.30 USD` damaged tower cooler claim (`$78.00` base cost × `0.85` `CRITICAL` fin deformation factor). Click **`[PRESS C] AUTHORIZE & DISPATCH CLAIM`** to release the held claim and dispatch a `1280x720` forensic photo plate to Telegram.
5. **Commit Lot & Advance to `BENCH #2` (`[N] COMMIT LOT & NEXT →`):** Click **`[N] COMMIT LOT & NEXT →`** (or press `N`) to commit the current lot and switch to **`BENCH #2`** (Dual-Fan GPU, Mini-ITX Motherboard, AMD Ryzen CPU Box), where intact Optical QA (`$0.00` claim) and `30%` gross margin repricing execute.
6. **Supervisor Triage & Brand/Model Override (Click Any Bounding Box):**
   - **Catalog Search & Brand Swap:** Click any bounding box on the workbench to open **`SUPERVISOR TRIAGE & OVERRIDE`**, search the 31-SKU catalog (e.g., `"RTX 4080"`), and click **`CONFIRM`** to swap the brand/model and update live stock at Row #1 (`OVERRIDE +1`).
   - **Create New Brand/Model SKU (`+ NEW SKU NOT IN LIST`):** Click **`+ NEW SKU NOT IN LIST`** inside the triage popover to register a brand-new hardware SKU on the fly (expanding the live ERP catalog from `31 SKUs` to `32 SKUs`).
7. **SHA-256 Cryptographic Audit Ledger & Atomic Undo (`[L] LEDGER`):** Click **`[L] LEDGER`** in the top header to inspect the tamper-evident SHA-256 hash chain across all stock, pricing, claim, and supervisor triage blocks, and click **`UNDO TX`** on any block to execute a 1-click atomic compensating rollback (`ROLLED BACK`).

---

## 2. Environment Variables

Copy `.env.example` to `.env` for `LIVE` mode. In `REPLAY` mode (`npm run replay`), or if API keys are left as placeholders, no external credentials or database processes are required.

| Variable | Required in `LIVE` | Default / Model Target | Purpose |
| :--- | :---: | :--- | :--- |
| `BASETEN_API_KEY` | Yes (or auto-fallback) | — | Authenticates streaming requests to Baseten Open-Weight endpoint |
| `BASETEN_MODEL` | No | `meta-models/muse-spark-open-1026` | Open-Weight multimodal planner model slug on Baseten |
| `META_MODEL_API_KEY` | Yes (or auto-fallback) | — | Authenticates requests to Meta AI (`sam-3.1`, `muse-wonder-1.0`, `muse-image-1.0`, `muse-voice-transcribe-1.0`) |
| `META_API_BASE_URL` | No | `https://api.meta.ai/v1` | Unified base URL for Meta AI vision, code, image, and voice endpoints |
| `META_IMAGE_SIZE` | No | `512x512` | Output resolution for `muse-image-1.0` studio catalog asset synthesis |
| `MONGODB_URI` / `MONGO_URI` | Optional | Local JSON fallback (`data/erp-audit-ledger.json`) | Dual persistence: writes to MongoDB when reachable and mirrors every state transition to `data/erp-audit-ledger.json` |
| `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID` | Optional | Local ledger receipt | Dispatches real-time `1280x720` forensic claim plates via Telegram Bot API |

---

## 3. System Architecture & Meta AI Model Integration

```mermaid
flowchart TD
    UI["Client HUD (React + Vite /api Proxy)"] -->|"POST /api/orchestrate-stream (Frame + 24kHz Voice)"| Server["Fastify SSE Orchestrator (src/server.ts)"]
    Server -->|"1. Streaming Multimodal Plan"| Spark["Baseten: meta-models/muse-spark-open-1026"]
    Spark -->|"Zod Validation + JSON Salvage"| SAM["Meta API: sam-3.1 (IoU >= 0.25 Box Refinement)"]
    SAM -->|"Sharp Physical PII Pixel Burn-In"| Crops["Spatial Cropper (src/services/spatialCropperAndDb.ts)"]
    Crops -->|"Stage 1 Concurrent DAG (Promise.allSettled)"| Stage1["Stage 1 Parallel Execution"]
    Stage1 --> NodeClaim["quarantine_and_claim: baseCostUsd * damageFactor ($50 Guardrail)"]
    Stage1 --> NodeStock["mutate_inventory: Stock Delta + Triage Check"]
    Stage1 --> NodeImage["generate_studio_catalog: muse-image-1.0 (512x512)"]
    NodeClaim & NodeStock & NodeImage -->|"Stage 2 Dependent Node"| Stage2["recalculate_margins_vm: muse-wonder-1.0 (Muse Code)"]
    Stage2 -->|"50ms Bounded QuickJS WASM + node:vm Verifier"| Ledger["Dual Persistence: MongoDB + data/erp-audit-ledger.json (SHA-256 Chain)"]
    NodeClaim -->|"If >= $50 USD: HELD_WAITING_VOICE_AUTH"| Guardrail["Supervisor Authorization -> Telegram Forensic Plate"]
```

### Meta AI Models & Source Code Mapping

| Meta AI Model / Tool | Model Identifier | Primary Source File & Function | Role in the Closed-Loop ERP Pipeline |
| :--- | :--- | :--- | :--- |
| **Muse Spark Open** *(Open-Weight on Baseten)* | `meta-models/muse-spark-open-1026` | `src/services/modelProviders.ts` -> `callBasetenMuseSparkOpen()` | Streams reasoning tokens (tracking real `firstTokenLatencyMs` and total network `latencyMs`), localizes workbench objects, flags physical PII shipping labels, and outputs the structured JSON execution plan. |
| **SAM 3.1** | `sam-3.1` | `src/services/modelProviders.ts` -> `callSam31Segmentation()` & `computeIoU()` | Refines Spark bounding boxes via Intersection-over-Union (`IoU >= 0.25`), centroid containment, and area-ratio bounds (`0.35x - 1.85x`), falling back to de-overlapped Spark boxes on mismatch. |
| **Muse Code** | `muse-wonder-1.0` | `src/services/modelProviders.ts` -> `callMuseCodeGenerator()` | Receives natural-language warehouse commercial rules (target margin, high-inventory discount tier, damage handling surcharge, tax rate) and synthesizes `calculatePrice(ctx)` dynamically without a pre-baked formula. |
| **Muse Image** | `muse-image-1.0` | `src/services/modelProviders.ts` -> `callMuseImageStudioSynthesis()` | Synthesizes `512x512` (`1:1 Ref`) studio product thumbnails from extracted Visual DNA (`containerGeometry`, `exactColorPalette`, `surfaceMaterial`) with raw-crop reference conditioning. |
| **Muse Voice Transcribe** | `muse-voice-transcribe-1.0` | `src/services/voiceTranscribeService.ts` -> `transcribeWarehouseAudio()` | Validates 44-byte `RIFF/WAVE` headers (`24kHz` 16-bit mono PCM) captured by the WebAudio recorder and transcribes hands-free dock commands with 34 SKU vocabulary bias terms. |

---

## 4. Technical Verification & Engineering Depth

- **Stage-Based Concurrent DAG Execution (`src/server.ts`):** Actions emitted by `muse-spark-open-1026` are grouped into dependency stages (`ACTION_DEPENDENCY_STAGE`). Stage 1 (`quarantine_and_claim`, `mutate_inventory`, `generate_studio_catalog`) executes concurrently via `Promise.allSettled` with individual per-node timeouts (`withNodeTimeout`). Stage 2 (`recalculate_margins_vm`) executes after Stage 1 settles so batch repricing operates on the updated post-intake inventory stock levels.
- **Evidence-Based `$50 USD` Financial Guardrail (`src/contracts/orchestratorCore.ts`):** Claim valuation never uses static fallback numbers. `computeEvidenceBasedClaimUsd()` computes `claimAmountUsd = Number((baseCostUsd * damageFactor).toFixed(2))` from the matched catalog SKU's `baseCostUsd` and the visual `defectSeverity` (`INTACT` = `0.0`, `MINOR` = `0.25`, `MODERATE` = `0.65`, `CRITICAL` = `0.85`). An intact item yields `$0.00 USD`, a minor cosmetic scuff on `SKU-AIR-SINGLE-TOWER` (`$78.00 * 0.25 = $19.50`) auto-dispatches below `$50 USD`, and a critical bent heatsink fin (`$78.00 * 0.85 = $66.30`) triggers `HELD_WAITING_VOICE_AUTH` until supervisor confirmation.
- **Bounded 50ms Policy Sandbox (`src/services/wasmPricingSandbox.ts`):** Synthesized `calculatePrice(ctx)` code is verified against unit assertions (finite output, cost-floor protection, anti-gouging cap, and cost monotonicity) inside an isolated QuickJS WebAssembly runtime (`quickjs-emscripten`, 4MB memory cap, 50ms interrupt handler) paired with a bounded 50ms `node:vm` verifier (`executeBoundedNodeVmPolicy`) and deterministic arithmetic fallback.
- **Physical Sharp PII Redaction (`src/services/spatialCropperAndDb.ts`):** Before any product crop is extracted or persisted, `extractRealCropsFromFrame()` composites opaque SVG redaction shields (`REDACTED PII // WAYBILL SHIELD`) over any region flagged with `isSensitivePII: true`.
- **SHA-256 Cryptographic Audit Ledger & Dual Persistence (`src/services/auditLedger.ts`):** Every state mutation records a `beforeSnapshot` and `afterSnapshot` linked by a verifiable SHA-256 hash chain, persisted both to MongoDB (when configured) and to `data/erp-audit-ledger.json`, supporting single-click atomic compensating rollbacks (`POST /api/audit-ledger/undo`).

---

## 5. Hackathon Submission Summary

- **Impact:** Eliminates manual barcode scanning, spreadsheet price recalculation, and unverified supplier damage claims on warehouse receiving docks by turning a single camera frame and voice command into audited ERP mutations guarded by an evidence-based `$50 USD` financial circuit breaker.
- **Use of Meta AI Tooling:** Combines `meta-models/muse-spark-open-1026` on Baseten for streaming spatial DAG planning, `sam-3.1` for IoU-validated bounding-box refinement, `muse-wonder-1.0` (Muse Code) for dynamic commercial pricing synthesis, `muse-image-1.0` for `512x512` studio asset generation, and `muse-voice-transcribe-1.0` for 24kHz PCM voice capture.
- **Eligible Bonus Categories:**
  - **Best Build on Meta Open Weight Models:** Powered by `meta-models/muse-spark-open-1026` deployed on Baseten (`src/services/modelProviders.ts`).
  - **Best Agentic Use-Case:** Multi-stage autonomous DAG orchestrator executing real database mutations, sandboxed code synthesis, cryptographic audit logging, supervisor brand/SKU triage overrides, and conditional human-in-the-loop financial holds.
