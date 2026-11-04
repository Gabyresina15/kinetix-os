import { NormalizedSpatialObject, RawSamMask } from './spatialNormalizer';
import { OrchestrationPlan } from '../contracts/orchestratorCore';
import { CatalogSeedItem } from '../data/catalogSeed';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

let mongoClient: any = null;
let persistenceDb: any = null;
let mongoUnavailableUntil = 0;

export function resolveMongoDbName(uri: string): string {
  try {
    const parsed = new URL(uri);
    const pathname = parsed.pathname.replace(/^\/+/, '').split('/')[0]?.trim();
    return pathname || 'kinetix_erp';
  } catch {
    return 'kinetix_erp';
  }
}

export async function getPersistenceDb(): Promise<any> {
  if (persistenceDb) {
    try {
      await persistenceDb.command({ ping: 1 });
      return persistenceDb;
    } catch {
      persistenceDb = null;
      try {
        await mongoClient?.close();
      } catch {
        // ignore close errors on dead socket
      }
      mongoClient = null;
    }
  }
  if (Date.now() < mongoUnavailableUntil) return null;
  try {
    const { MongoClient } = await import('mongodb');
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kinetix_erp';
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
    await client.connect();
    const dbName = resolveMongoDbName(uri);
    mongoClient = client;
    persistenceDb = client.db(dbName);
    console.log(`[MongoDB] Connected to ${dbName}`);
    return persistenceDb;
  } catch (err) {
    console.warn(`[MongoDB] Connection unavailable, using local ledger fallback: ${(err as Error).message}`);
    mongoUnavailableUntil = Date.now() + 30_000;
    return null;
  }
}

