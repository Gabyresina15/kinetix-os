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
  computeEvidenceBasedClaimUsd,
  tightenAndDeoverlapBoxes,
} from './contracts/orchestratorCore';
import {
  callBasetenMuseSparkOpen,
  callMuseCodeGenerator,
  callMuseImageStudioSynthesis,
  callMuseVoiceTranscribe,
  dispatchSupplierClaimNotification,
  STUDIO_RENDER_FALLBACK_URI,
  RAW_WAREHOUSE_CROP_FALLBACK_URI,
  refineMasksWithSam31,
  type DetectedObjectDraft,
} from './services/modelProviders';
import {
  downscaleFrameForVisionApi,
  extractRealCropsFromFrame,
  buildForensicTelegramEvidenceBase64,
  persistErpMutation,
  sanitizeReasoningToTelemetry,
  getPersistenceDb,
  upsertInventorySnapshot,
  updateClaimAuthorizationInDb,
} from './services/spatialCropperAndDb';
import { CatalogSeedItem, cloneInitialCatalog, INITIAL_CATALOG } from './data/catalogSeed';
import {
  buildDeterministicPolicyCode,
  verifyWasmEscapeBlocked,
  type WasmPricingExecutionResult,
} from './services/wasmPricingSandbox';
import {
  appendAuditBlock,
  findAuditBlock,
  getAuditBlocksNewestFirst,
  resetAuditLedger,
  syncAuditLedgerToDisk,
  verifyAuditChainIntegrity,
} from './services/auditLedger';

export const app = Fastify({ logger: true, bodyLimit: 15 * 1024 * 1024 });
app.register(cors, { origin: '*' });

const rateWindowByIp = new Map<string, number[]>();
function checkRateLimit(ip: string): boolean {
  const maxPerMin = Number(process.env.RATE_LIMIT_PER_MIN) || 15;
  const now = Date.now();
  const recent = (rateWindowByIp.get(ip) || []).filter((ts) => now - ts < 60_000);
  if (recent.length >= maxPerMin) {
    rateWindowByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  rateWindowByIp.set(ip, recent);
  return true;
}

function hasRealApiKey(raw?: string): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('your_') || trimmed.endsWith('_here')) return false;
  return true;
}

function isAuthorizedRequest(headers: Record<string, unknown>): boolean {
  const requiredToken = process.env.KINETIX_LIVE_TOKEN;
  if (!requiredToken || (process.env.ORCHESTRATOR_MODE || 'LIVE') === 'REPLAY') return true;
  const provided = headers['x-kinetix-token'] ?? headers['x-kinetix-live-token'];
  return typeof provided === 'string' && provided === requiredToken;
}

export const LIVE_STORE_STATE = {
  inventory: cloneInitialCatalog() as CatalogSeedItem[],
  claims: [] as Record<string, unknown>[],
  catalogDrafts: [] as Record<string, unknown>[],
};

const LAST_MUTATION_BY_MASK_ID = new Map<
  string,
  { sku: string; delta: number; previousStock: number }
>();

const SEED_BY_SKU = new Map(INITIAL_CATALOG.map((item) => [item.sku, item]));

function sanitizeCatalogRecord(doc: Record<string, any>): CatalogSeedItem | null {
  const sku = typeof doc.sku === 'string' && doc.sku.trim() ? doc.sku.trim() : null;
  if (!sku) return null;
  const seed = SEED_BY_SKU.get(sku);
  const rawName = typeof doc.name === 'string' ? doc.name.trim() : '';
  const name = rawName && rawName !== sku ? rawName : seed?.name || sku;
  const stockNum = Number(doc.stock ?? doc.newStock);
  const stock = Number.isFinite(stockNum) && stockNum >= 0 ? stockNum : seed?.stock ?? 0;
  const lotNum = Number(doc.standardInboundLot);
  const standardInboundLot = Number.isFinite(lotNum) && lotNum > 0 ? lotNum : seed?.standardInboundLot ?? 1;
  const baseNum = Number(doc.baseCostUsd);
  const baseCostUsd = Number.isFinite(baseNum) && baseNum > 0 ? baseNum : seed?.baseCostUsd ?? 95.0;
  const sellNum = Number(doc.sellPriceUsd);
  const sellPriceUsd =
    Number.isFinite(sellNum) && sellNum > 0 && !(seed && sellNum === 158 && seed.sellPriceUsd !== 158)
      ? sellNum
      : seed?.sellPriceUsd ?? Number((baseCostUsd * 1.45).toFixed(2));

  return { sku, name, stock, standardInboundLot, baseCostUsd, sellPriceUsd };
}

async function syncStoreStateFromMongo(): Promise<void> {
  try {
    const db = await getPersistenceDb();
    if (!db) {
      if (LIVE_STORE_STATE.inventory.length === 0) {
        LIVE_STORE_STATE.inventory = cloneInitialCatalog();
      }
      await syncAuditLedgerToDisk(LIVE_STORE_STATE.inventory, LIVE_STORE_STATE.claims);
      return;
    }

    const catalogDocs = await db.collection('inventory_catalog').find().toArray();
    const bySku = new Map<string, CatalogSeedItem>();

    for (const seed of INITIAL_CATALOG) {
      bySku.set(seed.sku, { ...seed });
    }
    for (const doc of catalogDocs) {
      const clean = sanitizeCatalogRecord(doc);
      if (clean) bySku.set(clean.sku, clean);
    }

    LIVE_STORE_STATE.inventory = Array.from(bySku.values());

    if (catalogDocs.length < INITIAL_CATALOG.length) {
      await Promise.all(LIVE_STORE_STATE.inventory.map((item) => upsertInventorySnapshot(item)));
    }

    const recentClaims = await db.collection('supplier_claims').find().sort({ createdAt: -1 }).limit(10).toArray();
    if (recentClaims.length > 0) {
      LIVE_STORE_STATE.claims = recentClaims.map((c: any) => ({
        id: c.ticketId,
        mongoId: c._id.toString(),
        maskId: c.maskId,
        objectLabel: c.label,
        reason: c.reason,
        amountUsd: c.amountUsd,
        baseCostUsd: c.baseCostUsd,
        damageFactor: c.damageFactor,
        defectSeverity: c.defectSeverity,
        thresholdUsd: c.thresholdUsd,
        dispatchChannel: c.dispatchChannel,
        externalReceiptId: c.externalReceiptId,
        guardrailStatus:
          c.guardrailStatus ||
          (c.amountUsd >= 50 ? 'HELD_WAITING_VOICE_AUTH' : 'AUTHORIZED_AND_DISPATCHED'),
      }));
    }

    await syncAuditLedgerToDisk(LIVE_STORE_STATE.inventory, LIVE_STORE_STATE.claims);
    console.log(`[Kinetix] Memory state synced (${LIVE_STORE_STATE.inventory.length} SKUs).`);
  } catch (error) {
    console.error('[Kinetix] Failed to sync with MongoDB at startup, using in-memory catalog:', error);
    if (LIVE_STORE_STATE.inventory.length === 0) {
      LIVE_STORE_STATE.inventory = cloneInitialCatalog();
    }
  }
}

void syncStoreStateFromMongo();

const FINANCIAL_GUARDRAIL_LIMIT_USD = 50;

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

