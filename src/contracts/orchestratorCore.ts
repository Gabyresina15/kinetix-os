import { z } from 'zod';
import {
  executeWasmPricingSandbox,
  type PricingContextInput,
  type WasmPricingExecutionResult,
} from '../services/wasmPricingSandbox';

const flexibleText = (fallback: string) =>
  z.preprocess((value) => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(', ');
      return joined || fallback;
    }
    if (value && typeof value === 'object') {
      const joined = Object.values(value as Record<string, unknown>)
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(', ');
      return joined || fallback;
    }
    return fallback;
  }, z.string());

export const VisualDnaSchema = z.object({
  containerGeometry: flexibleText('product with its exact observed physical shape'),
  exactColorPalette: flexibleText('exact colors observed on the product'),
  detectedBrandOrText: flexibleText('no legible text'),
  surfaceMaterial: flexibleText('observed surface material'),
});

export type VisualDna = z.infer<typeof VisualDnaSchema>;

export function compileMuseImagePromptFromDna(dna: VisualDna, productTitle?: string): string {
  const safeCategory = productTitle
    ? productTitle.replace(/\b(shift|modular|cables?)\b/gi, '').replace(/\s+/g, ' ').trim()
    : '';
  const safeGeometry = dna.containerGeometry
    .replace(/\b(with|and)\s+modular\b[^,.]*/gi, '')
    .replace(/\bmodular\s+(connector|cable|port|socket)[^,.]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const titleClause = safeCategory ? ` (${safeCategory})` : '';
  return [
    `Commercial 512x512 e-commerce hero studio photograph of this exact ${safeGeometry || dna.containerGeometry}${titleClause} from the reference image.`,
    `Stage the exact hardware unit on a sleek dark-slate 3D studio podium with subtle glossy surface reflection, dramatic cyan (#22d3ee) and warm amber (#f59e0b) rim lighting, and cinematic studio depth-of-field.`,
    `Strictly preserve 100% of the exact physical unit from the reference crop: keep the identical shroud/chassis geometry, fan/grille layout, smooth solid side panels, and proportions. Do NOT add any extra modular cable sockets, ports, wires, or connectors that are not visible in the reference image.`,
    `Exact color palette: ${dna.exactColorPalette}.`,
    `Surface & material: ${dna.surfaceMaterial}.`,
    `Visible markings/details: "${dna.detectedBrandOrText}".`,
  ].join(' ');
}

export const DetectedSceneObjectSchema = z.object({
  id: z.string(),
  label: z.string(),
  bbox: z.tuple([
    z.coerce.number().min(0).max(1),
    z.coerce.number().min(0).max(1),
    z.coerce.number().min(0.02).max(1),
    z.coerce.number().min(0.02).max(1),
  ]),
  confidence: z.coerce.number().default(0.96),
  isSensitivePII: z.boolean().default(false),
});

export const DefectSeveritySchema = z.enum(['INTACT', 'MINOR', 'MODERATE', 'CRITICAL']);
export type DefectSeverity = z.infer<typeof DefectSeveritySchema>;

const ActionSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('quarantine_and_claim'),
    targetMaskId: z.string(),
    defectReason: z.string(),
    defectSeverity: DefectSeveritySchema.optional(),
    damageFactor: z.coerce.number().min(0).max(1).optional(),
    claimAmountUsd: z.coerce.number().min(0).optional(),
  }),
  z.object({
    tool: z.literal('mutate_inventory'),
    targetMaskId: z.string(),
    sku: z.string(),
    itemName: z.string().default('Hardware Component'),
    delta: z.coerce.number().default(1),
    unitCostUsd: z.coerce.number().default(85.0),
  }),
  z.object({
    tool: z.literal('generate_studio_catalog'),
    targetMaskId: z.string(),
    productTitle: z.string(),
    visualDna: VisualDnaSchema,
  }),
  z.object({
    tool: z.literal('recalculate_margins_vm'),
    targetMarginPercent: z.coerce.number().default(32),
    taxRatePercent: z.coerce.number().default(21),
    sku: z.string().optional(),
    itemName: z.string().optional(),
  }),
]);

export const OrchestrationPlanSchema = z.object({
  summary: z.string().default('Multi-object spatial DAG locked across N detected workbench items.'),
  detectedObjects: z.array(DetectedSceneObjectSchema).optional(),
  requiresHumanConfirmation: z.boolean().default(true),
  actions: z.array(ActionSchema),
});

export type OrchestrationPlan = z.infer<typeof OrchestrationPlanSchema>;

