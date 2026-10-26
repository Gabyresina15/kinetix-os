import Fastify from 'fastify';
import cors from '@fastify/cors';
import { normalizeSpatialScene, RawSamMask } from './services/spatialNormalizer';
import { buildMuseSparkSystemPrompt } from './prompts/sparkSystemPrompt';
import {
  OrchestrationPlanSchema,
  executeMuseCodeMarginCalc,
} from './contracts/orchestratorCore';

const app = Fastify({ logger: true });
app.register(cors, { origin: '*' });

// Estado en memoria ultra-rápido para la demo (persiste mutaciones durante el video)
export const LIVE_STORE_STATE = {
  inventory: [
    { sku: 'SKU-SHAKER-V2', name: 'Titan Pro Shaker 700ml', stock: 45, baseCostUsd: 12.5, sellPriceUsd: 21.0 },
    { sku: 'SKU-WHEY-2LB', name: 'IsoWhey Gold 2Lb Tub', stock: 18, baseCostUsd: 38.0, sellPriceUsd: 62.0 },
  ],
  claims: [] as Array<{ id: string; maskId: string; reason: string; amountUsd: number; timestamp: string }>,
  catalogDrafts: [] as Array<{ id: string; title: string; studioImageUrl: string; status: string }>,
};

// Mock determinístico de las 4 máscaras de SAM 3.1 para tu mesa (Golden Path)
const GOLDEN_PATH_SAM_MASKS: RawSamMask[] = [
  {
    id: 'mask_left_01',
    bbox: [0.08, 0.25, 0.22, 0.45], // Izquierda -> Objeto dañado
    confidence: 0.98,
    svgPath: 'M 80 250 L 280 250 L 295 680 L 75 680 Z',
    cropBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
    detectedClassHint: 'container_damaged',
  },
  {
    id: 'mask_center_02',
    bbox: [0.38, 0.18, 0.24, 0.55], // Centro -> Pote grande sano
    confidence: 0.99,
    svgPath: 'M 380 180 L 620 180 L 620 730 L 380 730 Z',
    cropBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
    detectedClassHint: 'cylinder_tub',
  },
  {
    id: 'mask_right_03',
    bbox: [0.68, 0.28, 0.20, 0.42], // Derecha -> Producto nuevo para catálogo
    confidence: 0.97,
    svgPath: 'M 680 280 L 880 280 L 880 700 L 680 700 Z',
    cropBase64: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...',
    detectedClassHint: 'new_product_box',
  },
  {
    id: 'mask_Bottom_pii_04',
    bbox: [0.12, 0.76, 0.25, 0.18], // Abajo -> DNI / Tarjeta (Dispara el escudo de privacidad)
    confidence: 0.96,
    svgPath: 'M 120 760 L 370 760 L 370 940 L 120 940 Z',
    cropBase64: 'REDACTED_AT_EDGE',
    detectedClassHint: 'id_card',
  },
];

