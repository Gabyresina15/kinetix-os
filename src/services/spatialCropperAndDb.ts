import { NormalizedSpatialObject, RawSamMask } from './spatialNormalizer';
import { OrchestrationPlan } from '../contracts/orchestratorCore';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

let persistenceDb: any = null;

export async function getPersistenceDb(): Promise<any> {
  if (persistenceDb) return persistenceDb;
  try {
    const { MongoClient } = await import('mongodb');
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const client = new MongoClient(uri);
    await client.connect();
    persistenceDb = client.db('kinetix');
    return persistenceDb;
  } catch {
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
  masks: RawSamMask[]
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

export function sanitizeReasoningToTelemetry(
  rawReasoning: string,
  detectedObjects: NormalizedSpatialObject[] = [],
  plan: OrchestrationPlan = { actions: [], summary: '', requiresHumanConfirmation: true }
): string {
  const actionableCount = detectedObjects.filter((o) => !o.isSensitivePII).length;
  const piiCount = detectedObjects.filter((o) => o.isSensitivePII).length;

  const boundTargets = (plan.actions || [])
    .map((a: any) => {
      if (a.targetMaskId) {
        const matched = detectedObjects.find((o) => o.id === a.targetMaskId);
        return matched ? `${matched.label} (${a.tool})` : `${a.targetMaskId} (${a.tool})`;
      }
      return `Global (${a.tool})`;
    })
    .join(' | ');

  const catalogAction = (plan.actions || []).find((a: any) => a.tool === 'generate_studio_catalog') as any;
  const claimAction = (plan.actions || []).find((a: any) => a.tool === 'quarantine_and_claim') as any;

  const cleanThought = (rawReasoning || '')
    .replace(/we need to decide[^.]*\./gi, '')
    .replace(/let's assume[^.]*\./gi, '')
    .replace(/i think[^.]*\./gi, '')
    .replace(/\n+/g, ' ')
    .trim();

  const lines: string[] = [
    `[SCENE_GRAPH] Indexed ${actionableCount} physical objects (${piiCount} PII shields).`,
    `[SEMANTIC_BINDING] ${boundTargets || 'Bound voice intent to scene graph.'}`,
  ];

  if (catalogAction?.visualDna) {
    lines.push(
      `[VISUAL_DNA] ${catalogAction.targetMaskId}: "${catalogAction.visualDna.containerGeometry}" (${catalogAction.visualDna.exactColorPalette}).`
    );
  }

  if (claimAction) {
    const status = claimAction.claimAmountUsd > 100 ? 'HELD (> $100)' : 'AUTO_APPROVED';
    lines.push(`[GUARDRAIL_AUDIT] Claim $${Number(claimAction.claimAmountUsd).toFixed(2)} -> ${status}.`);
  }

  if (cleanThought) {
    lines.push(`[SPARK_TRACE] ${cleanThought.slice(0, 280)}`);
  }

  return lines.join('\n');
}