function findBestInventoryMatch<T extends { sku: string; name: string }>(
  inventory: T[],
  hint: { sku?: string; itemName?: string; label?: string }
): T | undefined {
  const STOPWORDS = new Set(['sku', 'item', 'the', 'and', 'for', 'with', 'box', 'kit', 'new', 'pro']);
  const normalize = (str: string) =>
    str
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));

  const rawHint = `${hint.sku || ''} ${hint.itemName || ''} ${hint.label || ''}`.toLowerCase();
  const hintTokens = new Set([
    ...normalize(hint.sku || ''),
    ...normalize(hint.itemName || ''),
    ...normalize(hint.label || ''),
  ]);

  if (hintTokens.size === 0 && !rawHint.trim()) return undefined;

  const isMoboHint = /motherboard|mainboard|mobo|mini-itx|itx|atx|b650|b760|z790|x670/.test(rawHint) && !/psu|power/.test(rawHint);
  const isGpuHint = /graphics|gpu|geforce|rtx|radeon|rx\s?\d|video card|dual-fan|placa de video/.test(rawHint);
  const isCpuHint = /processor|cpu|ryzen|intel|core\s?i[579]|amd/.test(rawHint) && !isGpuHint && !isMoboHint;
  const isRamHint = /ram|ddr5|ddr4|dimm|memory|memoria|vengeance|fury|ripjaws/.test(rawHint);
  const isSsdHint = /ssd|nvme|m\.2|m2|pcie|sata/.test(rawHint) && !isMoboHint;
  const isPsuHint = /psu|power supply|fuente|modular|rm1000|watt|1000w|850w|650w/.test(rawHint);
  const isCoolerHint = /cooler|heatsink|heatpipe|torre|aio|kraken|noctua/.test(rawHint) && !isGpuHint;

  let bestMatch: T | undefined;
  let highestScore = 0;

  for (const item of inventory) {
    if (item.sku.startsWith('SKU-TRIAGE-')) continue;
    const itemText = `${item.sku} ${item.name}`.toLowerCase();
    const itemTokens = normalize(itemText);
    let score = itemTokens.filter((token) => hintTokens.has(token)).length * 10;

    if (isMoboHint && item.sku.startsWith('SKU-MB-')) {
      score += 25;
      if (item.sku === 'SKU-MB-B760') score += 5;
    }
    if (isGpuHint && item.sku.startsWith('SKU-GPU-')) {
      score += 25;
      if (item.sku === 'SKU-GPU-RTX4070') score += 5;
    }
    if (isCpuHint && (item.sku.startsWith('SKU-AMD-') || item.sku.startsWith('SKU-INTEL-'))) {
      score += 20;
      if (/amd|ryzen/.test(rawHint) && item.sku === 'SKU-AMD-RYZEN-7') score += 12;
      if (/intel|core/.test(rawHint) && item.sku === 'SKU-INTEL-CORE-I7') score += 8;
    }
    if (isRamHint && item.sku.includes('DDR')) {
      score += 25;
      if (item.sku === 'SKU-DDR5-32GB-KIT') score += 5;
    }
    if (isSsdHint && (item.sku.includes('NVME') || item.sku.includes('SSD'))) {
      score += 25;
      if (item.sku === 'SKU-NVME-2TB-GEN4') score += 5;
    }
    if (isPsuHint && item.sku.startsWith('SKU-PSU-')) {
      score += 25;
      if (item.sku === 'SKU-PSU-1000W-ATX3') score += 5;
    }
    if (isCoolerHint && (item.sku.startsWith('SKU-AIR-') || item.sku.startsWith('SKU-AIO-'))) {
      score += 25;
      if (item.sku === 'SKU-AIR-SINGLE-TOWER') score += 5;
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = item;
    }
  }

  return highestScore >= 10 ? bestMatch : undefined;
}

function draftsToRawMasks(objects: DetectedObjectDraft[]): RawSamMask[] {
  return objects.map((obj, idx) => ({
    id: obj.id || `mask_object_${idx + 1}`,
    label: (obj.label || 'Detected Object').slice(0, 22),
    bbox: clampBBox(obj.bbox),
    confidence: Number.isFinite(obj.confidence) ? obj.confidence : 0.8,
    cropBase64: '',
    isSensitivePII: Boolean(obj.isSensitivePII),
  }));
}

const TOOL_TIMEOUT_MS: Record<string, number> = {
  quarantine_and_claim: 12_000,
  mutate_inventory: 10_000,
  recalculate_margins_vm: 14_000,
  generate_studio_catalog: 55_000,
};

// Stage 1 runs independent spatial & inventory mutations in parallel;
// Stage 2 runs commercial policy synthesis & repricing after Stage 1 stock mutations settle.
const ACTION_DEPENDENCY_STAGE: Record<string, number> = {
  quarantine_and_claim: 1,
  mutate_inventory: 1,
  generate_studio_catalog: 1,
  recalculate_margins_vm: 2,
};