app.post('/api/orchestrate-stream', async (request, reply) => {
  // Configuramos cabeceras Server-Sent Events (SSE) para que la UI se ilumine en vivo
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
    // PASO 1: Normalización espacial de SAM 3.1 + Escudo PII con Muse Glimmer
    const normalizedObjects = normalizeSpatialScene(GOLDEN_PATH_SAM_MASKS);
    const piiObjects = normalizedObjects.filter((o) => o.isSensitivePII);

    sendEvent('EDGE_PII_SHIELD', {
      model: 'Muse Glimmer 30B (Fireworks Serverless Edge)',
      latencyMs: 38,
      redactedMasks: piiObjects.map((o) => ({ id: o.id, bbox: o.bbox, zone: o.zone })),
      cloudTokensSavedPct: 68,
    });

    await new Promise((r) => setTimeout(r, 320));

    // PASO 2: Bloqueo de máscaras espaciales (SAM 3.1) en pantalla
    sendEvent('SPATIAL_LOCK', {
      model: 'SAM 3.1 (Baseten GPU)',
      latencyMs: 310,
      objects: normalizedObjects,
    });

    await new Promise((r) => setTimeout(r, 450));

    // PASO 3: Muse Spark genera el Plan Agéntico validado con Zod
    const systemPrompt = buildMuseSparkSystemPrompt(normalizedObjects, LIVE_STORE_STATE.inventory);

    // Plan determinístico validado por nuestro esquema Zod
    const validatedPlan = OrchestrationPlanSchema.parse({
      summary: 'Executing 4 parallel spatial mutations across inventory, claims, studio catalog, and financial VM.',
      requiresHumanConfirmation: true,
      actions: [
        {
          tool: 'quarantine_and_claim',
          targetMaskId: 'mask_left_01',
          defectReason: 'Structural side dent detected on incoming lot',
          claimAmountUsd: 145.0,
        },
        {
          tool: 'mutate_inventory',
          targetMaskId: 'mask_center_02',
          sku: 'SKU-WHEY-2LB',
          delta: 12,
        },
        {
          tool: 'generate_studio_catalog',
          targetMaskId: 'mask_right_03',
          productTitle: 'Titan Micronized Creatine 500g - Black Series',
          museImagePrompt: 'Commercial studio product shot, matte black container, dark slate surface, cyan rim light',
        },
        {
          tool: 'recalculate_margins_vm',
          targetMarginPercent: 30,
          taxRatePercent: 21,
        },
      ],
    });

    sendEvent('SPARK_PLAN_LOCKED', {
      model: 'Muse Spark (Meta Model API)',
      latencyMs: 440,
      plan: validatedPlan,
      promptPreview: systemPrompt.slice(0, 280) + '...',
    });

    // PASO 4: Ejecución de las 4 herramientas con streaming de resultados individuales
    for (const action of validatedPlan.actions) {
      await new Promise((r) => setTimeout(r, 380));

      if (action.tool === 'quarantine_and_claim') {
        const claimRecord = {
          id: `CLM-${Math.floor(100 + Math.random() * 900)}`,
          maskId: action.targetMaskId,
          reason: action.defectReason,
          amountUsd: action.claimAmountUsd,
          timestamp: new Date().toISOString(),
        };
        LIVE_STORE_STATE.claims.unshift(claimRecord);
        sendEvent('TOOL_MUTATED', { tool: action.tool, status: 'QUARANTINED', result: claimRecord });
      }

      if (action.tool === 'mutate_inventory') {
        const item = LIVE_STORE_STATE.inventory.find((i) => i.sku === action.sku);
        if (item) item.stock += action.delta;
        sendEvent('TOOL_MUTATED', { tool: action.tool, status: 'STOCK_UPDATED', result: item });
      }

      if (action.tool === 'generate_studio_catalog') {
        const catalogCard = {
          id: `CAT-${Date.now().toString().slice(-4)}`,
          title: action.productTitle,
          modelUsed: 'Muse Image',
          studioImageUrl: '/assets/golden-path/studio-creatine-render.jpg',
          status: 'PUBLISHED_TO_STORE',
        };
        LIVE_STORE_STATE.catalogDrafts.unshift(catalogCard);
        sendEvent('TOOL_MUTATED', { tool: action.tool, status: 'STUDIO_RENDER_READY', result: catalogCard });
      }

      if (action.tool === 'recalculate_margins_vm') {
        const generatedCode = `function calculatePrice(cost, marginPct, taxPct) {
  const netMarginPrice = cost / (1 - (marginPct / 100));
  return netMarginPrice * (1 + (taxPct / 100));
}`;
        const vmResult = executeMuseCodeMarginCalc(
          generatedCode,
          38.0,
          action.targetMarginPercent,
          action.taxRatePercent
        );
        sendEvent('TOOL_MUTATED', {
          tool: action.tool,
          status: 'VM_EXECUTED',
          modelUsed: 'Muse Code (Node VM Sandbox)',
          result: vmResult,
        });
      }
    }

    sendEvent('ORCHESTRATION_COMPLETE', {
      totalElapsedMs: 1890,
      storeState: LIVE_STORE_STATE,
    });
  } catch (error) {
    sendEvent('ORCHESTRATION_ERROR', { message: (error as Error).message });
  } finally {
    reply.raw.end();
  }
});

app.listen({ port: 4000, host: '0.0.0.0' }, () => {
  console.log('⚡ KINETIX OS Orchestrator running on http://localhost:4000');
});
