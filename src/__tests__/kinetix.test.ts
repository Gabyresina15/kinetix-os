import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KINETIX_TEST_MODE = '1';
process.env.ORCHESTRATOR_MODE = 'REPLAY';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27999/kinetix_nonexistent_test';

import { INITIAL_CATALOG, cloneInitialCatalog } from '../data/catalogSeed';
import {
  executeWasmPricingSandbox,
  verifyWasmEscapeBlocked,
} from '../services/wasmPricingSandbox';
import {
  salvageOrchestrationPlan,
  tightenAndDeoverlapBoxes,
  compileMuseImagePromptFromDna,
} from '../contracts/orchestratorCore';
import { normalizeSpatialScene } from '../services/spatialNormalizer';
import { resolveMongoDbName } from '../services/spatialCropperAndDb';
import { app, LIVE_STORE_STATE } from '../server';

test('QuickJS WASM sandbox blocks prototype-chain RCE escape (typeof process === undefined)', async () => {
  const probe = await verifyWasmEscapeBlocked();
  assert.equal(probe.isolated, true);
  assert.equal(probe.probeResult, 'undefined');

  const exploitAttempt = await executeWasmPricingSandbox(
    `function calculatePrice(ctx) {
       const p = this.constructor.constructor('return typeof process')();
       if (p !== 'undefined') return 999;
       return ctx.cost * 1.5;
     }`,
    { baseCost: 100, targetMarginPct: 30, taxPct: 21, currentStock: 20 }
  );
  assert.equal(exploitAttempt.sandboxEngine, 'quickjs-wasm');
  assert.equal(exploitAttempt.invariantsPassed, true);
});

test('QuickJS WASM sandbox interrupts infinite loops within 50ms deadline and falls back cleanly', async () => {
  const started = Date.now();
  const res = await executeWasmPricingSandbox(
    `function calculatePrice(ctx) { while (true) {} return ctx.cost * 2; }`,
    { baseCost: 100, targetMarginPct: 32, taxPct: 21, currentStock: 30 }
  );
  const elapsed = Date.now() - started;
  assert.equal(res.usedFallback, true);
  assert.ok(elapsed < 1500, `Expected fast interrupt, took ${elapsed}ms`);
  assert.ok(res.finalPrice > 100);
});

test('QuickJS WASM sandbox enforces financial invariants (below-cost, gouging, monotonicity)', async () => {
  const belowCost = await executeWasmPricingSandbox(
    `function calculatePrice(ctx) { return ctx.cost * 0.8; }`,
    { baseCost: 100, targetMarginPct: 30, taxPct: 21 }
  );
  assert.equal(belowCost.usedFallback, true);

  const gouging = await executeWasmPricingSandbox(
    `function calculatePrice(ctx) { return ctx.cost * 12; }`,
    { baseCost: 100, targetMarginPct: 30, taxPct: 21 }
  );
  assert.equal(gouging.usedFallback, true);

  const nonMonotonic = await executeWasmPricingSandbox(
    `function calculatePrice(ctx) { return 250 - ctx.cost * 0.1; }`,
    { baseCost: 100, targetMarginPct: 30, taxPct: 21 }
  );
  assert.equal(nonMonotonic.usedFallback, true);

  const validPolicy = await executeWasmPricingSandbox(
    `function calculatePrice(ctx) {
       const gross = ctx.cost / (1 - ctx.marginPct / 100);
       const tier = ctx.stock > 100 ? 0.96 : 1.0;
       return Number((gross * tier * (1 + ctx.taxPct / 100)).toFixed(2));
     }`,
    { baseCost: 160, targetMarginPct: 32, taxPct: 21, currentStock: 140 }
  );
  assert.equal(validPolicy.usedFallback, false);
  assert.equal(validPolicy.invariantsPassed, true);
  assert.ok(validPolicy.finalPrice > 160 && validPolicy.finalPrice < 160 * 4.5);
});