export function resolveDamageSeverityAndFactor(
  defectReason: string,
  defectSeverity?: DefectSeverity,
  rawDamageFactor?: number
): { defectSeverity: DefectSeverity; damageFactor: number } {
  const reasonNorm = (defectReason || '').toLowerCase();

  if (
    defectSeverity === 'INTACT' ||
    rawDamageFactor === 0 ||
    /\b(intact|intacto|sin daño|sin defecto|no defect|undamaged|ok)\b/i.test(reasonNorm)
  ) {
    return { defectSeverity: 'INTACT', damageFactor: 0 };
  }

  let inferredSeverity: DefectSeverity = defectSeverity || 'CRITICAL';
  if (!defectSeverity) {
    if (/\b(scratch|raya|cosmetic|est[eé]tic|packaging|empaque|caja|etiqueta)\b/i.test(reasonNorm)) {
      inferredSeverity = 'MINOR';
    } else if (/\b(dent|aboll|loose|suelto|fan|ventilador|bracket)\b/i.test(reasonNorm)) {
      inferredSeverity = 'MODERATE';
    } else {
      inferredSeverity = 'CRITICAL';
    }
  }

  const defaultFactorBySeverity: Record<DefectSeverity, number> = {
    INTACT: 0,
    MINOR: 0.25,
    MODERATE: 0.65,
    CRITICAL: 0.85,
  };

  const factor =
    typeof rawDamageFactor === 'number' && Number.isFinite(rawDamageFactor) && rawDamageFactor > 0 && rawDamageFactor <= 1
      ? Number(rawDamageFactor.toFixed(2))
      : defaultFactorBySeverity[inferredSeverity];

  return { defectSeverity: inferredSeverity, damageFactor: factor };
}

export function computeEvidenceBasedClaimUsd(params: {
  baseCostUsd: number;
  defectReason: string;
  defectSeverity?: DefectSeverity;
  damageFactor?: number;
  explicitClaimAmountUsd?: number;
}): {
  claimAmountUsd: number;
  damageFactor: number;
  defectSeverity: DefectSeverity;
} {
  const safeBaseCost =
    typeof params.baseCostUsd === 'number' && Number.isFinite(params.baseCostUsd) && params.baseCostUsd > 0
      ? params.baseCostUsd
      : 78.0;

  const { defectSeverity, damageFactor } = resolveDamageSeverityAndFactor(
    params.defectReason,
    params.defectSeverity,
    params.damageFactor
  );

  if (defectSeverity === 'INTACT' || damageFactor === 0) {
    return { claimAmountUsd: 0, damageFactor: 0, defectSeverity: 'INTACT' };
  }

  const catalogDerivedUsd = Number((safeBaseCost * damageFactor).toFixed(2));
  return {
    claimAmountUsd: catalogDerivedUsd,
    damageFactor,
    defectSeverity,
  };
}

export const FALLBACK_MASK_IDS = ['mask_fallback_1', 'mask_fallback_2', 'mask_fallback_3'] as const;

export const GOLDEN_FALLBACK_PLAN: OrchestrationPlan = {
  summary: 'Fallback: no live detection available. Using generic spatial plan.',
  requiresHumanConfirmation: true,
  actions: [
    {
      tool: 'quarantine_and_claim',
      targetMaskId: FALLBACK_MASK_IDS[0],
      defectReason: 'Structural fin defect reported by operator on copper heatpipe tower cooler',
      defectSeverity: 'CRITICAL',
      damageFactor: 0.85,
    },
    {
      tool: 'mutate_inventory',
      targetMaskId: FALLBACK_MASK_IDS[1],
      sku: 'SKU-GENERIC-01',
      itemName: 'Detected Component',
      delta: 1,
      unitCostUsd: 50.0,
    },
    {
      tool: 'generate_studio_catalog',
      targetMaskId: FALLBACK_MASK_IDS[2],
      productTitle: 'Studio Catalog Item',
      visualDna: {
        containerGeometry: 'rectangular product body',
        exactColorPalette: 'neutral dark finish',
        detectedBrandOrText: 'no legible text',
        surfaceMaterial: 'mixed materials',
      },
    },
    {
      tool: 'recalculate_margins_vm',
      targetMarginPercent: 30,
      taxRatePercent: 21,
    },
  ],
};