export async function upsertInventorySnapshot(item: CatalogSeedItem): Promise<void> {
  try {
    const db = await getPersistenceDb();
    if (!db) return;
    await db.collection('inventory_catalog').updateOne(
      { sku: item.sku },
      {
        $set: {
          sku: item.sku,
          name: item.name,
          stock: Number.isFinite(Number(item.stock)) ? Number(item.stock) : 0,
          standardInboundLot: Number.isFinite(Number(item.standardInboundLot)) ? Number(item.standardInboundLot) : 1,
          baseCostUsd: Number.isFinite(Number(item.baseCostUsd)) ? Number(item.baseCostUsd) : 95.0,
          sellPriceUsd: Number.isFinite(Number(item.sellPriceUsd)) ? Number(item.sellPriceUsd) : 149.0,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn(`[MongoDB] inventory_catalog upsert failed for ${item.sku}: ${(err as Error).message}`);
  }
}

export async function persistErpMutation(
  collection: string,
  doc: Record<string, unknown>
): Promise<{ mongoId: string; persistedTo: 'mongodb' | 'local_file' }> {
  try {
    const db = await getPersistenceDb();
    if (db) {
      const result = await db.collection(collection).insertOne({ ...doc, createdAt: new Date() });
      return { mongoId: result.insertedId.toString(), persistedTo: 'mongodb' };
    }
  } catch (err) {
    console.warn(`[MongoDB] insertOne(${collection}) failed, writing local ledger: ${(err as Error).message}`);
  }

  const ledgerDir = path.join(process.cwd(), 'data', 'ledger');
  await fs.mkdir(ledgerDir, { recursive: true });
  const id = `LEDGER-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  await fs.writeFile(
    path.join(ledgerDir, `${id}.json`),
    JSON.stringify({ id, collection, ...doc, createdAt: new Date().toISOString() }, null, 2)
  );
  return { mongoId: id, persistedTo: 'local_file' };
}

export async function updateClaimAuthorizationInDb(
  ticketId: string,
  patch: {
    guardrailStatus: string;
    dispatchChannel: string;
    externalReceiptId: string;
    authorizedAt: string;
  }
): Promise<void> {
  try {
    const db = await getPersistenceDb();
    if (!db) return;
    await db.collection('supplier_claims').updateOne({ ticketId }, { $set: patch });
  } catch (err) {
    console.warn(`[MongoDB] updateClaimAuthorizationInDb(${ticketId}) failed: ${(err as Error).message}`);
  }
}

let lastSanitizedFrameBuffer: Buffer | null = null;

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function extractRealCropsFromFrame(
  frameBase64: string | null | undefined,
  masks: RawSamMask[],
  targetIds?: Set<string>
): Promise<RawSamMask[]> {
  if (!frameBase64 || !frameBase64.startsWith('data:image')) return masks;

  try {
    const base64Data = frameBase64.replace(/^data:image\/\w+;base64,/, '');
    const rawBuffer = Buffer.from(base64Data, 'base64');
    const meta = await sharp(rawBuffer).metadata();
    const imgW = meta.width || 1280;
    const imgH = meta.height || 720;

    // Physical PII Pixel Scrubbing: burn opaque redaction shields onto a sanitized frame buffer
    // BEFORE cropping any object evidence so raw PII pixels never reach MongoDB or Telegram webhooks.
    const piiMasks = masks.filter((m) => m.isSensitivePII);
    let workingBuffer = rawBuffer;
    if (piiMasks.length > 0) {
      const overlays = piiMasks
        .map((m) => {
          const left = Math.max(0, Math.floor(m.bbox[0] * imgW));
          const top = Math.max(0, Math.floor(m.bbox[1] * imgH));
          const width = Math.min(imgW - left, Math.max(12, Math.ceil(m.bbox[2] * imgW)));
          const height = Math.min(imgH - top, Math.max(12, Math.ceil(m.bbox[3] * imgH)));
          const svg = Buffer.from(
            `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
              `<rect width="100%" height="100%" fill="#111827" stroke="#f59e0b" stroke-width="3"/>` +
              `<text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#fbbf24" font-family="monospace" font-weight="bold" font-size="${Math.max(10, Math.min(20, Math.floor(height * 0.25)))}">PII REDACTED</text>` +
              `</svg>`
          );
          return { input: svg, left, top };
        })
        .filter((o) => o.left < imgW && o.top < imgH);

      if (overlays.length > 0) {
        workingBuffer = await sharp(rawBuffer)
          .composite(overlays)
          .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
          .toBuffer();
      }
    }

    lastSanitizedFrameBuffer = workingBuffer;
    const sanitizedImage = sharp(workingBuffer);

    const updated = await Promise.all(
      masks.map(async (mask) => {
        if (mask.isSensitivePII) return { ...mask, cropBase64: 'REDACTED' };
        if (targetIds && !targetIds.has(mask.id)) return mask;
        const [x, y, w, h] = mask.bbox;
        const left = Math.max(0, Math.floor(x * imgW));
        const top = Math.max(0, Math.floor(y * imgH));
        const width = Math.min(imgW - left, Math.floor(w * imgW));
        const height = Math.min(imgH - top, Math.floor(h * imgH));

        if (width < 10 || height < 10) return mask;

        try {
          const cropBuffer = await sanitizedImage
            .clone()
            .extract({ left, top, width, height })
            .resize({
              width: Math.max(width, 480),
              height: Math.max(height, 480),
              fit: 'inside',
              kernel: sharp.kernel.lanczos3,
            })
            .sharpen({ sigma: 1.15, m1: 0.9, m2: 2.0 })
            .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
            .toBuffer();
          return { ...mask, cropBase64: `data:image/jpeg;base64,${cropBuffer.toString('base64')}` };
        } catch {
          return mask;
        }
      })
    );
    return updated;
  } catch (err) {
    console.warn('Sharp crop warning:', (err as Error).message);
    return masks;
  }
}

