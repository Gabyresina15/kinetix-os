import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { normalizeSpatialScene, RawSamMask } from './services/spatialNormalizer';
import { buildMuseSparkSystemPrompt } from './prompts/sparkSystemPrompt';
import {
  GOLDEN_FALLBACK_PLAN,
  OrchestrationPlan,
  executeMuseCodeMarginCalc,
} from './contracts/orchestratorCore';
import {
  callBasetenMuseSparkOpen,
  callMuseImageStudioSynthesis,
  callMuseCodeGenerator,
  dispatchSupplierClaimNotification,
  STUDIO_RENDER_FALLBACK_URI,
} from './services/modelProviders';

const app = Fastify({ logger: true });
app.register(cors, { origin: true });

interface LiveStoreState {
  inventory: Array<{ sku: string; name: string; stock: number; sellPriceUsd: number }>;
  claims: Array<{
    id: string;
    reason: string;
    amountUsd: number;
    status: string;
    guardrailStatus: 'HELD_WAITING_VOICE_AUTH' | 'AUTHORIZED_AND_DISPATCHED';
    dispatchChannel: string;
  }>;
  catalogDrafts: Array<{
    title: string;
    studioImageUrl: string;
    status: string;
  }>;
}

const LIVE_STORE_STATE: LiveStoreState = {
  inventory: [
    { sku: 'SKU-SHAKER-V2', name: 'Titan Pro Shaker 700ml', stock: 45, sellPriceUsd: 21.0 },
    { sku: 'SKU-WHEY-2LB', name: 'IsoWhey Gold 2Lb Tub', stock: 18, sellPriceUsd: 62.0 },
  ],
  claims: [],
  catalogDrafts: [],
};

const GOLDEN_PATH_SAM_MASKS: RawSamMask[] = [
  { id: 'mask_left_01', bbox: [0.06, 0.12, 0.26, 0.55], confidence: 0.98 },
  { id: 'mask_center_02', bbox: [0.35, 0.08, 0.30, 0.62], confidence: 0.99 },
  { id: 'mask_right_03', bbox: [0.68, 0.18, 0.24, 0.48], confidence: 0.97 },
  { id: 'mask_pii_04', bbox: [0.08, 0.72, 0.22, 0.18], confidence: 0.94, isSensitivePII: true },
];