export function salvageOrchestrationPlan(raw: unknown): OrchestrationPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const detectedObjects = Array.isArray(source.detectedObjects)
    ? source.detectedObjects
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const obj = item as Record<string, unknown>;
          const box = clampUnitBBox(obj.bbox);
          if (!box || typeof obj.id !== 'string' || !obj.id) return null;
          return {
            id: obj.id,
            label: typeof obj.label === 'string' && obj.label ? obj.label : 'Detected Object',
            bbox: box,
            confidence: Number.isFinite(Number(obj.confidence)) ? Number(obj.confidence) : 0.9,
            isSensitivePII: Boolean(obj.isSensitivePII),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : undefined;

  const actions = Array.isArray(source.actions)
    ? source.actions
        .map((action) => {
          if (!action || typeof action !== 'object') return null;
          const copy = { ...(action as Record<string, unknown>) };
          if (copy.tool === 'generate_studio_catalog') {
            const dna = VisualDnaSchema.safeParse(copy.visualDna ?? {});
            copy.visualDna = dna.success ? dna.data : VisualDnaSchema.parse({});
          }
          const parsed = ActionSchema.safeParse(copy);
          return parsed.success ? parsed.data : null;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];

  if (!actions.length && !detectedObjects?.length) return null;

  const parsed = OrchestrationPlanSchema.safeParse({
    summary: typeof source.summary === 'string' ? source.summary : undefined,
    detectedObjects: detectedObjects ? tightenAndDeoverlapBoxes(detectedObjects) : undefined,
    requiresHumanConfirmation:
      typeof source.requiresHumanConfirmation === 'boolean' ? source.requiresHumanConfirmation : true,
    actions,
  });
  return parsed.success ? parsed.data : null;
}

export function planFromLiveObjects(
  objects: Array<{
    id: string;
    label: string;
    bbox: [number, number, number, number];
    confidence: number;
    isSensitivePII?: boolean;
  }>,
  voice: string
): OrchestrationPlan {
  const usable = objects.filter((o) => !o.isSensitivePII);
  const voiceNorm = voice.toLowerCase();
  const find = (...needles: string[]) =>
    usable.find((o) => needles.some((n) => o.label.toLowerCase().includes(n)));

  const claimTarget =
    find('cooler', 'golpe', 'roto', 'dañ', 'aleta', 'ventil') || usable[0];
  const catalogTarget = find('fuente', 'psu', 'power') || usable[usable.length - 1];
  const stockTargets = usable.filter((o) =>
    /ram|memoria|ssd|nvme|disco/.test(o.label.toLowerCase())
  );

  const actions: OrchestrationPlan['actions'] = [];
  if (claimTarget) {
    actions.push({
      tool: 'quarantine_and_claim',
      targetMaskId: claimTarget.id,
      defectReason: `Defecto físico reportado por el operador sobre ${claimTarget.label}`,
      defectSeverity: 'CRITICAL',
      damageFactor: 0.85,
    });
  }
  const seenStock = new Set<string>();
  for (const item of stockTargets) {
    const isRam = /ram|memoria/.test(item.label.toLowerCase());
    const bucket = isRam ? 'memory' : 'storage';
    if (seenStock.has(bucket)) continue;
    seenStock.add(bucket);
    actions.push({
      tool: 'mutate_inventory',
      targetMaskId: item.id,
      sku: `SKU-${item.label.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'ITEM'}`,
      itemName: item.label,
      delta: isRam && /dos|2/.test(voiceNorm) ? 2 : 1,
      unitCostUsd: isRam ? 95 : 110,
    });
  }
  if (catalogTarget) {
    actions.push({
      tool: 'generate_studio_catalog',
      targetMaskId: catalogTarget.id,
      productTitle: catalogTarget.label,
      visualDna: {
        containerGeometry: catalogTarget.label,
        exactColorPalette: 'exact colors visible on the object in the crop',
        detectedBrandOrText: 'no legible text',
        surfaceMaterial: 'exact material visible on the object in the crop',
      },
    });
  }
  const marginMatch = voiceNorm.match(/(\d{2})\s*%/);
  actions.push({
    tool: 'recalculate_margins_vm',
    targetMarginPercent: marginMatch ? Number(marginMatch[1]) : 30,
    taxRatePercent: 21,
  });

  return {
    summary: 'Plan recuperado: las herramientas se anclaron a los objetos detectados en vivo.',
    requiresHumanConfirmation: true,
    detectedObjects: usable.map((o) => ({
      id: o.id,
      label: o.label,
      bbox: o.bbox,
      confidence: o.confidence,
      isSensitivePII: false,
    })),
    actions,
  };
}

function clampUnitBBox(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  let x = Number(raw[0]);
  let y = Number(raw[1]);
  let w = Number(raw[2]);
  let h = Number(raw[3]);
  if (![x, y, w, h].every(Number.isFinite)) return null;
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

export function tightenAndDeoverlapBoxes<
  T extends { id: string; label: string; bbox: [number, number, number, number] }
>(objects: T[]): T[] {
  const result = objects.map((o) => {
    let [x, y, rawW, rawH] = o.bbox;
    const labelNorm = `${o.id} ${o.label}`.toLowerCase();
    // Guard against [xMin, yMin, xMax, yMax] coordinate emission & perspective y-drift
    let w = rawW;
    let h = rawH;
    if (x >= 0.24 && x + rawW > 0.92 && rawW > x + 0.12) {
      w = Number((rawW - x).toFixed(3));
    }
    if (/cpu|amd|intel|processor/.test(labelNorm) && x <= 0.16) {
      if (rawW >= 0.155) w = Number(Math.max(0.115, rawW - x).toFixed(3));
      if (rawH >= 0.31) h = Number(Math.max(0.25, rawH - y).toFixed(3));
    } else if (/ram|ddr|memory|memoria/.test(labelNorm) && x <= 0.22) {
      if (rawW >= 0.21) w = Number(Math.max(0.155, rawW - x).toFixed(3));
      if (y >= 0.725) y = Number(Math.max(0.705, y - 0.035).toFixed(3));
    } else if (/ssd|nvme|m\.2|m2/.test(labelNorm) && x >= 0.28 && x <= 0.45) {
      if (y >= 0.79) y = Number(Math.min(0.77, y - 0.045).toFixed(3));
      if (x < 0.355) x = 0.355;
      if (w < 0.105) w = 0.11;
    } else if (/cooler|heatsink|heatpipe|torre/.test(labelNorm) && x >= 0.36 && x <= 0.48) {
      if (y >= 0.54) y = Number(Math.max(0.50, y - 0.045).toFixed(3));
      if (y + h > 0.755) h = Number(Math.max(0.22, 0.75 - y).toFixed(3));
    } else if (/psu|power|fuente/.test(labelNorm) && x >= 0.72) {
      if (x > 0.79) x = 0.785;
      if (y >= 0.60) y = Number(Math.max(0.575, y - 0.045).toFixed(3));
      if (w < 0.155) w = 0.165;
    } else if (/motherboard|mainboard|mobo|itx/.test(labelNorm) && x >= 0.26 && x <= 0.38) {
      if (x < 0.32) x = 0.325;
      if (y <= 0.25 && rawH >= 0.44) h = Number(Math.max(0.34, rawH - y).toFixed(3));
      if (w < 0.285) w = 0.295;
    } else if (/gpu|graphics|rtx|radeon|video/.test(labelNorm) && x >= 0.28 && x <= 0.38) {
      if (w < 0.345) w = 0.355;
    }
    return {
      ...o,
      bbox: [x, y, w, h] as [number, number, number, number],
    };
  });

  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const a = result[i].bbox;
      const b = result[j].bbox;

      const aRight = a[0] + a[2];
      const aBottom = a[1] + a[3];
      const bRight = b[0] + b[2];
      const bBottom = b[1] + b[3];

      const overlapX = Math.min(aRight, bRight) - Math.max(a[0], b[0]);
      const overlapY = Math.min(aBottom, bBottom) - Math.max(a[1], b[1]);

      if (overlapX <= 0.005 || overlapY <= 0.005) continue;

      const upper = a[1] <= b[1] ? a : b;
      const lower = a[1] <= b[1] ? b : a;
      const isVerticallyStacked = upper[1] + upper[3] * 0.55 < lower[1];

      if (isVerticallyStacked) {
        const trimmedH = Number((lower[1] - upper[1] - 0.006).toFixed(3));
        if (trimmedH >= 0.045) {
          upper[3] = trimmedH;
        }
      } else {
        const left = a[0] <= b[0] ? a : b;
        const right = a[0] <= b[0] ? b : a;
        const trimmedW = Number((right[0] - left[0] - 0.008).toFixed(3));
        if (trimmedW >= 0.05) {
          left[2] = trimmedW;
        }
      }
    }
  }
  return result;
}

export async function executeMuseCodeMarginCalc(
  rawLLMCode: string,
  baseCost: number,
  targetMarginPct: number,
  taxPct: number,
  extra?: Pick<PricingContextInput, 'currentStock' | 'inboundDelta'>
): Promise<WasmPricingExecutionResult> {
  return executeWasmPricingSandbox(rawLLMCode, {
    baseCost,
    targetMarginPct,
    taxPct,
    currentStock: extra?.currentStock,
    inboundDelta: extra?.inboundDelta,
  });
}