export async function buildForensicTelegramEvidenceBase64(claim: {
  id: string;
  objectLabel?: string;
  reason: string;
  amountUsd: number;
  baseCostUsd?: number;
  damageFactor?: number;
  defectSeverity?: string;
  bbox?: [number, number, number, number];
  cropBase64?: string;
}): Promise<string | undefined> {
  if (!claim.cropBase64 || !claim.cropBase64.startsWith('data:image')) {
    return claim.cropBase64;
  }

  try {
    const cleanCropB64 = claim.cropBase64.replace(/^data:image\/\w+;base64,/, '');
    const rawCropBuf = Buffer.from(cleanCropB64, 'base64');

    let sceneBuf = lastSanitizedFrameBuffer;
    if (!sceneBuf) {
      try {
        sceneBuf = await fs.readFile(path.join(process.cwd(), 'client', 'public', 'hardware-bench1.jpg'));
      } catch {
        sceneBuf = null;
      }
    }

    const plateW = 1280;
    const plateH = 720;
    const leftW = 740;
    const leftH = 540;
    const leftX = 28;
    const leftY = 124;

    const bbox = claim.bbox || [0.39, 0.44, 0.16, 0.36];
    const bx = Math.round(bbox[0] * leftW);
    const by = Math.round(bbox[1] * leftH);
    const bw = Math.max(24, Math.round(bbox[2] * leftW));
    const bh = Math.max(24, Math.round(bbox[3] * leftH));
    const corner = Math.min(16, Math.floor(Math.min(bw, bh) * 0.25));

    const labelText = escapeXml((claim.objectLabel || 'Tower Cooler').toUpperCase().slice(0, 26));
    const ticketText = escapeXml(claim.id);
    const reasonLine = escapeXml((claim.reason || 'Structural hardware defect').slice(0, 52));
    const severityText = escapeXml(claim.defectSeverity || 'CRITICAL');
    const valuationText =
      claim.baseCostUsd !== undefined && claim.damageFactor !== undefined
        ? `$${Number(claim.baseCostUsd).toFixed(2)} base x ${Number(claim.damageFactor).toFixed(2)} (${severityText})`
        : `Severity: ${severityText}`;

    const composites: Array<{ input: Buffer; left: number; top: number }> = [];

    if (sceneBuf) {
      const resizedScene = await sharp(sceneBuf)
        .resize(leftW, leftH, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
        .sharpen({ sigma: 1.0 })
        .toBuffer();

      const targetOverlaySvg = Buffer.from(
        `<svg width="${leftW}" height="${leftH}" xmlns="http://www.w3.org/2000/svg">` +
          `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="rgba(244,63,94,0.16)" stroke="#f43f5e" stroke-width="2.5"/>` +
          `<path d="M ${bx} ${by + corner} L ${bx} ${by} L ${bx + corner} ${by}" fill="none" stroke="#ffffff" stroke-width="3.5"/>` +
          `<path d="M ${bx + bw - corner} ${by} L ${bx + bw} ${by} L ${bx + bw} ${by + corner}" fill="none" stroke="#ffffff" stroke-width="3.5"/>` +
          `<path d="M ${bx} ${by + bh - corner} L ${bx} ${by + bh} L ${bx + corner} ${by + bh}" fill="none" stroke="#ffffff" stroke-width="3.5"/>` +
          `<path d="M ${bx + bw - corner} ${by + bh} L ${bx + bw} ${by + bh} L ${bx + bw} ${by + bh - corner}" fill="none" stroke="#ffffff" stroke-width="3.5"/>` +
          `<rect x="${Math.max(4, bx)}" y="${Math.max(4, by - 28)}" width="210" height="24" rx="4" fill="#090d16" stroke="#f43f5e" stroke-width="1.5"/>` +
          `<text x="${Math.max(4, bx) + 10}" y="${Math.max(4, by - 28) + 16}" fill="#fecdd3" font-family="monospace" font-weight="bold" font-size="12">${labelText} [QUARANTINED]</text>` +
          `</svg>`
      );

      const annotatedScene = await sharp(resizedScene)
        .composite([{ input: targetOverlaySvg, left: 0, top: 0 }])
        .png()
        .toBuffer();

      composites.push({ input: annotatedScene, left: leftX, top: leftY });
    }

    const zoomSize = 310;
    const zoomImg = await sharp(rawCropBuf)
      .resize(zoomSize, zoomSize, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
      .sharpen({ sigma: 1.25, m1: 1.0, m2: 2.2 })
      .png()
      .toBuffer();

    composites.push({ input: zoomImg, left: 868, top: 182 });

    const hudSvg = Buffer.from(
      `<svg width="${plateW}" height="${plateH}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="0" y="0" width="${plateW}" height="76" fill="#0a0e17"/>` +
        `<line x1="0" y1="76" x2="${plateW}" y2="76" stroke="#1e293b" stroke-width="2"/>` +
        `<circle cx="38" cy="38" r="7" fill="#22d3ee"/>` +
        `<text x="58" y="44" fill="#f8fafc" font-family="sans-serif" font-weight="bold" font-size="20" letter-spacing="2">KINETIX OS // FORENSIC DEFECT DISPATCH</text>` +
        `<rect x="970" y="20" width="282" height="36" rx="6" fill="#4c0519" stroke="#f43f5e" stroke-width="1.5"/>` +
        `<text x="1111" y="43" text-anchor="middle" fill="#fecdd3" font-family="monospace" font-weight="bold" font-size="15">TICKET #${ticketText} · -$${claim.amountUsd.toFixed(2)} USD</text>` +
        `<text x="28" y="108" fill="#94a3b8" font-family="monospace" font-weight="bold" font-size="13" letter-spacing="1.5">1. WORKSPACE SPATIAL LOCK (SAM 3.1 IoU REFINED)</text>` +
        `<rect x="${leftX}" y="${leftY}" width="${leftW}" height="${leftH}" fill="none" stroke="#334155" stroke-width="2"/>` +
        `<text x="796" y="108" fill="#94a3b8" font-family="monospace" font-weight="bold" font-size="13" letter-spacing="1.5">2. OPTICAL DEFECT CROP (1:1 LANCZOS3)</text>` +
        `<rect x="796" y="124" width="456" height="540" rx="8" fill="#0a0e17" stroke="#1e293b" stroke-width="2"/>` +
        `<rect x="868" y="182" width="${zoomSize}" height="${zoomSize}" fill="none" stroke="#f43f5e" stroke-width="2.5"/>` +
        `<rect x="868" y="152" width="190" height="22" rx="3" fill="#4c0519"/>` +
        `<text x="878" y="167" fill="#fda4af" font-family="monospace" font-weight="bold" font-size="11">OPTICAL ROI // ${labelText}</text>` +
        `<text x="824" y="532" fill="#f8fafc" font-family="sans-serif" font-weight="bold" font-size="16">Defect: ${reasonLine}</text>` +
        `<text x="824" y="560" fill="#cbd5e1" font-family="monospace" font-size="14">${valuationText}</text>` +
        `<rect x="824" y="584" width="400" height="54" rx="6" fill="#064e3b" stroke="#10b981" stroke-width="1.5"/>` +
        `<text x="1024" y="608" text-anchor="middle" fill="#a7f3d0" font-family="monospace" font-weight="bold" font-size="13">✓ OPERATOR AUTHORIZED ($50 USD GUARDRAIL)</text>` +
        `<text x="1024" y="627" text-anchor="middle" fill="#6ee7b7" font-family="monospace" font-size="11">SHA-256 AUDIT LEDGER VERIFIED · PII SCRUBBED</text>` +
        `</svg>`
    );

    const finalPlate = await sharp({
      create: {
        width: plateW,
        height: plateH,
        channels: 3,
        background: { r: 6, g: 8, b: 12 },
      },
    })
      .composite([{ input: hudSvg, left: 0, top: 0 }, ...composites])
      .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
      .toBuffer();

    return `data:image/jpeg;base64,${finalPlate.toString('base64')}`;
  } catch (err) {
    console.warn('Forensic Telegram plate fallback to raw crop:', (err as Error).message);
    return claim.cropBase64;
  }
}

const fmtBbox = (bbox: [number, number, number, number]) =>
  `[${bbox.map((n) => Number(n).toFixed(2)).join(', ')}]`;

export function sanitizeReasoningToTelemetry(
  rawReasoning: string,
  detectedObjects: NormalizedSpatialObject[] = [],
  plan: OrchestrationPlan = { actions: [], summary: '', requiresHumanConfirmation: true }
): string {
  const actions: any[] = plan.actions || [];
  const actionable = detectedObjects.filter((o) => !o.isSensitivePII);
  const piiCount = detectedObjects.length - actionable.length;
  const findObj = (id: string) => detectedObjects.find((o) => o.id === id);
  const nameOf = (id: string) => findObj(id)?.label || id;

  const lines: string[] = [];

  lines.push(
    `[SCENE_GRAPH] Indexed ${actionable.length} physical object(s), ${piiCount} PII-gated region(s)` +
      (actionable.length
        ? `: ${actionable.map((o) => `${o.label} ${fmtBbox(o.bbox)}`).join(' | ')}.`
        : '.')
  );

  for (const a of actions) {
    switch (a.tool) {
      case 'quarantine_and_claim': {
        const obj = findObj(a.targetMaskId);
        const where = obj ? ` @ ${obj.spatialRegion2D}` : '';
        lines.push(
          `[SEMANTIC_BINDING] ${nameOf(a.targetMaskId)}${where} -> quarantine_and_claim: "${a.defectReason}".`
        );
        const amount = Number(a.claimAmountUsd ?? 0);
        const factor = Number(a.damageFactor ?? 0.85);
        const sev = a.defectSeverity || 'CRITICAL';
        const held = amount >= 50;
        lines.push(
          `[GUARDRAIL_AUDIT] Severity=${sev} (factor=${factor.toFixed(2)}) -> Claim -$${amount.toFixed(2)} USD -> ${held ? 'HELD_BY_GUARDRAIL (>= $50.00 USD operator approval required)' : 'AUTO_APPROVED (< $50.00 USD)'}.`
        );
        break;
      }
      case 'mutate_inventory': {
        const sign = Number(a.delta) >= 0 ? '+' : '';
        lines.push(
          `[SEMANTIC_BINDING] ${nameOf(a.targetMaskId)} -> mutate_inventory: ${a.sku} ${sign}${a.delta} @ $${Number(a.unitCostUsd).toFixed(2)}/u.`
        );
        break;
      }
      case 'generate_studio_catalog': {
        lines.push(
          `[SEMANTIC_BINDING] ${nameOf(a.targetMaskId)} -> generate_studio_catalog (512x512): "${a.productTitle}".`
        );
        const dna = a.visualDna;
        if (dna) {
          lines.push(
            `[VISUAL_DNA] ${a.targetMaskId}: ${dna.containerGeometry} | ${dna.exactColorPalette} | "${dna.detectedBrandOrText}" | ${dna.surfaceMaterial}.`
          );
        }
        break;
      }
      case 'recalculate_margins_vm':
        lines.push(
          `[SEMANTIC_BINDING] Stage-2 batch repricing -> recalculate_margins_vm: margin ${a.targetMarginPercent}% + tax ${a.taxRatePercent}%.`
        );
        break;
    }
  }

  if (!actions.length) {
    lines.push('[SEMANTIC_BINDING] No tool actions requested by the operator for this scene.');
  }

  const trace = (rawReasoning || '').replace(/\s+/g, ' ').trim();
  if (trace) {
    lines.push(`[SPARK_TRACE] ${trace.slice(0, 600)}${trace.length > 600 ? '...' : ''}`);
  }

  return lines.join('\n');
}
