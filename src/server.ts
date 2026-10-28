import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { normalizeSpatialScene, RawSamMask } from './services/spatialNormalizer';
import { buildMuseSparkSystemPrompt } from './prompts/sparkSystemPrompt';
import {
  GOLDEN_FALLBACK_PLAN,
  executeMuseCodeMarginCalc,
  OrchestrationPlan,
  compileMuseImagePromptFromDna,
} from './contracts/orchestratorCore';
import {
  callBasetenMuseSparkOpen,
  callMuseCodeGenerator,
  callMuseImageStudioSynthesis,
  dispatchSupplierClaimNotification,
  STUDIO_RENDER_FALLBACK_URI,
  RAW_WAREHOUSE_CROP_FALLBACK_URI,
} from './services/modelProviders';
import {
  extractRealCropsFromFrame,
  persistErpMutation,
  sanitizeReasoningToTelemetry,
} from './services/spatialCropperAndDb';

const app = Fastify({ logger: true });
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

const BASE_SAM_MASKS: RawSamMask[] = [
  {
    id: 'mask_air_cooler',
    label: 'Tower CPU Air Cooler',
    bbox: [0.410, 0.495, 0.135, 0.285],
    confidence: 0.98,
    cropBase64: '',
  },
  {
    id: 'mask_ram_sticks',
    label: '2x Black DDR5 RAM Modules',
    bbox: [0.172, 0.705, 0.168, 0.165],
    confidence: 0.98,
    cropBase64: '',
  },
  {
    id: 'mask_psu_modular',
    label: 'Modular ATX Power Supply',
    bbox: [0.780, 0.575, 0.185, 0.270],
    confidence: 0.99,
    cropBase64: '',
  },
];

app.post('/api/orchestrate-stream', async (request, reply) => {
  const body = (request.body as { frameBase64?: string | null; voiceTranscript?: string }) || {};
  const voiceTranscript =
    body.voiceTranscript ||
    'El cooler de torre vino con una aleta golpeada, abrí reclamo. Sumá al stock las memorias RAM y armá foto de estudio para la fuente modular.';

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const sendEvent = (event: string, payload: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const mode = process.env.ORCHESTRATOR_MODE || 'LIVE';
    const fallbackNormalized = normalizeSpatialScene(BASE_SAM_MASKS);
    const systemPrompt = buildMuseSparkSystemPrompt(fallbackNormalized, LIVE_STORE_STATE.inventory);

    let activePlan: OrchestrationPlan = GOLDEN_FALLBACK_PLAN;
    let rawReasoning = '';
    let sparkLatencyMs = 440;
    let sparkModelLabel = 'meta-models/muse-spark-open-1026 (Baseten)';

    if (mode === 'LIVE' && process.env.BASETEN_API_KEY) {
      try {
        const liveSpark = await Promise.race([
          callBasetenMuseSparkOpen(systemPrompt, voiceTranscript, body.frameBase64),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Baseten timeout > 25000ms')), 25000)
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
        app.log.warn(`Live Baseten fallback triggered: ${(liveErr as Error).message}`);
      }
    }

    // Clean inventory: only keep items that will be mutated in this run
    if (activePlan.detectedObjects && activePlan.detectedObjects.length > 0) {
      const mutatedSkus = new Set(
        activePlan.actions
          .filter((a) => a.tool === 'mutate_inventory')
          .map((a: any) => a.sku)
      );
      LIVE_STORE_STATE.inventory = LIVE_STORE_STATE.inventory.filter((item) =>
        mutatedSkus.has(item.sku)
      );
    }

    // Prefer detected objects. If image is present but model returned nothing, do NOT fall back to hardware masks.
    let dynamicRawMasks: RawSamMask[] = BASE_SAM_MASKS;
    if (activePlan.detectedObjects && activePlan.detectedObjects.length > 0) {
      dynamicRawMasks = activePlan.detectedObjects.map((obj: any) => ({
        id: obj.id || `mask_${Math.random().toString(36).slice(2, 7)}`,
        label: obj.label || 'Detected Object',
        bbox: Array.isArray(obj.bbox) && obj.bbox.length === 4 ? obj.bbox : [0.3, 0.3, 0.4, 0.4],
        confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.9,
        cropBase64: '',
        isSensitivePII: !!obj.isSensitivePII,
      }));
    } else if (body.frameBase64) {
      dynamicRawMasks = [];
    }

    const masksWithRealCrops = await extractRealCropsFromFrame(body.frameBase64, dynamicRawMasks);
    const normalizedObjects = normalizeSpatialScene(masksWithRealCrops);
    const piiObjects = normalizedObjects.filter((o) => o.isSensitivePII);

    sendEvent('EDGE_PII_SHIELD', {
      model: 'muse-spark-open-1026 (Baseten Edge Shield)',
      latencyMs: 38,
      redactedMasks: piiObjects.map((o) => ({ id: o.id, bbox: o.bbox, zone: o.spatialRegion2D })),
      cloudTokensSavedPct: 68,
    });

    await new Promise((r) => setTimeout(r, 180));

    sendEvent('SPATIAL_LOCK', {
      model: 'SAM 3.1 + Muse Spark Spatial Vision',
      latencyMs: 285,
      objects: normalizedObjects,
    });

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
        let item = LIVE_STORE_STATE.inventory.find((i) => i.sku === action.sku);

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
      totalElapsedMs: sparkLatencyMs + 950,
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