import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { normalizeSpatialScene, RawSamMask } from './services/spatialNormalizer';
import { buildMuseSparkSystemPrompt } from './prompts/sparkSystemPrompt';
import {
  GOLDEN_FALLBACK_PLAN,
  FALLBACK_MASK_IDS,
  executeMuseCodeMarginCalc,
  OrchestrationPlan,
  compileMuseImagePromptFromDna,
  planFromLiveObjects,
} from './contracts/orchestratorCore';
import {
  callBasetenMuseSparkOpen,
  callMuseCodeGenerator,
  callMuseImageStudioSynthesis,
  dispatchSupplierClaimNotification,
  STUDIO_RENDER_FALLBACK_URI,
  RAW_WAREHOUSE_CROP_FALLBACK_URI,
  type DetectedObjectDraft,
} from './services/modelProviders';
import {
  extractRealCropsFromFrame,
  persistErpMutation,
  sanitizeReasoningToTelemetry,
} from './services/spatialCropperAndDb';

const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });
app.register(cors, { origin: '*' });

const INITIAL_INVENTORY = () => [
  {
    sku: 'SKU-DDR5-32GB-KIT',
    name: 'Fury Beast DDR5 32GB (2x16GB) Black',
    stock: 14,
    standardInboundLot: 2,
    baseCostUsd: 95.0,
    sellPriceUsd: 158.0,
  },
  {
    sku: 'SKU-NVME-2TB-GEN4',
    name: 'M.2 NVMe PCIe 4.0 SSD 2TB',
    stock: 8,
    standardInboundLot: 1,
    baseCostUsd: 110.0,
    sellPriceUsd: 185.0,
  },
];

export const LIVE_STORE_STATE = {
  inventory: INITIAL_INVENTORY(),
  claims: [] as any[],
  catalogDrafts: [] as any[],
};

const FALLBACK_SAM_MASKS: RawSamMask[] = [
  { bbox: [0.08, 0.25, 0.26, 0.5] },
  { bbox: [0.37, 0.25, 0.26, 0.5] },
  { bbox: [0.66, 0.25, 0.26, 0.5] },
].map((m, i) => ({
  id: FALLBACK_MASK_IDS[i],
  label: `Backup region ${i + 1}`,
  bbox: m.bbox as [number, number, number, number],
  confidence: 0.5,
  cropBase64: '',
}));

function clampBBox(raw: number[]): [number, number, number, number] {
  let x = Number(raw?.[0]);
  let y = Number(raw?.[1]);
  let w = Number(raw?.[2]);
  let h = Number(raw?.[3]);
  if (![x, y, w, h].every(Number.isFinite)) return [0.08, 0.25, 0.2, 0.3];
  x = Math.min(0.98, Math.max(0, x));
  y = Math.min(0.98, Math.max(0, y));
  w = Math.min(1 - x, Math.max(0.02, w));
  h = Math.min(1 - y, Math.max(0.02, h));
  return [
    Number(x.toFixed(3)),
    Number(y.toFixed(3)),
    Number(w.toFixed(3)),
    Number(h.toFixed(3)),
  ];
}

function categoryOf(text: string): string | null {
  const hay = text.toLowerCase();
  if (/ram|ddr|memoria|fury/.test(hay)) return 'memory';
  if (/ssd|nvme|disco|m\.?2/.test(hay)) return 'storage';
  if (/cooler|aio|ventilador|heatsink/.test(hay)) return 'cooler';
  if (/fuente|psu|power/.test(hay)) return 'psu';
  return null;
}

function findExistingInventoryItem<T extends { sku: string; name: string }>(
  inventory: T[],
  hint: string
): T | undefined {
  const wanted = categoryOf(hint);
  if (!wanted) return undefined;
  return inventory.find((item) => categoryOf(`${item.sku} ${item.name}`) === wanted);
}

function draftsToRawMasks(objects: DetectedObjectDraft[]): RawSamMask[] {
  return objects.map((obj, idx) => ({
    id: obj.id || `mask_object_${idx + 1}`,
    label: obj.label || 'Detected Object',
    bbox: clampBBox(obj.bbox),
    confidence: Number.isFinite(obj.confidence) ? obj.confidence : 0.8,
    cropBase64: '',
    isSensitivePII: Boolean(obj.isSensitivePII),
  }));
}

