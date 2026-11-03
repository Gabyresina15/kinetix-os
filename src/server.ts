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
  callMuseVoiceTranscribe,
  dispatchSupplierClaimNotification,
  STUDIO_RENDER_FALLBACK_URI,
  RAW_WAREHOUSE_CROP_FALLBACK_URI,
  refineMasksWithSam31,
  type DetectedObjectDraft,
} from './services/modelProviders';
import {
  extractRealCropsFromFrame,
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

function isAuthorizedRequest(headers: Record<string, unknown>): boolean {
  const requiredToken = process.env.KINETIX_LIVE_TOKEN;
  if (!requiredToken || (process.env.ORCHESTRATOR_MODE || 'LIVE') === 'REPLAY') return true;
  const provided = headers['x-kinetix-token'];
  return typeof provided === 'string' && provided === requiredToken;
}

export const LIVE_STORE_STATE = {
  inventory: cloneInitialCatalog() as CatalogSeedItem[],
  claims: [] as Record<string, unknown>[],
  catalogDrafts: [] as Record<string, unknown>[],
};

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
        thresholdUsd: c.thresholdUsd,
        dispatchChannel: c.dispatchChannel,
        externalReceiptId: c.externalReceiptId,
        guardrailStatus:
          c.guardrailStatus ||
          (c.amountUsd >= 50 ? 'HELD_WAITING_VOICE_AUTH' : 'AUTHORIZED_AND_DISPATCHED'),
      }));
    }

    console.log(`[Kinetix] Memory state synced (${LIVE_STORE_STATE.inventory.length} SKUs).`);
  } catch (error) {
    console.error('[Kinetix] Failed to sync with MongoDB at startup, using in-memory catalog:', error);
    if (LIVE_STORE_STATE.inventory.length === 0) {
      LIVE_STORE_STATE.inventory = cloneInitialCatalog();
    }
  }
}

void syncStoreStateFromMongo();

