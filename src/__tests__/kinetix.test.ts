import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

process.env.KINETIX_TEST_MODE = '1';
process.env.ORCHESTRATOR_MODE = 'REPLAY';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27999/kinetix_nonexistent_test';

import { INITIAL_CATALOG, cloneInitialCatalog } from '../data/catalogSeed';
import {
  executeWasmPricingSandbox,
  executeBoundedNodeVmPolicy,
  verifyWasmEscapeBlocked,
} from '../services/wasmPricingSandbox';
import {
  salvageOrchestrationPlan,
  tightenAndDeoverlapBoxes,
  compileMuseImagePromptFromDna,
  computeEvidenceBasedClaimUsd,
} from '../contracts/orchestratorCore';
import { computeIoU } from '../services/modelProviders';
import { normalizeSpatialScene } from '../services/spatialNormalizer';
import {
  resolveMongoDbName,
  extractRealCropsFromFrame,
} from '../services/spatialCropperAndDb';
import {
  resetAuditLedger,
  verifyAuditChainIntegrity,
} from '../services/auditLedger';
import { app, LIVE_STORE_STATE } from '../server';

test('QuickJS WASM & bounded 50ms node:vm sandboxes block escape and verify policy invariants', async () => {
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

  const vmOk = executeBoundedNodeVmPolicy(
    `function calculatePrice(ctx) {
       const gross = ctx.cost / (1 - ctx.marginPct / 100);
       return Number((gross * (1 + ctx.taxPct / 100)).toFixed(2));
     }`,
    { baseCost: 100, targetMarginPct: 32, taxPct: 21, currentStock: 25 }
  );
  assert.equal(vmOk.usedFallback, false);
  assert.equal(vmOk.invariantsPassed, true);

  const vmLoop = executeBoundedNodeVmPolicy(
    `function calculatePrice(ctx) { while (true) {} return ctx.cost * 2; }`,
    { baseCost: 100, targetMarginPct: 32, taxPct: 21, currentStock: 25 }
  );
  assert.equal(vmLoop.usedFallback, true);
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

test('Dynamic evidence-based claim calculation derives claimAmountUsd from catalog baseCostUsd * damageFactor', () => {
  const intact = computeEvidenceBasedClaimUsd({
    baseCostUsd: 78.0,
    defectReason: 'Intact factory-sealed box with no damage',
    defectSeverity: 'INTACT',
    damageFactor: 0,
  });
  assert.equal(intact.claimAmountUsd, 0.0);
  assert.equal(intact.defectSeverity, 'INTACT');

  const minorCosmetic = computeEvidenceBasedClaimUsd({
    baseCostUsd: 78.0,
    defectReason: 'Minor cosmetic scuff on outer cardboard sleeve',
    defectSeverity: 'MINOR',
  });
  assert.equal(minorCosmetic.claimAmountUsd, 19.5); // $78.00 * 0.25 = $19.50 (< $50 USD guardrail)
  assert.ok(minorCosmetic.claimAmountUsd < 50);

  const criticalCooler = computeEvidenceBasedClaimUsd({
    baseCostUsd: 78.0,
    defectReason: 'Critical structural deformation on aluminum heatsink fin stack',
    defectSeverity: 'CRITICAL',
    damageFactor: 0.85,
  });
  assert.equal(criticalCooler.claimAmountUsd, 66.3); // $78.00 * 0.85 = $66.30 (>= $50 USD guardrail)
  assert.ok(criticalCooler.claimAmountUsd >= 50);
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

test('SAM 3.1 IoU refinement, spatial geometry de-overlap, and plan salvage handle malformed coordinates', () => {
  const iouScore = computeIoU([0.1, 0.1, 0.2, 0.2], [0.11, 0.11, 0.2, 0.2]);
  assert.ok(iouScore > 0.8, `Expected high IoU for aligned candidate box, got ${iouScore}`);

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
      { tool: 'quarantine_and_claim', targetMaskId: 'obj1', defectReason: 'bent fin', claimAmountUsd: '66.3' },
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

test('Physical Sharp PII pixel scrubbing burns opaque shields onto frame before cropping', async () => {
  const whiteJpeg = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  const frameB64 = `data:image/jpeg;base64,${whiteJpeg.toString('base64')}`;

  const crops = await extractRealCropsFromFrame(frameB64, [
    { id: 'pii_label', label: 'Shipping Waybill PII', bbox: [0.2, 0.2, 0.4, 0.4], confidence: 0.99, cropBase64: '', isSensitivePII: true },
    { id: 'box_under_label', label: 'Hardware Box', bbox: [0.15, 0.15, 0.5, 0.5], confidence: 0.95, cropBase64: '', isSensitivePII: false },
  ]);

  const piiEntry = crops.find((c) => c.id === 'pii_label')!;
  const boxEntry = crops.find((c) => c.id === 'box_under_label')!;
  assert.equal(piiEntry.cropBase64, 'REDACTED', 'Sensitive PII region must never produce a stored image crop');
  assert.ok(boxEntry.cropBase64.startsWith('data:image/jpeg;base64,'));

  const cropBuf = Buffer.from(boxEntry.cropBase64.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  const stats = await sharp(cropBuf).stats();
  assert.ok(
    stats.channels[0].mean < 140,
    `Expected dark burned-in PII shield inside overlapping crop, got channel mean ${stats.channels[0].mean}`
  );
});

test('Muse Voice Transcribe endpoint validates 24kHz PCM RIFF/WAVE containers', async () => {
  const badRes = await app.inject({
    method: 'POST',
    url: '/api/voice/transcribe',
    payload: { wavBase64: Buffer.from('NOT_A_WAV_FILE_PAYLOAD_12345678901234567890123456').toString('base64') },
  });
  assert.equal(badRes.statusCode, 400);
  assert.equal(badRes.json().error, 'INVALID_RIFF_WAV_CONTAINER');

  const pcmBytes = 4800;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcmBytes, 40);

  const okRes = await app.inject({
    method: 'POST',
    url: '/api/voice/transcribe',
    payload: { wavBase64: wav.toString('base64') },
  });
  assert.equal(okRes.statusCode, 200);
  const body = okRes.json();
  assert.equal(body.ok, true);
  assert.ok(body.transcript.includes('32%'));
});

test('Fastify REPLAY orchestration stream, stage-based concurrent DAG, dynamic $50 guardrail, SHA-256 Audit Ledger & Compensating Undo work end-to-end', async () => {
  process.env.ORCHESTRATOR_MODE = 'REPLAY';
  process.env.MONGO_URI = 'mongodb://127.0.0.1:27999/kinetix_nonexistent_test';
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_CHAT_ID = '';
  process.env.KINETIX_LIVE_TOKEN = '';

  LIVE_STORE_STATE.inventory = cloneInitialCatalog();
  LIVE_STORE_STATE.claims = [];
  resetAuditLedger();

  const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(healthRes.statusCode, 200);
  const health = healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'REPLAY');
  assert.equal(health.sandboxEngine, 'quickjs-wasm');
  assert.equal(health.sandboxIsolated, true);
  assert.equal(health.auditChainValid, true);

  const streamRes = await app.inject({
    method: 'POST',
    url: '/api/orchestrate-stream',
    payload: {
      voiceTranscript:
        'El cooler de torre vino con una aleta golpeada, abrí reclamo. Sumá al stock los dos módulos RAM y el SSD M.2 y recalculá precios con 32% de margen.',
    },
  });
  assert.equal(streamRes.statusCode, 200);
  assert.ok(!streamRes.body.includes('event: EDGE_PII_SHIELD'), 'Must not emit simulated EDGE_PII_SHIELD event');
  assert.ok(streamRes.body.includes('event: SPATIAL_LOCK'));
  assert.ok(streamRes.body.includes('event: SPARK_PLAN_LOCKED'));
  assert.ok(streamRes.body.includes('event: TOOL_MUTATED'));
  assert.ok(streamRes.body.includes('event: ORCHESTRATION_COMPLETE'));

  // Verify dynamic $50 USD Financial Guardrail held the $66.30 claim ($78.00 * 0.85 CRITICAL)
  assert.equal(LIVE_STORE_STATE.claims.length, 1);
  const heldClaim = LIVE_STORE_STATE.claims[0] as any;
  assert.equal(heldClaim.guardrailStatus, 'HELD_WAITING_VOICE_AUTH');
  assert.equal(heldClaim.amountUsd, 66.3);
  assert.equal(heldClaim.baseCostUsd, 78);
  assert.equal(heldClaim.damageFactor, 0.85);
  assert.equal(heldClaim.defectSeverity, 'CRITICAL');

  // Authorize guardrail claim via /api/confirm-guardrail
  const confirmRes = await app.inject({
    method: 'POST',
    url: '/api/confirm-guardrail',
    payload: { claimId: heldClaim.id },
  });
  assert.equal(confirmRes.statusCode, 200);
  assert.equal(confirmRes.json().claim.guardrailStatus, 'AUTHORIZED_AND_DISPATCHED');

  // Verify stock mutations AND batch repricing preserved human-readable product names & stock numbers
  const ram = LIVE_STORE_STATE.inventory.find((i) => i.sku === 'SKU-DDR5-64GB-KIT')!;
  const ssd = LIVE_STORE_STATE.inventory.find((i) => i.sku === 'SKU-NVME-4TB-GEN4')!;
  assert.equal(ram.stock, 30); // 28 + 2
  assert.equal(ssd.stock, 13); // 12 + 1
  assert.equal(ram.name, 'Corsair Vengeance RGB DDR5 64GB (2x32GB)');
  assert.notEqual(ram.sellPriceUsd, 215.0);
  assert.notEqual(ssd.sellPriceUsd, 345.0);

  // Verify SHA-256 cryptographic audit ledger integrity & atomic compensating rollback (UNDO TX)
  const ledgerRes = await app.inject({ method: 'GET', url: '/api/audit-ledger' });
  assert.equal(ledgerRes.statusCode, 200);
  const ledgerJson = ledgerRes.json();
  assert.equal(ledgerJson.integrity.valid, true);
  assert.ok(ledgerJson.blocks.length >= 5, 'Expected chained blocks for claim, stock, studio, reprice, and auth');

  const ramStockTx = ledgerJson.blocks.find(
    (b: any) => b.type === 'STOCK_DELTA' && b.skuOrRef === 'SKU-DDR5-64GB-KIT'
  );
  assert.ok(ramStockTx, 'Expected STOCK_DELTA block for SKU-DDR5-64GB-KIT');

  const undoRes = await app.inject({
    method: 'POST',
    url: '/api/audit-ledger/undo',
    payload: { txId: ramStockTx.txId },
  });
  assert.equal(undoRes.statusCode, 200);
  const undoJson = undoRes.json();
  assert.equal(undoJson.integrity.valid, true);
  assert.equal(
    LIVE_STORE_STATE.inventory.find((i) => i.sku === 'SKU-DDR5-64GB-KIT')?.stock,
    28,
    'Compensating undo must restore exact pre-mutation stock (28)'
  );
  assert.equal(undoJson.blocks[0].type, 'COMPENSATING_UNDO');

  const doubleUndo = await app.inject({
    method: 'POST',
    url: '/api/audit-ledger/undo',
    payload: { txId: ramStockTx.txId },
  });
  assert.equal(doubleUndo.statusCode, 409);

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
  assert.equal(verifyAuditChainIntegrity().valid, true);

  // Reset demo restores clean 31-SKU canonical catalog and resets audit ledger to genesis
  const resetRes = await app.inject({ method: 'POST', url: '/api/reset-demo' });
  assert.equal(resetRes.statusCode, 200);
  assert.equal(LIVE_STORE_STATE.inventory.length, 31);
  assert.equal(verifyAuditChainIntegrity().blockCount, 0);

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