test('Canonical catalog seed contains 31 distinct SKUs with non-uniform prices and valid stock', () => {
  assert.equal(INITIAL_CATALOG.length, 31);
  const skus = new Set(INITIAL_CATALOG.map((i) => i.sku));
  assert.equal(skus.size, 31);
  const distinctSellPrices = new Set(INITIAL_CATALOG.map((i) => i.sellPriceUsd));
  assert.ok(distinctSellPrices.size >= 20, 'Catalog prices must not collapse to a single $158 value');
  for (const item of INITIAL_CATALOG) {
    assert.ok(item.name !== item.sku, `SKU ${item.sku} must have a human-readable product name`);
    assert.ok(Number.isFinite(item.stock) && item.stock >= 0);
    assert.ok(item.sellPriceUsd > item.baseCostUsd);
  }
});

test('Spatial geometry de-overlap and plan salvage handle malformed LLM coordinates', () => {
  const overlapping = tightenAndDeoverlapBoxes([
    { id: 'ram', label: 'RAM Kit', bbox: [0.18, 0.71, 0.22, 0.15] },
    { id: 'ssd', label: 'M.2 SSD', bbox: [0.34, 0.75, 0.08, 0.05] },
  ]);
  assert.ok(
    overlapping[0].bbox[0] + overlapping[0].bbox[2] < overlapping[1].bbox[0],
    'Larger left box must stop strictly before adjacent smaller right box'
  );

  const normalized = normalizeSpatialScene([
    { id: 'm1', label: 'PSU', bbox: [0.8, 0.6, 0.15, 0.2], confidence: 0.95, cropBase64: '', isSensitivePII: false },
  ]);
  assert.equal(normalized[0].spatialRegion2D, 'FRONT_RIGHT');

  const salvaged = salvageOrchestrationPlan({
    summary: 'Partial output',
    detectedObjects: [{ id: 'obj1', label: 'Cooler', bbox: [-0.2, 0.5, 1.5, 0.3], confidence: '0.94' }],
    actions: [
      { tool: 'quarantine_and_claim', targetMaskId: 'obj1', defectReason: 'bent fin', claimAmountUsd: '75' },
      { tool: 'invalid_hallucinated_tool', foo: 'bar' },
    ],
  });
  assert.ok(salvaged);
  assert.equal(salvaged.actions.length, 1);
  assert.equal(salvaged.detectedObjects?.[0].bbox[0], 0);

  const prompt = compileMuseImagePromptFromDna({
    containerGeometry: 'ATX PSU',
    exactColorPalette: 'matte black',
    detectedBrandOrText: 'RM1000x',
    surfaceMaterial: 'steel',
  });
  assert.ok(!/\b8k\b/i.test(prompt), 'Studio prompt must not claim 8K resolution');
  assert.equal(resolveMongoDbName('mongodb://127.0.0.1:27017/custom_erp_db?retryWrites=true'), 'custom_erp_db');
});