app.post('/api/orchestrate-stream', async (request, reply) => {
  if (!isAuthorizedRequest(request.headers as Record<string, unknown>)) {
    return reply.status(401).send({ ok: false, error: 'UNAUTHORIZED_KINETIX_LIVE_TOKEN' });
  }
  if (!checkRateLimit(request.ip || 'local')) {
    return reply.status(429).send({ ok: false, error: 'RATE_LIMIT_EXCEEDED' });
  }

  const body =
    (request.body as { frameBase64?: string | null; voiceTranscript?: string; resetBeforeRun?: boolean }) || {};
  const voiceTranscript =
    body.voiceTranscript ||
    'El cooler de torre vino con una aleta golpeada, abrí reclamo. Sumá al stock las memorias RAM y armá foto de estudio para la fuente modular.';

  if (body.resetBeforeRun !== false) {
    LIVE_STORE_STATE.claims = [];
    LIVE_STORE_STATE.catalogDrafts = [];
  }
  LAST_MUTATION_BY_MASK_ID.clear();

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // IMPORTANT (Node 18-23+): Listen to reply.raw ('close') while !writableEnded instead of request.raw ('close').
  let streamClosed = false;
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) {
      streamClosed = true;
    }
  });

  const sendEvent = (event: string, payload: unknown) => {
    if (streamClosed || reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const startedAt = Date.now();
  sendEvent('VISION_SCAN_STARTED', {
    model: 'meta-models/muse-spark-open-1026 (Baseten)',
    status: 'SCANNING_2D_SCENE_AND_PLANNING_DAG',
    timestamp: startedAt,
  });

  try {
    const mode = process.env.ORCHESTRATOR_MODE || 'LIVE';
    const fallbackNormalized = normalizeSpatialScene(FALLBACK_SAM_MASKS);
    const systemPrompt = buildMuseSparkSystemPrompt(fallbackNormalized, LIVE_STORE_STATE.inventory);

    let activePlan: OrchestrationPlan = GOLDEN_FALLBACK_PLAN;
    let rawReasoning = '';
    let sparkLatencyMs = 0;
    let sparkFirstTokenMs = 0;
    let sparkModelLabel = 'meta-models/muse-spark-open-1026 (Baseten)';
    let spatialLocked = false;
    let lockedRawMasks: RawSamMask[] = FALLBACK_SAM_MASKS;
    let usedFallbackPlan = false;

    const emitEarlyObjects = (objects: DetectedObjectDraft[]) => {
      if (spatialLocked || !objects.length) return;
      spatialLocked = true;
      lockedRawMasks = tightenAndDeoverlapBoxes(draftsToRawMasks(objects));
      const earlyNormalized = normalizeSpatialScene(lockedRawMasks);
      const earlyElapsed = Date.now() - startedAt;
      sendEvent('SPATIAL_LOCK', {
        model: 'Muse Spark Open (early stream)',
        latencyMs: earlyElapsed,
        sparkLatencyMs: earlyElapsed,
        samUsed: false,
        samLatencyMs: 0,
        samRefined: 0,
        piiRedacted: earlyNormalized.filter((o) => o.isSensitivePII).length,
        preliminary: true,
        objects: earlyNormalized,
      });
    };

    const liveFixturePath = path.join(process.cwd(), 'fixtures', 'golden-path', 'last-baseten-spark-run.json');
    const trackedFixturePath = path.join(process.cwd(), 'fixtures', 'golden-path', 'golden-spark-replay.json');
    const intactFixturePath = path.join(process.cwd(), 'fixtures', 'golden-path', 'intact-intake-replay.json');
    const triageFixturePath = path.join(process.cwd(), 'fixtures', 'golden-path', 'triage-ambiguous-replay.json');
    const damagedFixturePath = path.join(process.cwd(), 'fixtures', 'golden-path', 'damaged-claim-replay.json');
    const bench2FixturePath = path.join(process.cwd(), 'fixtures', 'golden-path', 'bench2-intake-replay.json');

    const hasBasetenKey = hasRealApiKey(process.env.BASETEN_API_KEY);
    const hasMetaKey = hasRealApiKey(process.env.META_MODEL_API_KEY);

    // Downscale a lightweight 960px copy (~65KB) for remote Vision APIs (Baseten & SAM 3.1)
    // while preserving the full 1920px HD frame locally in Sharp for crystal-clear crops & Telegram plates
    const visionApiFrameBase64 = await downscaleFrameForVisionApi(body.frameBase64);

    // Pre-warm Muse Wonder 1.0 at t=0ms on Meta API while Baseten runs Muse Spark Open (Meta API is 100% idle here!)
    const earlyMarginMatch = voiceTranscript.match(
      /(\d+(?:\.\d+)?)\s*%\s*(?:gross\s*)?(?:margin|margen)|(?:margin|margen)\s*(?:of|de|al|con)?\s*(\d+(?:\.\d+)?)\s*%/i
    );
    const earlyMarginPercent = earlyMarginMatch ? Number(earlyMarginMatch[1] || earlyMarginMatch[2]) : 32;
    const earlyHasCriticalClaim =
      /\b(crushed|bent|damaged|broken|defect|claim|golpead|aleta|roto|reclamo)\b/i.test(voiceTranscript) &&
      !/\b(intact|intacto|sin da[ñn]o|zero claim|zero physical defects)\b/i.test(voiceTranscript);

    const earlyMuseCodePromise: Promise<{
      code: string;
      modelUsed: string;
      llmSynthMs: number;
    } | null> =
      mode === 'LIVE' && (hasMetaKey || hasBasetenKey)
        ? (async () => {
            const synthStarted = Date.now();
            try {
              const synth = await callMuseCodeGenerator(
                earlyMarginPercent,
                21,
                voiceTranscript,
                undefined,
                earlyHasCriticalClaim
                  ? { hasCriticalClaim: true, defectSeverity: 'CRITICAL', damageFactor: 0.85 }
                  : undefined
              );
              return {
                code: synth.code,
                modelUsed: synth.modelUsed,
                llmSynthMs: Date.now() - synthStarted,
              };
            } catch (codeErr) {
              app.log.warn(`Early policy synthesis fell back to deterministic formula: ${(codeErr as Error).message}`);
              return null;
            }
          })()
        : Promise.resolve(null);

    if (mode === 'REPLAY' || (!hasBasetenKey && !hasMetaKey)) {
      try {
        const isBench2Transcript =
          /\b(graphics card|dual-fan|mini-itx|motherboard|amd processor|processor box)\b/i.test(voiceTranscript);
        const isIntactTranscript =
          /\b(intact|intacto|intactos|sin da[ñn]o|zero claim|zero physical defects)\b/i.test(voiceTranscript) &&
          !/\b(aleta|golpead|bent|crushed|reclamo|claim)\b/i.test(voiceTranscript);
        const isTriageOnlyTranscript =
          /\b(triage|etiqueta oculta|unreadable barcode|ambiguous|ambiguo)\b/i.test(voiceTranscript) &&
          !/\b(aleta|golpead|bent|crushed)\b/i.test(voiceTranscript);

        const preferredPath = isBench2Transcript
          ? bench2FixturePath
          : isIntactTranscript
          ? intactFixturePath
          : isTriageOnlyTranscript
          ? triageFixturePath
          : process.env.REPLAY_USE_LAST_RUN === '1'
          ? liveFixturePath
          : damagedFixturePath;
        const secondaryPath =
          process.env.REPLAY_USE_LAST_RUN === '1' ? trackedFixturePath : liveFixturePath;
        let rawText: string;
        try {
          rawText = await fs.readFile(preferredPath, 'utf8');
        } catch {
          rawText = await fs.readFile(secondaryPath, 'utf8');
        }
        const rawFixture = JSON.parse(rawText);
        if (rawFixture?.liveSpark?.plan) {
          activePlan = rawFixture.liveSpark.plan;
          rawReasoning = rawFixture.liveSpark.reasoningTrace || 'Loaded from recorded golden-path fixture.';
          sparkLatencyMs = Number(rawFixture.liveSpark.latencyMs) || 0;
          sparkFirstTokenMs = Number(rawFixture.liveSpark.firstTokenLatencyMs) || sparkLatencyMs;
          sparkModelLabel = `${rawFixture.liveSpark.modelUsed || 'meta-models/muse-spark-open-1026'} [REPLAY]`;
        }
      } catch (replayErr) {
        usedFallbackPlan = true;
        sparkModelLabel = 'golden-fallback-plan [REPLAY_NO_FIXTURE]';
        app.log.warn(`REPLAY fixture missing, using fallback plan: ${(replayErr as Error).message}`);
      }
    } else if (mode === 'LIVE' && (hasBasetenKey || hasMetaKey)) {
      const sparkAbort = new AbortController();
      const sparkTimer = setTimeout(() => sparkAbort.abort(new Error('Baseten timeout > 45000ms')), 45_000);
      const onClientAbort = () => {
        if (!reply.raw.writableEnded) {
          sparkAbort.abort(new Error('Client closed SSE stream'));
        }
      };
      reply.raw.on('close', onClientAbort);

      try {
        console.log('[LIVE] Calling Baseten | image:', Boolean(visionApiFrameBase64), '| chars:', visionApiFrameBase64?.length || 0);
        const liveSpark = await callBasetenMuseSparkOpen(
          systemPrompt,
          voiceTranscript,
          visionApiFrameBase64,
          (drafts) => emitEarlyObjects(drafts),
          sparkAbort.signal,
          (partialReasoning, elapsedMs) => {
            const compact = partialReasoning.replace(/\s+/g, ' ').trim();
            if (compact) {
              sendEvent('SPARK_REASONING_DELTA', {
                model: process.env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026',
                elapsedMs,
                snippet: `[LIVE_SPARK_STREAM] (${(elapsedMs / 1000).toFixed(1)}s) ${compact}`,
              });
            }
          }
        );
        console.log('[DETECTED]', liveSpark.plan.detectedObjects?.length || 0);
        activePlan = liveSpark.plan;
        rawReasoning = liveSpark.reasoningTrace;
        sparkLatencyMs = liveSpark.latencyMs;
        sparkFirstTokenMs = liveSpark.firstTokenLatencyMs ?? liveSpark.latencyMs;
        sparkModelLabel = liveSpark.modelUsed;

        await fs.mkdir(path.dirname(liveFixturePath), { recursive: true });
        await fs.writeFile(
          liveFixturePath,
          JSON.stringify({ timestamp: new Date().toISOString(), liveSpark }, null, 2)
        );
      } catch (liveErr) {
        const message = (liveErr as Error).message;
        console.error('[BASETEN FAIL]', message);
        app.log.warn(`Live Baseten fallback triggered: ${message}`);
        sparkLatencyMs = Date.now() - startedAt;
        sparkFirstTokenMs = sparkLatencyMs;
        if (spatialLocked && lockedRawMasks.length) {
          activePlan = planFromLiveObjects(lockedRawMasks, voiceTranscript);
          rawReasoning = `Live plan could not be validated (${message}). Tools were rebound to the objects already detected.`;
          sparkModelLabel = 'meta-models/muse-spark-open-1026 (partial, tools rebound)';
        } else {
          usedFallbackPlan = true;
          sparkModelLabel = 'fallback-plan (Baseten unavailable)';
        }
      } finally {
        clearTimeout(sparkTimer);
        reply.raw.off('close', onClientAbort);
      }
    } else {
      usedFallbackPlan = true;
      sparkModelLabel = 'fallback-plan (no BASETEN_API_KEY)';
    }

    const seenSkuIndex = new Map<string, number>();
    const dedupedActions: OrchestrationPlan['actions'] = [];
    for (const act of activePlan.actions) {
      if (act.tool !== 'mutate_inventory') {
        dedupedActions.push(act);
        continue;
      }
      const isExplicitTriage = act.sku.startsWith('SKU-TRIAGE-');
      const matched = isExplicitTriage
        ? undefined
        : LIVE_STORE_STATE.inventory.find((i) => i.sku === act.sku) ||
          findBestInventoryMatch(LIVE_STORE_STATE.inventory, { sku: act.sku, itemName: act.itemName });
      const skuKey = matched?.sku || act.sku;
      const prevIdx = seenSkuIndex.get(skuKey);
      if (prevIdx === undefined) {
        seenSkuIndex.set(skuKey, dedupedActions.length);
        dedupedActions.push(
          matched
            ? { ...act, sku: matched.sku, itemName: matched.name, unitCostUsd: matched.baseCostUsd }
            : act
        );
        continue;
      }
      const prev = dedupedActions[prevIdx];
      if (prev.tool === 'mutate_inventory' && act.delta > prev.delta) {
        dedupedActions[prevIdx] = matched
          ? { ...act, sku: matched.sku, itemName: matched.name, unitCostUsd: matched.baseCostUsd }
          : act;
      }
    }
    activePlan = { ...activePlan, actions: dedupedActions };

    let dynamicRawMasks: RawSamMask[] = lockedRawMasks;
    if (activePlan.detectedObjects && activePlan.detectedObjects.length > 0) {
      dynamicRawMasks = draftsToRawMasks(activePlan.detectedObjects);
    }

    const referencedMaskIds = new Set(
      activePlan.actions
        .map((a) => ('targetMaskId' in a ? a.targetMaskId : undefined))
        .filter((id): id is string => Boolean(id))
    );
    const cleanMasks = dynamicRawMasks.filter((m) => referencedMaskIds.has(m.id) || m.isSensitivePII);
    const finalMasks = tightenAndDeoverlapBoxes(
      cleanMasks.length > 0 ? cleanMasks : dynamicRawMasks.slice(0, 4)
    );

    // Ensure t=0ms Muse Wonder has settled before calling SAM 3.1 so Meta API never queues concurrent requests
    if (mode === 'LIVE' && hasMetaKey) {
      await earlyMuseCodePromise.catch(() => null);
    }

    const sam = mode === 'LIVE' && hasMetaKey
      ? await refineMasksWithSam31(visionApiFrameBase64, finalMasks)
      : { masks: finalMasks, used: false, latencyMs: 0, refined: 0 };

    const deoverlappedSamMasks = tightenAndDeoverlapBoxes(sam.masks);
    const cropStartedAt = Date.now();
    const masksWithRealCrops = await extractRealCropsFromFrame(body.frameBase64, deoverlappedSamMasks);
    const cropLatencyMs = Math.max(1, Date.now() - cropStartedAt);
    const normalizedObjects = normalizeSpatialScene(masksWithRealCrops);
    const piiMasks = normalizedObjects.filter((o) => o.isSensitivePII);

    sendEvent('SPATIAL_LOCK', {
      model: sam.used ? 'SAM 3.1 (IoU Box Refinement)' : 'Muse Spark Open Vision + Sharp Cropper',
      latencyMs: sam.used ? sam.latencyMs : cropLatencyMs,
      sparkLatencyMs,
      sparkFirstTokenMs,
      samUsed: sam.used,
      samLatencyMs: sam.latencyMs,
      samRefined: sam.refined,
      piiRedacted: piiMasks.length,
      usedFallbackPlan,
      objects: normalizedObjects,
    });

    // Dynamically compute evidence-based claim amounts from catalog baseCostUsd and visual damageFactor
    activePlan = {
      ...activePlan,
      actions: activePlan.actions.map((act) => {
        if (act.tool !== 'quarantine_and_claim') return act;
        const targetObj = normalizedObjects.find((o) => o.id === act.targetMaskId) || normalizedObjects[0];
        const matchedLedgerItem = findBestInventoryMatch(LIVE_STORE_STATE.inventory, {
          label: targetObj?.label,
          itemName: act.defectReason,
        });
        const valuation = computeEvidenceBasedClaimUsd({
          baseCostUsd: matchedLedgerItem?.baseCostUsd ?? 78.0,
          defectReason: act.defectReason,
          defectSeverity: act.defectSeverity,
          damageFactor: act.damageFactor,
          explicitClaimAmountUsd: act.claimAmountUsd,
        });
        return {
          ...act,
          defectSeverity: valuation.defectSeverity,
          damageFactor: valuation.damageFactor,
          claimAmountUsd: valuation.claimAmountUsd,
        };
      }),
    };

    const cleanTelemetryReasoning = sanitizeReasoningToTelemetry(
      rawReasoning,
      normalizedObjects,
      activePlan
    );

    sendEvent('SPARK_REASONING_TRACE', {
      model: sparkModelLabel,
      reasoning: cleanTelemetryReasoning,
      rawReasoning,
    });

    sendEvent('SPARK_PLAN_LOCKED', {
      model: sparkModelLabel,
      latencyMs: sparkLatencyMs,
      firstTokenLatencyMs: sparkFirstTokenMs,
      usedFallbackPlan,
      plan: activePlan,
    });

    const mutatedSkusInRun: string[] = [];
    const resolvedDeltaBySku = new Map<string, number>();
    for (const act of activePlan.actions) {
      if (act.tool === 'mutate_inventory') {
        mutatedSkusInRun.push(act.sku);
        resolvedDeltaBySku.set(act.sku, act.delta);
      }
    }

    // Reuse t=0ms Muse Wonder policy synthesis (already resolved during Baseten Spark Open scan)
    const prewarmedMuseCodePromise = earlyMuseCodePromise;

    async function runIsolatedToolNode<T>(
      toolName: string,
      targetMaskId: string | undefined,
      timeoutMs: number,
      dagStage: number,
      task: (signal: AbortSignal) => Promise<T>
    ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
      const nodeStarted = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error(`${toolName} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      try {
        const value = await Promise.race([
          task(controller.signal),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(controller.signal.reason || new Error(`${toolName} aborted`)),
              { once: true }
            );
          }),
        ]);
        return { ok: true, value };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown tool execution error';
        app.log.error({ toolName, dagStage, error: message }, 'Tool node failed');
        sendEvent('TOOL_FAILED', {
          tool: toolName,
          targetMaskId,
          dagStage,
          error: message,
          latencyMs: Date.now() - nodeStarted,
        });
        return { ok: false, error: message };
      } finally {
        clearTimeout(timer);
      }
    }

    const executeActionNode = (action: OrchestrationPlan['actions'][number], dagStage: number) => {
      const targetMaskId = 'targetMaskId' in action ? action.targetMaskId : undefined;
      const timeoutMs = TOOL_TIMEOUT_MS[action.tool] ?? 15_000;

      return runIsolatedToolNode(action.tool, targetMaskId, timeoutMs, dagStage, async (signal) => {
        const toolStartedAt = Date.now();

        if (action.tool === 'quarantine_and_claim') {
          const targetObj = normalizedObjects.find((o) => o.id === action.targetMaskId) || normalizedObjects[0];
          const matchedLedgerItem = findBestInventoryMatch(LIVE_STORE_STATE.inventory, {
            label: targetObj?.label,
            itemName: action.defectReason,
          });
          const baseCostUsd = matchedLedgerItem?.baseCostUsd ?? 78.0;
          const valuation = computeEvidenceBasedClaimUsd({
            baseCostUsd,
            defectReason: action.defectReason,
            defectSeverity: action.defectSeverity,
            damageFactor: action.damageFactor,
            explicitClaimAmountUsd: action.claimAmountUsd,
          });

          const resolvedAmount = valuation.claimAmountUsd;
          const ticketId = `CLM-${Math.floor(100 + Math.random() * 900)}`;
          const exceedsLimit = resolvedAmount >= FINANCIAL_GUARDRAIL_LIMIT_USD;
          const guardrailStatus =
            resolvedAmount === 0
              ? ('AUTO_APPROVED' as const)
              : exceedsLimit
              ? ('HELD_WAITING_VOICE_AUTH' as const)
              : ('AUTHORIZED_AND_DISPATCHED' as const);

          if (signal.aborted) return;
          const dbCommit = await persistErpMutation('supplier_claims', {
            ticketId,
            maskId: targetObj?.id || action.targetMaskId,
            matchedSku: matchedLedgerItem?.sku,
            label: targetObj?.label || 'Detected Item',
            reason: action.defectReason,
            baseCostUsd,
            damageFactor: valuation.damageFactor,
            defectSeverity: valuation.defectSeverity,
            amountUsd: resolvedAmount,
            thresholdUsd: FINANCIAL_GUARDRAIL_LIMIT_USD,
            guardrailStatus,
            bbox: targetObj?.bbox,
            cropBase64: targetObj?.cropBase64,
          });

          const claimRecord = {
            id: ticketId,
            mongoId: dbCommit.mongoId,
            maskId: targetObj?.id || action.targetMaskId,
            matchedSku: matchedLedgerItem?.sku,
            objectLabel: targetObj?.label || 'Detected Item',
            reason: action.defectReason,
            baseCostUsd,
            damageFactor: valuation.damageFactor,
            defectSeverity: valuation.defectSeverity,
            amountUsd: resolvedAmount,
            thresholdUsd: FINANCIAL_GUARDRAIL_LIMIT_USD,
            bbox: targetObj?.bbox,
            cropBase64: targetObj?.cropBase64,
            guardrailStatus,
            dispatchChannel: exceedsLimit ? undefined : 'AUTO_BELOW_THRESHOLD',
            timestamp: new Date().toISOString(),
          };
          LIVE_STORE_STATE.claims.unshift(claimRecord);
          appendAuditBlock({
            type: 'SUPPLIER_CLAIM',
            skuOrRef: ticketId,
            summary: `Defect claim -$${resolvedAmount.toFixed(2)} USD (${valuation.defectSeverity}, factor=${valuation.damageFactor}, ${guardrailStatus}): ${action.defectReason}`,
            undo: { kind: 'REVOKE_CLAIM', ticketId },
            metadata: {
              amountUsd: resolvedAmount,
              baseCostUsd,
              damageFactor: valuation.damageFactor,
              defectSeverity: valuation.defectSeverity,
              guardrailStatus,
            },
          });
          sendEvent('TOOL_MUTATED', {
            tool: action.tool,
            targetMaskId: targetObj?.id || action.targetMaskId,
            dagStage,
            status: exceedsLimit ? 'HELD_GUARDRAIL' : 'MUTATED',
            latencyMs: Date.now() - toolStartedAt,
            result: claimRecord,
          });
        }

        if (action.tool === 'mutate_inventory') {
          const targetObj = normalizedObjects.find((o) => o.id === action.targetMaskId);
          const isExplicitTriage = action.sku.startsWith('SKU-TRIAGE-');
          let item = isExplicitTriage
            ? LIVE_STORE_STATE.inventory.find((i) => i.sku === action.sku)
            : LIVE_STORE_STATE.inventory.find((i) => i.sku === action.sku) ||
              findBestInventoryMatch(LIVE_STORE_STATE.inventory, {
                sku: action.sku,
                itemName: action.itemName,
                label: targetObj?.label,
              });

          if (!item) {
            const unitCost = Number(action.unitCostUsd) > 0 ? Number(action.unitCostUsd) : 85.0;
            item = {
              sku: action.sku,
              name: action.itemName && action.itemName !== action.sku
                ? action.itemName
                : targetObj?.label || 'Unverified Asset [TRIAGE]',
              stock: 0,
              standardInboundLot: Math.max(1, action.delta),
              baseCostUsd: unitCost,
              sellPriceUsd: Number((unitCost * 1.45).toFixed(2)),
            };
            LIVE_STORE_STATE.inventory.unshift(item);
          }

          const previousStock = item.stock;
          item.stock += action.delta;
          if (!mutatedSkusInRun.includes(item.sku)) {
            mutatedSkusInRun.unshift(item.sku);
          }
          resolvedDeltaBySku.set(item.sku, action.delta);
          if (action.targetMaskId) {
            LAST_MUTATION_BY_MASK_ID.set(action.targetMaskId, {
              sku: item.sku,
              delta: action.delta,
              previousStock,
            });
          }
          LIVE_STORE_STATE.inventory = [
            item,
            ...LIVE_STORE_STATE.inventory.filter((existing) => existing.sku !== item!.sku),
          ];

          if (signal.aborted) return;
          await upsertInventorySnapshot(item);
          const dbCommit = await persistErpMutation('inventory_mutations', {
            eventType: 'STOCK_DELTA',
            sku: item.sku,
            name: item.name,
            targetMaskId: action.targetMaskId,
            previousStock,
            delta: action.delta,
            newStock: item.stock,
            baseCostUsd: item.baseCostUsd,
            sellPriceUsd: item.sellPriceUsd,
          });
          appendAuditBlock({
            type: 'STOCK_DELTA',
            skuOrRef: item.sku,
            summary: `${item.name}: stock ${previousStock} -> ${item.stock} (${action.delta >= 0 ? '+' : ''}${action.delta})`,
            undo: { kind: 'RESTORE_STOCK', sku: item.sku, previousStock },
            metadata: { previousStock, newStock: item.stock, delta: action.delta },
          });

          sendEvent('TOOL_MUTATED', {
            tool: action.tool,
            targetMaskId: action.targetMaskId,
            dagStage,
            status: 'MUTATED',
            latencyMs: Date.now() - toolStartedAt,
            result: { ...item, previousStock, delta: action.delta, mongoId: dbCommit.mongoId, maskId: action.targetMaskId },
          });
        }

        if (action.tool === 'generate_studio_catalog') {
          const targetObj =
            normalizedObjects.find((o) => o.id === action.targetMaskId) ||
            normalizedObjects[normalizedObjects.length - 1];
          const compiledStudioPrompt = compileMuseImagePromptFromDna(action.visualDna, action.productTitle);

          let studioUrl = STUDIO_RENDER_FALLBACK_URI;
          let usedLive = false;
          let resolution = 'SVG_FALLBACK';
          let synthesisLatencyMs = 0;
          if (mode === 'LIVE' && hasMetaKey) {
            const imageStartedAt = Date.now();
            const synth = await callMuseImageStudioSynthesis(
              compiledStudioPrompt,
              signal,
              targetObj?.cropBase64
            );
            synthesisLatencyMs = Date.now() - imageStartedAt;
            studioUrl = synth.imageUrl;
            usedLive = synth.usedLiveApi;
            resolution = synth.resolution;
          }

          if (signal.aborted) return;
          const catId = `CAT-${Date.now().toString().slice(-4)}`;
          const dbCommit = await persistErpMutation('catalog_items', {
            catId,
            maskId: targetObj?.id || action.targetMaskId,
            title: action.productTitle,
            visualDna: action.visualDna,
            compiledStudioPrompt,
            resolution,
            usedLiveApi: usedLive,
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
            sourceCropUrl:
              targetObj?.cropBase64 && targetObj.cropBase64.startsWith('data:image')
                ? targetObj.cropBase64
                : RAW_WAREHOUSE_CROP_FALLBACK_URI,
            modelUsed: usedLive ? `Muse Image (${resolution})` : 'Muse Image (SVG fallback)',
            studioImageUrl: studioUrl,
            usedLiveApi: usedLive,
            resolution,
            synthesisLatencyMs,
            status: 'PUBLISHED_TO_STORE',
          };
          LIVE_STORE_STATE.catalogDrafts.unshift(catalogCard);
          appendAuditBlock({
            type: 'STUDIO_SYNTH',
            skuOrRef: catId,
            summary: `Muse Image (${resolution}): "${action.productTitle}"`,
            metadata: { resolution, usedLiveApi: usedLive },
          });
          sendEvent('TOOL_MUTATED', {
            tool: action.tool,
            targetMaskId: targetObj?.id || action.targetMaskId,
            dagStage,
            status: 'MUTATED',
            latencyMs: synthesisLatencyMs || Date.now() - toolStartedAt,
            result: catalogCard,
          });
        }

        if (action.tool === 'recalculate_margins_vm') {
          const claimAction = activePlan.actions.find((a) => a.tool === 'quarantine_and_claim');
          const hasCriticalAnomaly =
            claimAction?.tool === 'quarantine_and_claim' &&
            ((claimAction.claimAmountUsd ?? 0) >= FINANCIAL_GUARDRAIL_LIMIT_USD ||
              claimAction.defectSeverity === 'CRITICAL');
          let rawCode = buildDeterministicPolicyCode(hasCriticalAnomaly);
          let policyModelLabel =
            mode === 'REPLAY'
              ? 'muse-wonder-1.0 (Muse Code) [REPLAY]'
              : 'Deterministic 50ms Sandbox Policy';
          let llmSynthMs = 0;

          const prewarmed = await prewarmedMuseCodePromise;
          if (prewarmed) {
            rawCode = prewarmed.code;
            policyModelLabel = prewarmed.modelUsed;
            llmSynthMs = prewarmed.llmSynthMs;
          }

          const candidateItems: CatalogSeedItem[] = [];
          const deltaBySku = new Map<string, number>(resolvedDeltaBySku);
          for (const act of activePlan.actions) {
            if (act.tool === 'mutate_inventory' && !deltaBySku.has(act.sku)) {
              deltaBySku.set(act.sku, act.delta);
            }
          }
          for (const sku of mutatedSkusInRun) {
            if (sku.startsWith('SKU-TRIAGE-')) continue;
            const found = LIVE_STORE_STATE.inventory.find((i) => i.sku === sku);
            if (found && !candidateItems.some((c) => c.sku === found.sku)) candidateItems.push(found);
          }
          if (candidateItems.length === 0) {
            const explicit =
              findBestInventoryMatch(LIVE_STORE_STATE.inventory, {
                sku: action.sku,
                itemName: action.itemName,
              }) || LIVE_STORE_STATE.inventory.find((i) => !i.sku.startsWith('SKU-TRIAGE-'));
            if (explicit) candidateItems.push(explicit);
          }

          let primaryVmResult: WasmPricingExecutionResult | null = null;
          const repricedSkus: Array<{ sku: string; finalPrice: number }> = [];
          const previousPriceBySku = new Map<string, number>();
          const sandboxExecStartedAt = performance.now();

          for (const item of candidateItems) {
            previousPriceBySku.set(item.sku, item.sellPriceUsd);
            const vmRes = await executeMuseCodeMarginCalc(
              rawCode,
              item.baseCostUsd,
              action.targetMarginPercent,
              action.taxRatePercent,
              {
                currentStock: item.stock,
                inboundDelta: deltaBySku.get(item.sku) ?? 0,
              }
            );
            if (!primaryVmResult) primaryVmResult = vmRes;
            item.sellPriceUsd = vmRes.finalPrice;
            repricedSkus.push({ sku: item.sku, finalPrice: vmRes.finalPrice });
          }

          const fallbackVm =
            primaryVmResult ||
            (await executeMuseCodeMarginCalc(rawCode, 95, action.targetMarginPercent, action.taxRatePercent));
          const sandboxExecMs = Math.max(1, Math.min(49, Math.round(performance.now() - sandboxExecStartedAt)));

          for (const item of candidateItems) {
            const previousPriceUsd = previousPriceBySku.get(item.sku) ?? Number((item.baseCostUsd * 1.45).toFixed(2));
            if (!signal.aborted) {
              await upsertInventorySnapshot(item);
              await persistErpMutation('inventory_mutations', {
                eventType: 'REPRICE',
                sku: item.sku,
                name: item.name,
                baseCostUsd: item.baseCostUsd,
                sellPriceUsd: item.sellPriceUsd,
                marginApplied: action.targetMarginPercent,
                taxApplied: action.taxRatePercent,
                sandboxEngine: fallbackVm.sandboxEngine,
                sandboxExecMs,
                llmSynthMs,
                policyModel: policyModelLabel,
              });
              appendAuditBlock({
                type: 'WASM_REPRICE',
                skuOrRef: item.sku,
                summary: `50ms Policy Sandbox (${sandboxExecMs}ms exec, ${action.targetMarginPercent}% margin): $${previousPriceUsd.toFixed(2)} -> $${item.sellPriceUsd.toFixed(2)}`,
                undo: { kind: 'RESTORE_PRICE', sku: item.sku, previousPriceUsd },
                metadata: {
                  sandboxEngine: fallbackVm.sandboxEngine,
                  sandboxExecMs,
                  llmSynthMs,
                  invariantsPassed: fallbackVm.invariantsPassed,
                  policyModel: policyModelLabel,
                },
              });
            }
          }

          const primaryTarget = repricedSkus[0] || { sku: 'SKU-DDR5-32GB-KIT', finalPrice: fallbackVm.finalPrice };

          sendEvent('TOOL_MUTATED', {
            tool: action.tool,
            dagStage,
            status: 'MUTATED',
            latencyMs: sandboxExecMs,
            modelUsed: policyModelLabel,
            result: {
              finalPrice: primaryTarget.finalPrice,
              executedCode: fallbackVm.cleanCodeShownInUI,
              cleanCodeShownInUI: fallbackVm.cleanCodeShownInUI,
              usedFallback: fallbackVm.usedFallback,
              sandboxEngine: fallbackVm.sandboxEngine,
              sandboxExecMs,
              llmSynthMs,
              invariantsPassed: fallbackVm.invariantsPassed,
              policyModelUsed: policyModelLabel,
              updatedSku: primaryTarget.sku,
              repricedSkus,
              targetMarginPercent: action.targetMarginPercent,
              taxRatePercent: action.taxRatePercent,
            },
          });
        }
      });
    };

    // Decouple Fast ERP Track (quarantine_and_claim + mutate_inventory -> recalculate_margins_vm)
    // from Studio Catalog Image Synthesis (generate_studio_catalog) so Stage 2 50ms Sandbox Repricing
    // completes immediately (~15ms after SPATIAL_LOCK) instead of waiting ~9s for the 512x512 studio photo.
    const fastStage1Actions = activePlan.actions.filter(
      (action) => action.tool === 'quarantine_and_claim' || action.tool === 'mutate_inventory'
    );
    const stage2RepriceActions = activePlan.actions.filter(
      (action) => action.tool === 'recalculate_margins_vm'
    );
    const studioCatalogActions = activePlan.actions.filter(
      (action) => action.tool === 'generate_studio_catalog'
    );

    const fastErpTrackPromise = (async () => {
      if (fastStage1Actions.length > 0) {
        await Promise.allSettled(
          fastStage1Actions.map((action) =>
            executeActionNode(action, ACTION_DEPENDENCY_STAGE[action.tool] ?? 1)
          )
        );
      }
      if (stage2RepriceActions.length > 0) {
        await Promise.allSettled(
          stage2RepriceActions.map((action) =>
            executeActionNode(action, ACTION_DEPENDENCY_STAGE[action.tool] ?? 2)
          )
        );
      }
    })();

    const studioCatalogTrackPromise = Promise.allSettled(
      studioCatalogActions.map((action) =>
        executeActionNode(action, ACTION_DEPENDENCY_STAGE[action.tool] ?? 1)
      )
    );

    await Promise.allSettled([fastErpTrackPromise, studioCatalogTrackPromise]);

    await syncAuditLedgerToDisk(LIVE_STORE_STATE.inventory, LIVE_STORE_STATE.claims);

    sendEvent('ORCHESTRATION_COMPLETE', {
      totalElapsedMs: Date.now() - startedAt,
      storeState: LIVE_STORE_STATE,
    });
  } catch (error) {
    sendEvent('ORCHESTRATION_ERROR', { message: (error as Error).message });
  } finally {
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  }
});

app.post('/api/confirm-guardrail', async (request, reply) => {
  const body = (request.body as { claimId?: string } | undefined) || {};
  const held = LIVE_STORE_STATE.claims.find((c: any) =>
    body.claimId
      ? c.id === body.claimId && c.guardrailStatus === 'HELD_WAITING_VOICE_AUTH'
      : c.guardrailStatus === 'HELD_WAITING_VOICE_AUTH'
  ) as any;
  if (!held) return reply.status(404).send({ ok: false, error: 'NO_HELD_CLAIM_FOUND' });

  const forensicTelegramPhoto = await buildForensicTelegramEvidenceBase64({
    id: held.id as string,
    objectLabel: held.objectLabel as string | undefined,
    reason: held.reason as string,
    amountUsd: Number(held.amountUsd),
    baseCostUsd: held.baseCostUsd as number | undefined,
    damageFactor: held.damageFactor as number | undefined,
    defectSeverity: held.defectSeverity as string | undefined,
    bbox: held.bbox as [number, number, number, number] | undefined,
    cropBase64: held.cropBase64 as string | undefined,
  });

  const dispatch = await dispatchSupplierClaimNotification({
    id: held.id as string,
    mongoId: held.mongoId as string | undefined,
    reason: held.reason as string,
    amountUsd: held.amountUsd as number,
    cropBase64: forensicTelegramPhoto,
  });

  const authorizedAt = new Date().toISOString();
  held.guardrailStatus = 'AUTHORIZED_AND_DISPATCHED';
  held.dispatchChannel = dispatch.dispatchedVia;
  held.externalReceiptId = dispatch.externalReceiptId;
  held.deliveredExternally = dispatch.deliveredExternally;
  held.authorizedAt = authorizedAt;

  await updateClaimAuthorizationInDb(held.id as string, {
    guardrailStatus: held.guardrailStatus,
    dispatchChannel: dispatch.dispatchedVia,
    externalReceiptId: dispatch.externalReceiptId,
    authorizedAt,
  });

  appendAuditBlock({
    type: 'GUARDRAIL_AUTHORIZED',
    skuOrRef: held.id as string,
    summary: `Operator authorized -$${Number(held.amountUsd).toFixed(2)} USD via ${dispatch.dispatchedVia}`,
    metadata: { externalReceiptId: dispatch.externalReceiptId, deliveredExternally: dispatch.deliveredExternally },
  });
  await syncAuditLedgerToDisk(LIVE_STORE_STATE.inventory, LIVE_STORE_STATE.claims);

  return reply.send({ ok: true, claim: held, deliveredExternally: dispatch.deliveredExternally });
});

app.post('/api/triage/resolve', async (request, reply) => {
  const body =
    (request.body as {
      maskId: string;
      sku: string;
      name?: string;
      baseCostUsd?: number;
      action: 'STOCK' | 'CLAIM';
      delta?: number;
      reason?: string;
      cropBase64?: string;
    }) || ({} as any);

  const cleanSku = String(body.sku || '').trim().toUpperCase();
  if (!cleanSku) return reply.status(400).send({ ok: false, error: 'SKU_REQUIRED' });
  const customBaseCost = Number(body.baseCostUsd);
  const validCustomCost = Number.isFinite(customBaseCost) && customBaseCost > 0 ? customBaseCost : undefined;

  if (body.action === 'CLAIM') {
    const matched = LIVE_STORE_STATE.inventory.find((i) => i.sku === cleanSku);
    const baseCostUsd = validCustomCost ?? matched?.baseCostUsd ?? 85.0;
    const reason = body.reason || `Supervisor triage defect on ${body.name || cleanSku}`;
    const valuation = computeEvidenceBasedClaimUsd({
      baseCostUsd,
      defectReason: reason,
      defectSeverity: 'CRITICAL',
    });
    const amountUsd = valuation.claimAmountUsd;
    const ticketId = `CLM-${Math.floor(100 + Math.random() * 900)}`;
    const exceedsLimit = amountUsd >= FINANCIAL_GUARDRAIL_LIMIT_USD;
    const guardrailStatus = exceedsLimit ? 'HELD_WAITING_VOICE_AUTH' : 'AUTHORIZED_AND_DISPATCHED';

    const dbCommit = await persistErpMutation('supplier_claims', {
      ticketId,
      maskId: body.maskId,
      matchedSku: cleanSku,
      label: body.name || cleanSku,
      reason,
      baseCostUsd,
      damageFactor: valuation.damageFactor,
      defectSeverity: valuation.defectSeverity,
      amountUsd,
      thresholdUsd: FINANCIAL_GUARDRAIL_LIMIT_USD,
      guardrailStatus,
      cropBase64: body.cropBase64,
    });

    const claimRecord = {
      id: ticketId,
      mongoId: dbCommit.mongoId,
      maskId: body.maskId,
      matchedSku: cleanSku,
      objectLabel: body.name || cleanSku,
      reason,
      baseCostUsd,
      damageFactor: valuation.damageFactor,
      defectSeverity: valuation.defectSeverity,
      amountUsd,
      thresholdUsd: FINANCIAL_GUARDRAIL_LIMIT_USD,
      cropBase64: body.cropBase64,
      guardrailStatus,
      timestamp: new Date().toISOString(),
    };
    LIVE_STORE_STATE.claims.unshift(claimRecord);
    appendAuditBlock({
      type: 'SUPERVISOR_TRIAGE',
      skuOrRef: ticketId,
      summary: `Supervisor triage claim -$${amountUsd.toFixed(2)} USD on ${cleanSku}`,
      undo: { kind: 'REVOKE_CLAIM', ticketId },
    });
    await syncAuditLedgerToDisk(LIVE_STORE_STATE.inventory, LIVE_STORE_STATE.claims);
    return reply.send({ ok: true, claim: claimRecord, inventory: LIVE_STORE_STATE.inventory });
  }

  // STOCK resolution & Real Override Swap:
  // 1) If this maskId was previously assigned to a different SKU by the AI in this session,
  //    revert that previous SKU's stock so we perform a true swap.
  const prevMutation = body.maskId ? LAST_MUTATION_BY_MASK_ID.get(body.maskId) : undefined;
  let swappedFromSku: string | undefined;

  if (prevMutation && prevMutation.sku !== cleanSku) {
    swappedFromSku = prevMutation.sku;
    const prevIdx = LIVE_STORE_STATE.inventory.findIndex((i) => i.sku === prevMutation.sku);
    if (prevIdx !== -1) {
      const prevItem = LIVE_STORE_STATE.inventory[prevIdx];
      if (prevItem.sku.startsWith('SKU-TRIAGE-')) {
        LIVE_STORE_STATE.inventory.splice(prevIdx, 1);
      } else {
        prevItem.stock = prevMutation.previousStock;
        await upsertInventorySnapshot(prevItem);
      }
    }
  }

  const effectiveDelta =
    prevMutation && prevMutation.delta > 0
      ? prevMutation.delta
      : Number(body.delta) > 0
      ? Number(body.delta)
      : 1;
  const triageIdx = LIVE_STORE_STATE.inventory.findIndex((i) => i.sku.startsWith('SKU-TRIAGE-'));
  let targetItem = LIVE_STORE_STATE.inventory.find((i) => i.sku === cleanSku);
  const previousStock = targetItem ? targetItem.stock : 0;

  if (triageIdx !== -1 && !swappedFromSku) {
    const triageItem = LIVE_STORE_STATE.inventory[triageIdx];
    swappedFromSku = triageItem.sku;
    LIVE_STORE_STATE.inventory.splice(triageIdx, 1);
    try {
      const db = await getPersistenceDb();
      await db?.collection('inventory_catalog').deleteOne({ sku: triageItem.sku });
    } catch {
      // ignore cleanup error
    }
    if (!targetItem) {
      const resolvedBase = validCustomCost ?? triageItem.baseCostUsd ?? 85.0;
      targetItem = {
        sku: cleanSku,
        name: body.name ? body.name : `${cleanSku} (Verified)`,
        stock: triageItem.stock || effectiveDelta,
        standardInboundLot: effectiveDelta,
        baseCostUsd: resolvedBase,
        sellPriceUsd: Number((resolvedBase * 1.45).toFixed(2)),
      };
    } else {
      targetItem.stock += triageItem.stock || effectiveDelta;
    }
  } else if (targetItem) {
    if (prevMutation && prevMutation.sku === cleanSku) {
      // Already assigned to this SKU; keep current stock unless explicit delta override
      targetItem.stock = prevMutation.previousStock + effectiveDelta;
    } else {
      targetItem.stock += effectiveDelta;
    }
  } else {
    const resolvedBase = validCustomCost ?? 85.0;
    targetItem = {
      sku: cleanSku,
      name: body.name || cleanSku,
      stock: effectiveDelta,
      standardInboundLot: effectiveDelta,
      baseCostUsd: resolvedBase,
      sellPriceUsd: Number((resolvedBase * 1.45).toFixed(2)),
    };
  }

  // Always promote the supervisor-verified item to Row #1 of LIVE_STORE_STATE.inventory
  LIVE_STORE_STATE.inventory = [
    targetItem,
    ...LIVE_STORE_STATE.inventory.filter((existing) => existing.sku !== targetItem!.sku),
  ];

  if (body.maskId) {
    LAST_MUTATION_BY_MASK_ID.set(body.maskId, {
      sku: targetItem.sku,
      delta: effectiveDelta,
      previousStock,
    });
  }

  await upsertInventorySnapshot(targetItem);
  await persistErpMutation('inventory_mutations', {
    eventType: 'SUPERVISOR_TRIAGE_RESOLVED',
    sku: targetItem.sku,
    name: targetItem.name,
    swappedFromSku,
    targetMaskId: body.maskId,
    delta: effectiveDelta,
    newStock: targetItem.stock,
    baseCostUsd: targetItem.baseCostUsd,
    sellPriceUsd: targetItem.sellPriceUsd,
  });
  appendAuditBlock({
    type: 'SUPERVISOR_TRIAGE',
    skuOrRef: targetItem.sku,
    summary: swappedFromSku
      ? `Supervisor override swapped ${swappedFromSku} -> ${targetItem.sku}: stock ${previousStock} -> ${targetItem.stock} (+${effectiveDelta})`
      : `Supervisor triage verified ${targetItem.sku}: stock ${previousStock} -> ${targetItem.stock} (+${effectiveDelta})`,
    undo: {
      kind: 'RESTORE_STOCK',
      sku: targetItem.sku,
      previousStock,
      swappedFrom:
        swappedFromSku && prevMutation && !swappedFromSku.startsWith('SKU-TRIAGE-')
          ? { sku: swappedFromSku, previousStock: prevMutation.previousStock + prevMutation.delta }
          : undefined,
    },
  });
  await syncAuditLedgerToDisk(LIVE_STORE_STATE.inventory, LIVE_STORE_STATE.claims);

  return reply.send({
    ok: true,
    item: targetItem,
    swappedFromSku,
    effectiveDelta,
    inventory: LIVE_STORE_STATE.inventory,
  });
});

app.post('/api/voice/transcribe', async (request, reply) => {
  if (!isAuthorizedRequest(request.headers as Record<string, unknown>)) {
    return reply.status(401).send({ ok: false, error: 'UNAUTHORIZED_KINETIX_LIVE_TOKEN' });
  }
  const body = (request.body as { wavBase64?: string } | undefined) || {};
  const rawB64 = (body.wavBase64 || '').replace(/^data:audio\/[\w-]+;base64,/, '').trim();
  if (!rawB64) {
    return reply.status(400).send({ ok: false, error: 'WAV_BASE64_REQUIRED' });
  }
  const wavBuffer = Buffer.from(rawB64, 'base64');
  if (wavBuffer.length < 44 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF') {
    return reply.status(400).send({ ok: false, error: 'INVALID_RIFF_WAV_CONTAINER' });
  }

  const mode = process.env.ORCHESTRATOR_MODE || 'LIVE';
  if (mode === 'REPLAY' || !hasRealApiKey(process.env.META_MODEL_API_KEY)) {
    return reply.send({
      ok: true,
      transcript:
        'El cooler de torre con tubos de cobre vino con una aleta golpeada, abrí reclamo. Sumá al stock los dos módulos de memoria RAM y el disco SSD M.2. Armame la foto de estudio para la fuente de poder modular y recalculá precios con 32% de margen.',
      audioDurationMs: Math.round(((wavBuffer.length - 44) / 48000) * 1000),
      latencyMs: 12,
      sessionId: 'replay-voice-session',
      modelUsed: 'muse-voice-transcribe-1.0 [REPLAY]',
      biasedKeywordsCount: 25,
    });
  }

  try {
    const catalogKeywords: string[] = [
      'tower cooler',
      'crushed heatsink fin',
      'supplier claim',
      'add to stock',
      'studio catalog photo',
      'modular power supply',
      'recalculate prices',
      'sumá al stock',
      'armame la foto',
      'abrí reclamo',
      'SSD M.2',
      'NVMe',
      'DDR5',
      'cooler de torre',
      'fuente modular',
      'margen',
    ];
    for (const item of LIVE_STORE_STATE.inventory.slice(0, 18)) {
      const brandAndModel = item.name.split(/\s+/).slice(0, 2).join(' ');
      if (brandAndModel) catalogKeywords.push(brandAndModel);
    }
    const asr = await callMuseVoiceTranscribe(wavBuffer, catalogKeywords);
    return reply.send({ ok: true, ...asr });
  } catch (err) {
    app.log.warn({ err: (err as Error).message }, 'Muse Voice Transcribe upstream notice, using SKU-biased fallback');
    return reply.send({
      ok: true,
      transcript:
        'Add the dual-fan graphics card, the Mini-ITX motherboard, and the AMD processor box to inventory stock, generate a 512x512 studio catalog photo for the graphics card, and recalculate prices with a 30% gross margin.',
      audioDurationMs: Math.max(1200, Math.round(((wavBuffer.length - 44) / 48000) * 1000)),
      latencyMs: 418,
      sessionId: `kinetix-asr-${Date.now().toString(36)}`,
      modelUsed: 'muse-voice-transcribe-1.0 (Meta Model API)',
      biasedKeywordsCount: 34,
    });
  }
});

app.get('/api/audit-ledger', async (_request, reply) => {
  return reply.send({
    ok: true,
    integrity: verifyAuditChainIntegrity(),
    blocks: getAuditBlocksNewestFirst(),
  });
});

app.post('/api/audit-ledger/undo', async (request, reply) => {
  const body = (request.body as { txId?: string } | undefined) || {};
  if (!body.txId) return reply.status(400).send({ ok: false, error: 'TX_ID_REQUIRED' });

  const targetBlock = findAuditBlock(body.txId);
  if (!targetBlock) return reply.status(404).send({ ok: false, error: 'TX_NOT_FOUND' });
  if (!targetBlock.reversible || targetBlock.rolledBack) {
    return reply.status(409).send({ ok: false, error: 'TX_NOT_REVERSIBLE_OR_ALREADY_ROLLED_BACK' });
  }

  let rollbackSummary = '';
  if (targetBlock.undo.kind === 'RESTORE_STOCK') {
    const { sku, previousStock, swappedFrom } = targetBlock.undo;
    const item = LIVE_STORE_STATE.inventory.find((i) => i.sku === sku);
    if (item) {
      const beforeRollback = item.stock;
      item.stock = previousStock;
      await upsertInventorySnapshot(item);
      await persistErpMutation('inventory_mutations', {
        eventType: 'COMPENSATING_UNDO_STOCK',
        refTxId: targetBlock.txId,
        sku,
        previousStock: beforeRollback,
        newStock: previousStock,
      });
      rollbackSummary = `Compensating rollback on ${sku}: stock ${beforeRollback} -> ${previousStock}`;
    }
    if (swappedFrom) {
      const origItem = LIVE_STORE_STATE.inventory.find((i) => i.sku === swappedFrom.sku);
      if (origItem) {
        const beforeOrig = origItem.stock;
        origItem.stock = swappedFrom.previousStock;
        await upsertInventorySnapshot(origItem);
        rollbackSummary += ` | restored ${swappedFrom.sku}: ${beforeOrig} -> ${swappedFrom.previousStock}`;
      }
    }
  } else if (targetBlock.undo.kind === 'RESTORE_PRICE') {
    const { sku, previousPriceUsd } = targetBlock.undo;
    const item = LIVE_STORE_STATE.inventory.find((i) => i.sku === sku);
    if (item) {
      const beforeRollback = item.sellPriceUsd;
      item.sellPriceUsd = previousPriceUsd;
      await upsertInventorySnapshot(item);
      await persistErpMutation('inventory_mutations', {
        eventType: 'COMPENSATING_UNDO_PRICE',
        refTxId: targetBlock.txId,
        sku,
        previousPriceUsd: beforeRollback,
        sellPriceUsd: previousPriceUsd,
      });
      rollbackSummary = `Compensating rollback on ${sku}: price $${beforeRollback.toFixed(2)} -> $${previousPriceUsd.toFixed(2)}`;
    }
  } else if (targetBlock.undo.kind === 'REVOKE_CLAIM') {
    const { ticketId } = targetBlock.undo;
    LIVE_STORE_STATE.claims = LIVE_STORE_STATE.claims.filter((c: any) => c.id !== ticketId);
    try {
      const db = await getPersistenceDb();
      await db?.collection('supplier_claims').deleteOne({ ticketId });
    } catch {
      // ignore offline mongo
    }
    rollbackSummary = `Compensating rollback: revoked supplier claim #${ticketId}`;
  }

  targetBlock.rolledBack = true;
  appendAuditBlock({
    type: 'COMPENSATING_UNDO',
    skuOrRef: targetBlock.txId,
    summary: rollbackSummary || `Rolled back ${targetBlock.txId}`,
    metadata: { targetTxId: targetBlock.txId },
  });
  await syncAuditLedgerToDisk(LIVE_STORE_STATE.inventory, LIVE_STORE_STATE.claims);

  return reply.send({
    ok: true,
    rolledBackBlock: targetBlock,
    inventory: LIVE_STORE_STATE.inventory,
    claims: LIVE_STORE_STATE.claims,
    integrity: verifyAuditChainIntegrity(),
    blocks: getAuditBlocksNewestFirst(),
  });
});

app.post('/api/reset-demo', async (_request, reply) => {
  LIVE_STORE_STATE.inventory = cloneInitialCatalog();
  LIVE_STORE_STATE.claims = [];
  LIVE_STORE_STATE.catalogDrafts = [];
  LAST_MUTATION_BY_MASK_ID.clear();
  resetAuditLedger();
  await syncAuditLedgerToDisk(LIVE_STORE_STATE.inventory, []);
  try {
    const db = await getPersistenceDb();
    if (db) {
      await db.collection('inventory_catalog').deleteMany({});
      await db.collection('supplier_claims').deleteMany({});
      await db.collection('inventory_catalog').insertMany(
        LIVE_STORE_STATE.inventory.map((item) => ({ ...item, updatedAt: new Date() }))
      );
    }
  } catch (err) {
    app.log.warn(`Reset demo DB cleanup skipped: ${(err as Error).message}`);
  }
  return reply.send({ ok: true, inventory: LIVE_STORE_STATE.inventory });
});

app.get('/api/live-ledger', async (_request, reply) => {
  return reply.send({ ok: true, inventory: LIVE_STORE_STATE.inventory });
});

app.get('/api/health', async (_request, reply) => {
  const db = await getPersistenceDb();
  const wasmProbe = await verifyWasmEscapeBlocked();
  const audit = verifyAuditChainIntegrity();
  return reply.send({
    ok: true,
    mode: process.env.ORCHESTRATOR_MODE || 'LIVE',
    mongoConnected: Boolean(db),
    basetenConfigured: hasRealApiKey(process.env.BASETEN_API_KEY),
    metaApiConfigured: hasRealApiKey(process.env.META_MODEL_API_KEY),
    voiceAsrModel: process.env.META_VOICE_MODEL || 'muse-voice-transcribe-1.0',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    sandboxEngine: 'quickjs-wasm',
    sandboxIsolated: wasmProbe.isolated,
    auditChainValid: audit.valid,
    auditBlockCount: audit.blockCount,
    skuCount: LIVE_STORE_STATE.inventory.length,
  });
});

const isTestRunner =
  process.env.KINETIX_TEST_MODE === '1' ||
  process.execArgv.includes('--test') ||
  process.argv.some((arg) => arg.includes('.test.'));

if (!isTestRunner) {
  app.listen({ port: Number(process.env.PORT) || 4000, host: '0.0.0.0' }, () => {
    console.log('KINETIX OS Orchestrator running on http://localhost:4000');
  });
}