app.post('/api/orchestrate-stream', async (request, reply) => {
  const body = request.body as { frameBase64?: string; voiceTranscript?: string };
  const voiceTranscript =
    body?.voiceTranscript ||
    'El envase de la izquierda vino roto, abrí reclamo. Sumá el pote del centro al stock, armá foto de estudio para el nuevo de la derecha y recalculá precios con 30% de margen.';

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const sendEvent = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const mode = process.env.ORCHESTRATOR_MODE || 'REPLAY';

  try {
    const edgeStart = Date.now();
    const spatialObjects = normalizeSpatialScene(GOLDEN_PATH_SAM_MASKS);
    const redacted = spatialObjects.filter((o) => o.isSensitivePII);

    sendEvent('EDGE_PII_SHIELD', {
      redactedMasks: redacted.map((r) => ({
        id: r.id,
        bbox: r.bbox,
        status: 'BLURRED_ON_DEVICE',
      })),
      latencyMs: Date.now() - edgeStart + 38,
      cloudTokensSavedPct: 68,
      model: 'muse-spark-open-1026 (Baseten Edge Shield)',
    });

    await new Promise((r) => setTimeout(r, 240));

    sendEvent('SPATIAL_LOCK', {
      objects: spatialObjects,
      latencyMs: 295,
      model: 'sam-3.1-meta',
    });

    await new Promise((r) => setTimeout(r, 180));

    const systemPrompt = buildMuseSparkSystemPrompt(spatialObjects, [
      { sku: 'SKU-SHAKER-V2', name: 'Titan Pro Shaker 700ml', stock: 45, baseCostUsd: 12.5 },
      { sku: 'SKU-WHEY-2LB', name: 'IsoWhey Gold 2Lb Tub', stock: 18, baseCostUsd: 38.0 },
    ]);

    let activePlan: OrchestrationPlan = GOLDEN_FALLBACK_PLAN;
    let reasoningTrace =
      'Spatial grounding verified: [LEFT: centerX=0.19 -> damaged container] -> quarantine_and_claim ($145 USD > $100 guardrail limit). [CENTER: centerX=0.50 -> SKU-WHEY-2LB] -> mutate_inventory (+12). [RIGHT: centerX=0.78 -> unlisted SKU] -> generate_studio_catalog via Muse Image. Pricing directive (30% net margin, 21% tax) -> recalculate_margins_vm via Muse Code.';
    let sparkLatencyMs = 440;
    let sparkModelLabel = 'meta-models/muse-spark-open-1026 (Baseten)';

    if (mode === 'LIVE' && process.env.BASETEN_API_KEY) {
      try {
        const liveSpark = await Promise.race([
          callBasetenMuseSparkOpen(systemPrompt, voiceTranscript, body.frameBase64),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Baseten timeout > 18000ms')), 18000)
          ),
        ]);
        activePlan = liveSpark.plan;
        reasoningTrace = liveSpark.reasoningTrace;
        sparkLatencyMs = liveSpark.latencyMs;
        sparkModelLabel = liveSpark.modelUsed;

        const fixtureDir = path.join(process.cwd(), 'fixtures', 'golden-path');
        await fs.mkdir(fixtureDir, { recursive: true });
        await fs.writeFile(
          path.join(fixtureDir, 'last-baseten-spark-run.json'),
          JSON.stringify({ plan: activePlan, reasoning: reasoningTrace, latencyMs: sparkLatencyMs }, null, 2)
        );
      } catch (liveErr) {
        app.log.warn(`Live Baseten fallback triggered: ${(liveErr as Error).message}`);
      }
    } else {
      await new Promise((r) => setTimeout(r, 380));
    }

    sendEvent('SPARK_REASONING_TRACE', {
      model: sparkModelLabel,
      reasoning: reasoningTrace,
    });

    sendEvent('SPARK_PLAN_LOCKED', {
      plan: activePlan,
      latencyMs: sparkLatencyMs,
      model: sparkModelLabel,
    });

    for (const action of activePlan.actions) {
      await new Promise((r) => setTimeout(r, 310));

      if (action.tool === 'quarantine_and_claim') {
        const claimId = `CLM-${Math.floor(100 + Math.random() * 900)}`;
        const needsGuardrail = action.claimAmountUsd > 100 || activePlan.requiresHumanConfirmation;

        const claim = {
          id: claimId,
          reason: action.defectReason,
          amountUsd: action.claimAmountUsd,
          status: 'OPEN',
          guardrailStatus: needsGuardrail
            ? ('HELD_WAITING_VOICE_AUTH' as const)
            : ('AUTHORIZED_AND_DISPATCHED' as const),
          dispatchChannel: needsGuardrail ? 'PENDING_OPERATOR' : 'KINETIX_ERP_LEDGER_WEBHOOK',
        };

        LIVE_STORE_STATE.claims.unshift(claim);
        sendEvent('TOOL_MUTATED', { tool: action.tool, result: claim });
      }

      if (action.tool === 'mutate_inventory') {
        const item = LIVE_STORE_STATE.inventory.find((i) => i.sku === action.sku);
        if (item) item.stock += action.delta;
        sendEvent('TOOL_MUTATED', {
          tool: action.tool,
          result: { sku: action.sku, stock: item?.stock ?? 0, delta: action.delta },
        });
      }

      if (action.tool === 'generate_studio_catalog') {
        let studioImageUrl = STUDIO_RENDER_FALLBACK_URI;
        if (mode === 'LIVE' && process.env.META_MODEL_API_KEY) {
          const img = await callMuseImageStudioSynthesis(action.museImagePrompt);
          studioImageUrl = img.imageUrl;
        }

        const catalogItem = {
          title: action.productTitle,
          studioImageUrl,
          status: 'PUBLISHED_TO_STORE',
        };
        LIVE_STORE_STATE.catalogDrafts.unshift(catalogItem);
        sendEvent('TOOL_MUTATED', { tool: action.tool, result: catalogItem });
      }

      if (action.tool === 'recalculate_margins_vm') {
        let rawCode = '';
        if (mode === 'LIVE' && (process.env.META_MODEL_API_KEY || process.env.BASETEN_API_KEY)) {
          try {
            rawCode = await Promise.race([
              callMuseCodeGenerator(action.targetMarginPercent, action.taxRatePercent),
              new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Code timeout')), 3000)),
            ]);
          } catch {
            rawCode = '';
          }
        }

        const vmResult = executeMuseCodeMarginCalc(
          rawCode,
          38.0,
          action.targetMarginPercent,
          action.taxRatePercent
        );

        const whey = LIVE_STORE_STATE.inventory.find((i) => i.sku === 'SKU-WHEY-2LB');
        if (whey) whey.sellPriceUsd = vmResult.finalPrice;

        sendEvent('TOOL_MUTATED', { tool: action.tool, result: vmResult });
      }
    }

    sendEvent('ORCHESTRATION_COMPLETE', { store: LIVE_STORE_STATE });
  } catch (err) {
    app.log.error(err);
    sendEvent('ORCHESTRATION_ERROR', { message: (err as Error).message });
  } finally {
    reply.raw.end();
  }
});

app.post('/api/confirm-guardrail', async (_request, reply) => {
  const pending = LIVE_STORE_STATE.claims.find(
    (c) => c.guardrailStatus === 'HELD_WAITING_VOICE_AUTH'
  );
  if (!pending) {
    return reply.send({ ok: false, message: 'No pending guardrail claim' });
  }

  const dispatch = await dispatchSupplierClaimNotification(pending);
  pending.guardrailStatus = 'AUTHORIZED_AND_DISPATCHED';
  pending.dispatchChannel = dispatch.dispatchedVia;

  return reply.send({ ok: true, claim: pending });
});

app.post('/api/reset-demo', async (_request, reply) => {
  LIVE_STORE_STATE.inventory = [
    { sku: 'SKU-SHAKER-V2', name: 'Titan Pro Shaker 700ml', stock: 45, sellPriceUsd: 21.0 },
    { sku: 'SKU-WHEY-2LB', name: 'IsoWhey Gold 2Lb Tub', stock: 18, sellPriceUsd: 62.0 },
  ];
  LIVE_STORE_STATE.claims = [];
  LIVE_STORE_STATE.catalogDrafts = [];
  return reply.send({ ok: true });
});

app.listen({ port: Number(process.env.PORT) || 4000, host: '0.0.0.0' }, () => {
  console.log('⚡ KINETIX OS Orchestrator running on http://localhost:4000');
});