const ZERO_TRUST_LIMIT_USD = 50;

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
  const normalize = (str: string) => str.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const hintTokens = new Set([
    ...normalize(hint.sku || ''),
    ...normalize(hint.itemName || ''),
    ...normalize(hint.label || ''),
  ]);

  if (hintTokens.size === 0) return undefined;

  let bestMatch: T | undefined;
  let highestScore = 0;

  for (const item of inventory) {
    const itemTokens = normalize(`${item.sku} ${item.name}`);
    const score = itemTokens.filter((token) => hintTokens.has(token)).length;
    if (score > highestScore) {
      highestScore = score;
      bestMatch = item;
    }
  }

  return bestMatch;
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
  generate_studio_catalog: 30_000,
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

  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // IMPORTANT (Node 18-23+): Do NOT listen to request.raw ('close'), because IncomingMessage emits 'close'
  // immediately after Fastify finishes reading the 80KB POST body. Listen to reply.raw ('close') while !writableEnded.
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
    let sparkModelLabel = 'meta-models/muse-spark-open-1026 (Baseten)';
    let spatialLocked = false;
    let lockedRawMasks: RawSamMask[] = FALLBACK_SAM_MASKS;
    let usedFallbackPlan = false;

    const emitEarlyObjects = (objects: DetectedObjectDraft[]) => {
      if (spatialLocked || !objects.length) return;
      spatialLocked = true;
      lockedRawMasks = draftsToRawMasks(objects);
      const earlyNormalized = normalizeSpatialScene(lockedRawMasks);
      sendEvent('SPATIAL_LOCK', {
        model: 'Muse Spark Open (early stream)',
        latencyMs: Date.now() - startedAt,
        sparkLatencyMs: Date.now() - startedAt,
        samUsed: false,
        samLatencyMs: 0,
        samRefined: 0,
        preliminary: true,
        objects: earlyNormalized,
      });
    };

    const liveFixturePath = path.join(process.cwd(), 'fixtures', 'golden-path', 'last-baseten-spark-run.json');
    const trackedFixturePath = path.join(process.cwd(), 'fixtures', 'golden-path', 'golden-spark-replay.json');

    if (mode === 'REPLAY') {
      try {
        const preferredPath =
          process.env.REPLAY_USE_LAST_RUN === '1' ? liveFixturePath : trackedFixturePath;
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
          sparkModelLabel = `${rawFixture.liveSpark.modelUsed || 'muse-spark-open-1026'} [REPLAY]`;
        }
      } catch (replayErr) {
        usedFallbackPlan = true;
        sparkModelLabel = 'golden-fallback-plan [REPLAY_NO_FIXTURE]';
        app.log.warn(`REPLAY fixture missing, using fallback plan: ${(replayErr as Error).message}`);
      }
    } else if (mode === 'LIVE' && process.env.BASETEN_API_KEY) {
      const sparkAbort = new AbortController();
      const sparkTimer = setTimeout(() => sparkAbort.abort(new Error('Baseten timeout > 45000ms')), 45_000);
      const onClientAbort = () => {
        if (!reply.raw.writableEnded) {
          sparkAbort.abort(new Error('Client closed SSE stream'));
        }
      };
      reply.raw.on('close', onClientAbort);

      try {
        console.log('[LIVE] Calling Baseten | image:', Boolean(body.frameBase64), '| chars:', body.frameBase64?.length || 0);
        const liveSpark = await callBasetenMuseSparkOpen(
          systemPrompt,
          voiceTranscript,
          body.frameBase64,
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
        if (spatialLocked && lockedRawMasks.length) {
          activePlan = planFromLiveObjects(lockedRawMasks, voiceTranscript);
          rawReasoning = `Live plan could not be validated (${message}). Tools were rebound to the objects already detected.`;
          sparkModelLabel = 'muse-spark-open-1026 (partial, tools rebound)';
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
    const finalMasks = cleanMasks.length > 0 ? cleanMasks : dynamicRawMasks.slice(0, 4);
    const sam = mode === 'LIVE'
      ? await refineMasksWithSam31(body.frameBase64, finalMasks)
      : { masks: finalMasks, used: false, latencyMs: 0, refined: 0 };

    const cropStartedAt = Date.now();
    const masksWithRealCrops = await extractRealCropsFromFrame(body.frameBase64, sam.masks);
    const cropLatencyMs = Math.max(1, Date.now() - cropStartedAt);
    const normalizedObjects = normalizeSpatialScene(masksWithRealCrops);
    const piiMasks = normalizedObjects.filter((o) => o.isSensitivePII);

    sendEvent('EDGE_PII_SHIELD', {
      model: 'crop-gate (post-detection)',
      latencyMs: cropLatencyMs,
      redactedMasks: piiMasks.map((o) => ({ id: o.id, bbox: o.bbox })),
    });
    sendEvent('SPATIAL_LOCK', {
      model: sam.used ? 'SAM 3.1' : 'Muse Spark Open Vision + Sharp Cropper',
      latencyMs: sam.used ? sam.latencyMs : cropLatencyMs,
      sparkLatencyMs,
      samUsed: sam.used,
      samLatencyMs: sam.latencyMs,
      samRefined: sam.refined,
      usedFallbackPlan,
      objects: normalizedObjects,
    });

    // Pre-resolve claim amounts onto activePlan so GUARDRAIL_AUDIT telemetry and supplier_claims match 1:1.
    activePlan = {
      ...activePlan,
      actions: activePlan.actions.map((act) => {
        if (act.tool !== 'quarantine_and_claim') return act;
        const targetObj = normalizedObjects.find((o) => o.id === act.targetMaskId) || normalizedObjects[0];
        const matchedLedgerItem = findBestInventoryMatch(LIVE_STORE_STATE.inventory, {
          label: targetObj?.label,
          itemName: act.defectReason,
        });
        const plannedClaim = Number(act.claimAmountUsd);
        const resolvedClaim =
          Number.isFinite(plannedClaim) && plannedClaim > 0
            ? plannedClaim
            : matchedLedgerItem?.baseCostUsd ?? 65;
        return { ...act, claimAmountUsd: resolvedClaim };
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
      usedFallbackPlan,
      plan: activePlan,
    });

    // Resolve inventory mutations BEFORE pricing so repricing targets all mutated SKUs deterministically (no race).
    const mutatedSkusInRun: string[] = [];
    for (const act of activePlan.actions) {
      if (act.tool === 'mutate_inventory') {
        mutatedSkusInRun.push(act.sku);
      }
    }

    const ACTION_PRIORITY: Record<string, number> = {
      quarantine_and_claim: 1,
      mutate_inventory: 2,
      recalculate_margins_vm: 3,
      generate_studio_catalog: 4,
    };
    const orderedActions = [...activePlan.actions].sort(
      (a, b) => (ACTION_PRIORITY[a.tool] || 99) - (ACTION_PRIORITY[b.tool] || 99)
    );

    async function runIsolatedToolNode<T>(
      toolName: string,
      targetMaskId: string | undefined,
      timeoutMs: number,
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
        app.log.error({ toolName, error: message }, 'Tool node failed');
        sendEvent('TOOL_FAILED', {
          tool: toolName,
          targetMaskId,
          error: message,
          latencyMs: Date.now() - nodeStarted,
        });
        return { ok: false, error: message };
      } finally {
        clearTimeout(timer);
      }
    }

    const toolPromises = orderedActions.map((action) => {
      const targetMaskId = 'targetMaskId' in action ? action.targetMaskId : undefined;
      const timeoutMs = TOOL_TIMEOUT_MS[action.tool] ?? 15_000;

      return runIsolatedToolNode(action.tool, targetMaskId, timeoutMs, async (signal) => {
        const toolStartedAt = Date.now();

        if (action.tool === 'quarantine_and_claim') {
          const targetObj = normalizedObjects.find((o) => o.id === action.targetMaskId) || normalizedObjects[0];
          const matchedLedgerItem = findBestInventoryMatch(LIVE_STORE_STATE.inventory, {
            label: targetObj?.label,
            itemName: action.defectReason,
          });
          const resolvedAmount = Number.isFinite(Number(action.claimAmountUsd)) && Number(action.claimAmountUsd) > 0
            ? Number(action.claimAmountUsd)
            : matchedLedgerItem?.baseCostUsd ?? 65;
          const ticketId = `CLM-${Math.floor(100 + Math.random() * 900)}`;
          const exceedsLimit = resolvedAmount >= ZERO_TRUST_LIMIT_USD;
          const guardrailStatus = exceedsLimit
            ? ('HELD_WAITING_VOICE_AUTH' as const)
            : ('AUTHORIZED_AND_DISPATCHED' as const);

          if (signal.aborted) return;
          const dbCommit = await persistErpMutation('supplier_claims', {
            ticketId,
            maskId: targetObj?.id || action.targetMaskId,
            matchedSku: matchedLedgerItem?.sku,
            label: targetObj?.label || 'Detected Item',
            reason: action.defectReason,
            amountUsd: resolvedAmount,
            thresholdUsd: ZERO_TRUST_LIMIT_USD,
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
            amountUsd: resolvedAmount,
            thresholdUsd: ZERO_TRUST_LIMIT_USD,
            cropBase64: targetObj?.cropBase64,
            guardrailStatus,
            dispatchChannel: exceedsLimit ? undefined : 'AUTO_BELOW_THRESHOLD',
            timestamp: new Date().toISOString(),
          };
          LIVE_STORE_STATE.claims.unshift(claimRecord);
          appendAuditBlock({
            type: 'SUPPLIER_CLAIM',
            skuOrRef: ticketId,
            summary: `Defect claim -$${resolvedAmount.toFixed(2)} USD (${guardrailStatus}): ${action.defectReason}`,
            undo: { kind: 'REVOKE_CLAIM', ticketId },
            metadata: { amountUsd: resolvedAmount, guardrailStatus },
          });
          sendEvent('TOOL_MUTATED', {
            tool: action.tool,
            targetMaskId: targetObj?.id || action.targetMaskId,
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
            status: 'MUTATED',
            latencyMs: Date.now() - toolStartedAt,
            result: { ...item, previousStock, delta: action.delta, mongoId: dbCommit.mongoId, maskId: action.targetMaskId },
          });
        }

        if (action.tool === 'generate_studio_catalog') {
          const targetObj =
            normalizedObjects.find((o) => o.id === action.targetMaskId) ||
            normalizedObjects[normalizedObjects.length - 1];
          const compiledStudioPrompt = compileMuseImagePromptFromDna(action.visualDna);

          let studioUrl = STUDIO_RENDER_FALLBACK_URI;
          let usedLive = false;
          let resolution = 'SVG_FALLBACK';
          let synthesisLatencyMs = 0;
          if (mode === 'LIVE' && process.env.META_MODEL_API_KEY) {
            const imageStartedAt = Date.now();
            const synth = await callMuseImageStudioSynthesis(compiledStudioPrompt, signal);
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
            status: 'MUTATED',
            latencyMs: synthesisLatencyMs || Date.now() - toolStartedAt,
            result: catalogCard,
          });
        }

        if (action.tool === 'recalculate_margins_vm') {
          let rawCode = buildDeterministicPolicyCode();
          let policyModelLabel = 'Deterministic WASM Policy';
          if (mode === 'LIVE' && (process.env.META_MODEL_API_KEY || process.env.BASETEN_API_KEY)) {
            try {
              const synth = await callMuseCodeGenerator(
                action.targetMarginPercent,
                action.taxRatePercent,
                voiceTranscript,
                signal
              );
              rawCode = synth.code;
              policyModelLabel = synth.modelUsed;
            } catch (codeErr) {
              app.log.warn(`Policy synthesis fell back to deterministic WASM formula: ${(codeErr as Error).message}`);
            }
          }

          // Reprice every non-triage SKU mutated in this run (using its real ledger baseCostUsd), or explicit match.
          const candidateItems: CatalogSeedItem[] = [];
          const deltaBySku = new Map<string, number>();
          for (const act of activePlan.actions) {
            if (act.tool === 'mutate_inventory') deltaBySku.set(act.sku, act.delta);
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

          for (const item of candidateItems) {
            const previousPriceUsd = item.sellPriceUsd;
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

            if (!signal.aborted) {
              await upsertInventorySnapshot(item);
              await persistErpMutation('inventory_mutations', {
                eventType: 'REPRICE',
                sku: item.sku,
                name: item.name,
                baseCostUsd: item.baseCostUsd,
                sellPriceUsd: vmRes.finalPrice,
                marginApplied: action.targetMarginPercent,
                taxApplied: action.taxRatePercent,
                sandboxEngine: vmRes.sandboxEngine,
                policyModel: policyModelLabel,
              });
              appendAuditBlock({
                type: 'WASM_REPRICE',
                skuOrRef: item.sku,
                summary: `QuickJS WASM (${action.targetMarginPercent}% margin): $${previousPriceUsd.toFixed(2)} -> $${vmRes.finalPrice.toFixed(2)}`,
                undo: { kind: 'RESTORE_PRICE', sku: item.sku, previousPriceUsd },
                metadata: {
                  sandboxEngine: vmRes.sandboxEngine,
                  invariantsPassed: vmRes.invariantsPassed,
                  policyModel: policyModelLabel,
                },
              });
            }
          }

          const fallbackVm =
            primaryVmResult ||
            (await executeMuseCodeMarginCalc(rawCode, 95, action.targetMarginPercent, action.taxRatePercent));
          const primaryTarget = repricedSkus[0] || { sku: 'SKU-DDR5-32GB-KIT', finalPrice: fallbackVm.finalPrice };

          sendEvent('TOOL_MUTATED', {
            tool: action.tool,
            status: 'MUTATED',
            latencyMs: Date.now() - toolStartedAt,
            modelUsed: policyModelLabel,
            result: {
              finalPrice: primaryTarget.finalPrice,
              executedCode: fallbackVm.cleanCodeShownInUI,
              cleanCodeShownInUI: fallbackVm.cleanCodeShownInUI,
              usedFallback: fallbackVm.usedFallback,
              sandboxEngine: fallbackVm.sandboxEngine,
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
    });

    await Promise.allSettled(toolPromises);

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

  const dispatch = await dispatchSupplierClaimNotification({
    id: held.id as string,
    mongoId: held.mongoId as string | undefined,
    reason: held.reason as string,
    amountUsd: held.amountUsd as number,
    cropBase64: held.cropBase64 as string | undefined,
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

  return reply.send({ ok: true, claim: held, deliveredExternally: dispatch.deliveredExternally });
});

app.post('/api/triage/resolve', async (request, reply) => {
  const body =
    (request.body as {
      maskId: string;
      sku: string;
      name?: string;
      action: 'STOCK' | 'CLAIM';
      delta?: number;
      reason?: string;
      cropBase64?: string;
    }) || ({} as any);

  const cleanSku = String(body.sku || '').trim().toUpperCase();
  if (!cleanSku) return reply.status(400).send({ ok: false, error: 'SKU_REQUIRED' });

  if (body.action === 'CLAIM') {
    const matched = LIVE_STORE_STATE.inventory.find((i) => i.sku === cleanSku);
    const amountUsd = matched?.baseCostUsd ?? 85.0;
    const ticketId = `CLM-${Math.floor(100 + Math.random() * 900)}`;
    const exceedsLimit = amountUsd >= ZERO_TRUST_LIMIT_USD;
    const guardrailStatus = exceedsLimit ? 'HELD_WAITING_VOICE_AUTH' : 'AUTHORIZED_AND_DISPATCHED';
    const reason = body.reason || `Supervisor triage defect on ${body.name || cleanSku}`;

    const dbCommit = await persistErpMutation('supplier_claims', {
      ticketId,
      maskId: body.maskId,
      matchedSku: cleanSku,
      label: body.name || cleanSku,
      reason,
      amountUsd,
      thresholdUsd: ZERO_TRUST_LIMIT_USD,
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
      amountUsd,
      thresholdUsd: ZERO_TRUST_LIMIT_USD,
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
    return reply.send({ ok: true, claim: claimRecord, inventory: LIVE_STORE_STATE.inventory });
  }

  // STOCK resolution: promote SKU-TRIAGE-* if present, otherwise increment/insert SKU.
  const delta = Number(body.delta) > 0 ? Number(body.delta) : 1;
  const triageIdx = LIVE_STORE_STATE.inventory.findIndex((i) => i.sku.startsWith('SKU-TRIAGE-'));
  let targetItem = LIVE_STORE_STATE.inventory.find((i) => i.sku === cleanSku);
  const previousStock = targetItem ? targetItem.stock : 0;

  if (triageIdx !== -1) {
    const triageItem = LIVE_STORE_STATE.inventory[triageIdx];
    LIVE_STORE_STATE.inventory.splice(triageIdx, 1);
    try {
      const db = await getPersistenceDb();
      await db?.collection('inventory_catalog').deleteOne({ sku: triageItem.sku });
    } catch {
      // ignore cleanup error
    }
    if (!targetItem) {
      targetItem = {
        sku: cleanSku,
        name: `${body.name || cleanSku} (Verified)`,
        stock: triageItem.stock || delta,
        standardInboundLot: delta,
        baseCostUsd: triageItem.baseCostUsd || 85.0,
        sellPriceUsd: triageItem.sellPriceUsd || 123.25,
      };
      LIVE_STORE_STATE.inventory.unshift(targetItem);
    } else {
      targetItem.stock += triageItem.stock || delta;
    }
  } else if (targetItem) {
    targetItem.stock += delta;
  } else {
    targetItem = {
      sku: cleanSku,
      name: body.name || cleanSku,
      stock: delta,
      standardInboundLot: delta,
      baseCostUsd: 85.0,
      sellPriceUsd: 123.25,
    };
    LIVE_STORE_STATE.inventory.unshift(targetItem);
  }

  await upsertInventorySnapshot(targetItem);
  await persistErpMutation('inventory_mutations', {
    eventType: 'SUPERVISOR_TRIAGE_RESOLVED',
    sku: targetItem.sku,
    name: targetItem.name,
    targetMaskId: body.maskId,
    delta,
    newStock: targetItem.stock,
    baseCostUsd: targetItem.baseCostUsd,
    sellPriceUsd: targetItem.sellPriceUsd,
  });
  appendAuditBlock({
    type: 'SUPERVISOR_TRIAGE',
    skuOrRef: targetItem.sku,
    summary: `Supervisor triage verified ${targetItem.sku}: stock ${previousStock} -> ${targetItem.stock}`,
    undo: { kind: 'RESTORE_STOCK', sku: targetItem.sku, previousStock },
  });

  return reply.send({ ok: true, item: targetItem, inventory: LIVE_STORE_STATE.inventory });
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
  if (mode === 'REPLAY' || !process.env.META_MODEL_API_KEY) {
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
    const catalogKeywords: string[] = [];
    for (const item of LIVE_STORE_STATE.inventory.slice(0, 20)) {
      const brandAndModel = item.name.split(/\s+/).slice(0, 2).join(' ');
      if (brandAndModel) catalogKeywords.push(brandAndModel);
    }
    const asr = await callMuseVoiceTranscribe(wavBuffer, catalogKeywords);
    return reply.send({ ok: true, ...asr });
  } catch (err) {
    app.log.error({ err: (err as Error).message }, 'Muse Voice Transcribe failed');
    return reply.status(502).send({ ok: false, error: (err as Error).message });
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
    const { sku, previousStock } = targetBlock.undo;
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

  return reply.send({
    ok: true,
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
  resetAuditLedger();
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
    basetenConfigured: Boolean(process.env.BASETEN_API_KEY),
    metaApiConfigured: Boolean(process.env.META_MODEL_API_KEY),
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