test('Fastify REPLAY orchestration stream executes end-to-end DAG, $50 guardrail, and batch WASM repricing', async () => {
  process.env.ORCHESTRATOR_MODE = 'REPLAY';
  process.env.MONGO_URI = 'mongodb://127.0.0.1:27999/kinetix_nonexistent_test';
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';
  process.env.KINETIX_LIVE_TOKEN = '';

  LIVE_STORE_STATE.inventory = cloneInitialCatalog();
  LIVE_STORE_STATE.claims = [];

  const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(healthRes.statusCode, 200);
  const health = healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'REPLAY');
  assert.equal(health.sandboxEngine, 'quickjs-wasm');
  assert.equal(health.sandboxIsolated, true);

  const streamRes = await app.inject({
    method: 'POST',
    url: '/api/orchestrate-stream',
    payload: {
      voiceTranscript:
        'El cooler de torre vino con una aleta golpeada, abrí reclamo. Sumá al stock los dos módulos RAM y el SSD M.2 y recalculá precios con 32% de margen.',
    },
  });
  assert.equal(streamRes.statusCode, 200);
  assert.ok(streamRes.body.includes('event: SPATIAL_LOCK'));
  assert.ok(streamRes.body.includes('event: SPARK_PLAN_LOCKED'));
  assert.ok(streamRes.body.includes('event: TOOL_MUTATED'));
  assert.ok(streamRes.body.includes('event: ORCHESTRATION_COMPLETE'));

  // Verify $50 Zero-Trust Guardrail held the $65 claim
  assert.equal(LIVE_STORE_STATE.claims.length, 1);
  const heldClaim = LIVE_STORE_STATE.claims[0] as any;
  assert.equal(heldClaim.guardrailStatus, 'HELD_WAITING_VOICE_AUTH');
  assert.ok(heldClaim.amountUsd >= 50);

  // Authorize guardrail claim via /api/confirm-guardrail (offline ledger fallback)
  const confirmRes = await app.inject({
    method: 'POST',
    url: '/api/confirm-guardrail',
    payload: { claimId: heldClaim.id },
  });
  assert.equal(confirmRes.statusCode, 200);
  assert.equal(confirmRes.json().claim.guardrailStatus, 'AUTHORIZED_AND_DISPATCHED');

  // Verify stock mutations AND batch WASM repricing preserved human-readable product names & stock numbers
  const ram = LIVE_STORE_STATE.inventory.find((i) => i.sku === 'SKU-DDR5-64GB-KIT')!;
  const ssd = LIVE_STORE_STATE.inventory.find((i) => i.sku === 'SKU-NVME-4TB-GEN4')!;
  assert.equal(ram.stock, 30); // 28 + 2
  assert.equal(ssd.stock, 13); // 12 + 1
  assert.equal(ram.name, 'Corsair Vengeance RGB DDR5 64GB (2x32GB)');
  assert.notEqual(ram.sellPriceUsd, 215.0);
  assert.notEqual(ssd.sellPriceUsd, 345.0);

  // Verify supervisor triage endpoint persists stock resolution
  const triageRes = await app.inject({
    method: 'POST',
    url: '/api/triage/resolve',
    payload: {
      action: 'STOCK',
      sku: 'SKU-MYSTERY-PCIE',
      name: 'Mystery PCIe Card',
      maskId: 'mask_unknown_1',
      delta: 3,
    },
  });
  assert.equal(triageRes.statusCode, 200);
  assert.equal(triageRes.json().ok, true);
  assert.equal(
    LIVE_STORE_STATE.inventory.find((i) => i.sku === 'SKU-MYSTERY-PCIE')?.stock,
    3
  );

  // Reset demo restores clean 31-SKU canonical catalog
  const resetRes = await app.inject({ method: 'POST', url: '/api/reset-demo' });
  assert.equal(resetRes.statusCode, 200);
  assert.equal(LIVE_STORE_STATE.inventory.length, 31);

  // Real TCP HTTP socket regression test (Node 23 IncomingMessage 'close' on 85KB POST body must NOT abort SSE!)
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const fake85KbPayload = 'data:image/jpeg;base64,' + 'A'.repeat(85_000);
    const tcpRes = await fetch(`${address}/api/orchestrate-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frameBase64: fake85KbPayload,
        voiceTranscript: 'Test TCP SSE stream with large 85KB POST body',
      }),
    });
    assert.equal(tcpRes.status, 200);
    const sseText = await tcpRes.text();
    assert.ok(sseText.includes('event: VISION_SCAN_STARTED'), 'TCP SSE must emit VISION_SCAN_STARTED');
    assert.ok(sseText.includes('event: SPATIAL_LOCK'), 'TCP SSE must emit SPATIAL_LOCK');
    assert.ok(sseText.includes('event: ORCHESTRATION_COMPLETE'), 'TCP SSE must complete without premature close');
  } finally {
    await app.close();
  }
});
