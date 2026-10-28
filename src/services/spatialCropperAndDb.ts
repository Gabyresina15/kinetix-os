import { NormalizedSpatialObject, RawSamMask } from './spatialNormalizer';
import { OrchestrationPlan } from '../contracts/orchestratorCore';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

let persistenceDb: any = null;
let mongoUnavailableUntil = 0;

export async function getPersistenceDb(): Promise<any> {
  if (persistenceDb) return persistenceDb;
  if (Date.now() < mongoUnavailableUntil) return null;
  try {
    const { MongoClient } = await import('mongodb');
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
    await client.connect();
    persistenceDb = client.db('kinetix');
    return persistenceDb;
  } catch {
    mongoUnavailableUntil = Date.now() + 30_000;
    return null;
  }
}

export async function persistErpMutation(collection: string, doc: any): Promise<{ mongoId: string }> {
  try {
    const db = await getPersistenceDb();
    if (db) {
      const result = await db.collection(collection).insertOne({ ...doc, createdAt: new Date() });
      return { mongoId: result.insertedId.toString() };
    }
  } catch {}
  const ledgerDir = path.join(process.cwd(), 'data', 'ledger');
  await fs.mkdir(ledgerDir, { recursive: true });
  const id = `LEDGER-${Date.now().toString(36).toUpperCase()}`;
  await fs.writeFile(
    path.join(ledgerDir, `${id}.json`),
    JSON.stringify({ id, collection, ...doc, createdAt: new Date().toISOString() }, null, 2)
  );
  return { mongoId: id };
}

export async function extractRealCropsFromFrame(
  frameBase64: string | null | undefined,
  masks: RawSamMask[],
  targetIds?: Set<string>
): Promise<RawSamMask[]> {
  if (!frameBase64 || !frameBase64.startsWith('data:image')) return masks;

  try {
    const base64Data = frameBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const image = sharp(buffer);
    const meta = await image.metadata();
    const imgW = meta.width || 1280;
    const imgH = meta.height || 720;

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
          const cropBuffer = await image.clone().extract({ left, top, width, height }).jpeg({ quality: 80 }).toBuffer();
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
    `[SCENE_GRAPH] Indexed ${actionable.length} physical object(s), ${piiCount} PII shield(s)` +
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
        const amount = Number(a.claimAmountUsd);
        const held = amount >= 50;
        lines.push(
          `[GUARDRAIL_AUDIT] Claim -$${amount.toFixed(2)} USD -> ${held ? 'HELD_BY_ZERO_TRUST_GUARDRAIL (exceeds $50.00 USD auto-limit)' : 'AUTO_APPROVED (< $50.00 USD)'}.`
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
          `[SEMANTIC_BINDING] ${nameOf(a.targetMaskId)} -> generate_studio_catalog: "${a.productTitle}".`
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
          `[SEMANTIC_BINDING] Global -> recalculate_margins_vm: margin ${a.targetMarginPercent}% + tax ${a.taxRatePercent}%.`
        );
        break;
    }
  }

  if (!actions.length) {
    lines.push('[SEMANTIC_BINDING] No tool actions requested by the operator for this scene.');
  }

  const trace = (rawReasoning || '').replace(/\s+/g, ' ').trim();
  if (trace) {
    lines.push(`[SPARK_TRACE] ${trace.slice(0, 280)}${trace.length > 280 ? '...' : ''}`);
  }

  return lines.join('\n');
}