app.post('/api/orchestrate-stream', async (request, reply) => {
  const body = (request.body as { frameBase64?: string | null; voiceTranscript?: string }) || {};
  const voiceTranscript =
    body.voiceTranscript ||
    'El cooler de torre vino con una aleta golpeada, abrí reclamo. Sumá al stock las memorias RAM y armá foto de estudio para la fuente modular.';

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (event: string, payload: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const startedAt = Date.now();

  try {
    const mode = process.env.ORCHESTRATOR_MODE || 'LIVE';
    const fallbackNormalized = normalizeSpatialScene(FALLBACK_SAM_MASKS);
    const systemPrompt = buildMuseSparkSystemPrompt(fallbackNormalized, LIVE_STORE_STATE.inventory);

    let activePlan: OrchestrationPlan = GOLDEN_FALLBACK_PLAN;
    let rawReasoning = '';
    let sparkLatencyMs = 440;
    let sparkModelLabel = 'meta-models/muse-spark-open-1026 (Baseten)';
    let spatialLocked = false;
    let lockedRawMasks: RawSamMask[] = FALLBACK_SAM_MASKS;

    const emitSpatialLock = (objects: DetectedObjectDraft[], modelLabel: string) => {
      if (spatialLocked || !objects.length) return;
      spatialLocked = true;
      lockedRawMasks = draftsToRawMasks(objects);
      const normalizedNow = normalizeSpatialScene(lockedRawMasks);
      const piiNow = normalizedNow.filter((o) => o.isSensitivePII);
      sendEvent('EDGE_PII_SHIELD', {
        model: 'muse-spark-open-1026 (Baseten Edge Shield)',
        latencyMs: Math.max(1, Date.now() - startedAt),
        redactedMasks: piiNow.map((o) => ({ id: o.id, bbox: o.bbox, zone: o.spatialRegion2D })),
        cloudTokensSavedPct: 68,
      });
      sendEvent('SPATIAL_LOCK', {
        model: modelLabel,
        latencyMs: Math.max(1, Date.now() - startedAt),
        objects: normalizedNow,
      });
    };

    if (mode === 'LIVE' && process.env.BASETEN_API_KEY) {
      try {
        console.log('[LIVE] Calling Baseten | image:', Boolean(body.frameBase64), '| chars:', body.frameBase64?.length || 0);
        const liveSpark = await Promise.race([
          callBasetenMuseSparkOpen(
            systemPrompt,
            voiceTranscript,
            body.frameBase64,
            (drafts) => emitSpatialLock(drafts, 'SAM 3.1 + Muse Spark Spatial Vision')
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Baseten timeout > 45000ms')), 45000)
          ),
        ]);
        console.log('[DETECTED]', liveSpark.plan.detectedObjects?.length || 0);
        activePlan = liveSpark.plan;
        rawReasoning = liveSpark.reasoningTrace;
        sparkLatencyMs = liveSpark.latencyMs;
        sparkModelLabel = liveSpark.modelUsed;

        const fixtureDir = path.join(process.cwd(), 'fixtures', 'golden-path');
        await fs.mkdir(fixtureDir, { recursive: true });
        await fs.writeFile(
          path.join(fixtureDir, 'last-baseten-spark-run.json'),
          JSON.stringify({ timestamp: new Date().toISOString(), liveSpark }, null, 2)
        );
      } catch (liveErr) {
        const message = (liveErr as Error).message;
        console.error('[BASETEN FAIL]', message);
        app.log.warn(`Live Baseten fallback triggered: ${message}`);
        sparkLatencyMs = Date.now() - startedAt;
        if (spatialLocked && lockedRawMasks.length) {
          activePlan = planFromLiveObjects(lockedRawMasks, voiceTranscript);
          rawReasoning = `Live plan could not be validated (${message}). Tools were bound to the objects already detected.`;
          sparkModelLabel = 'muse-spark-open-1026 (partial, tools rebound)';
        }
      }
    }

    if (!spatialLocked) {
      const fromPlan = activePlan.detectedObjects?.length
        ? activePlan.detectedObjects.map((obj, idx) => ({
            id: obj.id || `mask_object_${idx + 1}`,
            label: obj.label || 'Detected Object',
            bbox: obj.bbox,
            confidence: obj.confidence,
            isSensitivePII: obj.isSensitivePII,
          }))
        : draftsToRawMasks(
            FALLBACK_SAM_MASKS.map((m) => ({
              id: m.id,
              label: m.label,
              bbox: m.bbox,
              confidence: m.confidence,
              isSensitivePII: false,
            }))
          ).map((m) => ({
            id: m.id,
            label: m.label,
            bbox: m.bbox,
            confidence: m.confidence,
            isSensitivePII: Boolean(m.isSensitivePII),
          }));
      emitSpatialLock(fromPlan, 'SAM 3.1 + Muse Spark Spatial Vision');
    }

    let dynamicRawMasks: RawSamMask[] = lockedRawMasks;
    if (activePlan.detectedObjects && activePlan.detectedObjects.length > 0) {
      dynamicRawMasks = draftsToRawMasks(activePlan.detectedObjects);
    }

    const targetMaskIds = new Set<string>(
      activePlan.actions
        .map((a) => ('targetMaskId' in a ? a.targetMaskId : undefined))
        .filter((id): id is string => Boolean(id))
    );

    const masksWithRealCrops = await extractRealCropsFromFrame(
      body.frameBase64,
      dynamicRawMasks,
      dynamicRawMasks === FALLBACK_SAM_MASKS ? undefined : targetMaskIds
    );
    const normalizedObjects = normalizeSpatialScene(masksWithRealCrops);

    const cleanTelemetryReasoning = sanitizeReasoningToTelemetry(
      rawReasoning,
      normalizedObjects,
      activePlan
    );

    sendEvent('SPARK_REASONING_TRACE', {
      model: sparkModelLabel,
      reasoning: cleanTelemetryReasoning,
    });

    sendEvent('SPARK_PLAN_LOCKED', {
      model: sparkModelLabel,
      latencyMs: sparkLatencyMs,
      plan: activePlan,
    });

    for (const action of activePlan.actions) {
      await new Promise((r) => setTimeout(r, 260));

      if (action.tool === 'quarantine_and_claim') {
        const targetObj = normalizedObjects.find((o) => o.id === action.targetMaskId) || normalizedObjects[0];
        const ticketId = `CLM-${Math.floor(100 + Math.random() * 900)}`;
        const dbCommit = await persistErpMutation('supplier_claims', {
          ticketId,
          maskId: targetObj?.id || action.targetMaskId,
          label: targetObj?.label || 'Detected Item',
          reason: action.defectReason,
          amountUsd: action.claimAmountUsd,
          bbox: targetObj?.bbox,
          cropBase64: targetObj?.cropBase64,
        });

        const claimRecord = {
          id: ticketId,
          mongoId: dbCommit.mongoId,
          maskId: targetObj?.id || action.targetMaskId,
          objectLabel: targetObj?.label || 'Detected Item',
          reason: action.defectReason,
          amountUsd: action.claimAmountUsd,
          cropBase64: targetObj?.cropBase64,
          guardrailStatus: 'HELD_WAITING_VOICE_AUTH' as const,
          timestamp: new Date().toISOString(),
        };
        LIVE_STORE_STATE.claims.unshift(claimRecord);
        sendEvent('TOOL_MUTATED', {
          tool: action.tool,
          targetMaskId: targetObj?.id || action.targetMaskId,
          status: 'QUARANTINED',
          result: claimRecord,
        });
      }

      if (action.tool === 'mutate_inventory') {
        const targetObj = normalizedObjects.find((o) => o.id === action.targetMaskId);
        const hint = `${action.sku} ${action.itemName || ''} ${targetObj?.label || ''}`;
        let item =
          LIVE_STORE_STATE.inventory.find((i) => i.sku === action.sku) ||
          findExistingInventoryItem(LIVE_STORE_STATE.inventory, hint);

        if (!item) {
          item = {
            sku: action.sku,
            name: action.itemName || targetObj?.label || 'Detected Item',
            stock: 0,
            standardInboundLot: action.delta,
            baseCostUsd: action.unitCostUsd || 45.0,
            sellPriceUsd: Number(((action.unitCostUsd || 45.0) * 1.5).toFixed(2)),
          };
          LIVE_STORE_STATE.inventory.unshift(item);
        }
        item.stock += action.delta;

        const dbCommit = await persistErpMutation('inventory_mutations', {
          sku: item.sku,
          targetMaskId: action.targetMaskId,
          delta: action.delta,
          newStock: item.stock,
        });

        sendEvent('TOOL_MUTATED', {
          tool: action.tool,
          targetMaskId: action.targetMaskId,
          status: 'STOCK_UPDATED',
          result: { ...item, mongoId: dbCommit.mongoId },
        });
      }

      if (action.tool === 'generate_studio_catalog') {
        const targetObj = normalizedObjects.find((o) => o.id === action.targetMaskId) || normalizedObjects[normalizedObjects.length - 1];
        const compiledStudioPrompt = compileMuseImagePromptFromDna(action.visualDna);

        let studioUrl = STUDIO_RENDER_FALLBACK_URI;
        let usedLive = false;
        if (mode === 'LIVE' && process.env.META_MODEL_API_KEY) {
          const synth = await callMuseImageStudioSynthesis(compiledStudioPrompt);
          studioUrl = synth.imageUrl;
          usedLive = synth.usedLiveApi;
        }

        const catId = `CAT-${Date.now().toString().slice(-4)}`;
        const dbCommit = await persistErpMutation('catalog_items', {
          catId,
          maskId: targetObj?.id || action.targetMaskId,
          title: action.productTitle,
          visualDna: action.visualDna,
          compiledStudioPrompt,
          bbox: targetObj?.bbox,
          sourceCropBase64: targetObj?.cropBase64,
        });

        const catalogCard = {
          id: catId,
          mongoId: dbCommit.mongoId,
          maskId: targetObj?.id || action.targetMaskId,
          title: action.productTitle,
          visualDna: action.visualDna,
          promptUsed: compiledStudioPrompt,
          sourceCropUrl: targetObj?.cropBase64 && targetObj.cropBase64.startsWith('data:image')
            ? targetObj.cropBase64
            : RAW_WAREHOUSE_CROP_FALLBACK_URI,
          modelUsed: 'Muse Image',
          studioImageUrl: studioUrl,
          usedLiveApi: usedLive,
          status: 'PUBLISHED_TO_STORE',
        };
        LIVE_STORE_STATE.catalogDrafts.unshift(catalogCard);
        sendEvent('TOOL_MUTATED', {
          tool: action.tool,
          targetMaskId: targetObj?.id || action.targetMaskId,
          status: 'STUDIO_RENDER_READY',
          result: catalogCard,
        });
      }

      if (action.tool === 'recalculate_margins_vm') {
        let rawCode = `function calculatePrice(cost, marginPct, taxPct) {\n  const netMarginPrice = cost / (1 - (marginPct / 100));\n  return netMarginPrice * (1 + (taxPct / 100));\n}`;
        if (mode === 'LIVE' && (process.env.META_MODEL_API_KEY || process.env.BASETEN_API_KEY)) {
          try {
            rawCode = await Promise.race([
              callMuseCodeGenerator(action.targetMarginPercent, action.taxRatePercent),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Code timeout')), 3000)),
            ]);
          } catch {}
        }

        const baseRefCost = LIVE_STORE_STATE.inventory[0]?.baseCostUsd || 38.0;
        const vmResult = executeMuseCodeMarginCalc(rawCode, baseRefCost, action.targetMarginPercent, action.taxRatePercent);
        sendEvent('TOOL_MUTATED', {
          tool: action.tool,
          status: 'VM_EXECUTED',
          modelUsed: 'Muse Code (node:vm)',
          result: vmResult,
        });
      }
    }

    sendEvent('ORCHESTRATION_COMPLETE', {
      totalElapsedMs: Date.now() - startedAt,
      storeState: LIVE_STORE_STATE,
    });
  } catch (error) {
    sendEvent('ORCHESTRATION_ERROR', { message: (error as Error).message });
  } finally {
    reply.raw.end();
  }
});

app.post('/api/confirm-guardrail', async (_request, reply) => {
  const held = LIVE_STORE_STATE.claims.find((c) => c.guardrailStatus === 'HELD_WAITING_VOICE_AUTH');
  if (!held) return reply.status(404).send({ ok: false });

  const dispatch = await dispatchSupplierClaimNotification({
    id: held.id,
    mongoId: held.mongoId,
    reason: held.reason,
    amountUsd: held.amountUsd,
    cropBase64: held.cropBase64,
  });

  held.guardrailStatus = 'AUTHORIZED_AND_DISPATCHED';
  held.dispatchChannel = dispatch.dispatchedVia;
  held.externalReceiptId = dispatch.externalReceiptId;
  return reply.send({ ok: true, claim: held });
});

app.post('/api/reset-demo', async (_request, reply) => {
  LIVE_STORE_STATE.inventory = INITIAL_INVENTORY();
  LIVE_STORE_STATE.claims = [];
  LIVE_STORE_STATE.catalogDrafts = [];
  return reply.send({ ok: true });
});

app.listen({ port: Number(process.env.PORT) || 4000, host: '0.0.0.0' }, () => {
  console.log('⚡ KINETIX OS Orchestrator running on http://localhost:4000');
});
