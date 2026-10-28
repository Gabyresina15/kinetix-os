import vm from 'node:vm';
import { z } from 'zod';

export const VisualDnaSchema = z.object({
  containerGeometry: z.string().default('product with its exact observed physical shape'),
  exactColorPalette: z.string().default('exact colors observed on the product'),
  detectedBrandOrText: z.string().default('no legible text'),
  surfaceMaterial: z.string().default('observed surface material'),
});

export type VisualDna = z.infer<typeof VisualDnaSchema>;

export function compileMuseImagePromptFromDna(dna: VisualDna): string {
  return [
    `Commercial 8k studio product photography of a ${dna.containerGeometry}.`,
    `Exact color palette: ${dna.exactColorPalette}.`,
    `Surface & material: ${dna.surfaceMaterial}.`,
    `Visible markings/details: "${dna.detectedBrandOrText}".`,
    `Centered on a dark slate tech podium, dramatic cyan and warm amber rim lighting, ultra-crisp studio hardware hero shot.`,
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

const ActionSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('quarantine_and_claim'),
    targetMaskId: z.string(),
    defectReason: z.string(),
    claimAmountUsd: z.coerce.number().default(145.0),
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
  }),
]);

export const OrchestrationPlanSchema = z.object({
  summary: z.string().default('Multi-object spatial DAG locked across N detected workbench items.'),
  detectedObjects: z.array(DetectedSceneObjectSchema).optional(),
  requiresHumanConfirmation: z.boolean().default(true),
  actions: z.array(ActionSchema),
});

export type OrchestrationPlan = z.infer<typeof OrchestrationPlanSchema>;

export const FALLBACK_MASK_IDS = ['mask_fallback_1', 'mask_fallback_2', 'mask_fallback_3'] as const;

export const GOLDEN_FALLBACK_PLAN: OrchestrationPlan = {
  summary: 'Fallback: no live detection available. Using generic spatial plan.',
  requiresHumanConfirmation: true,
  actions: [
    {
      tool: 'quarantine_and_claim',
      targetMaskId: FALLBACK_MASK_IDS[0],
      defectReason: 'Damaged item reported by operator',
      claimAmountUsd: 120.0,
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
            copy.visualDna = VisualDnaSchema.parse(copy.visualDna ?? {});
          }
          const parsed = ActionSchema.safeParse(copy);
          return parsed.success ? parsed.data : null;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];

  if (!actions.length && !detectedObjects?.length) return null;

  const parsed = OrchestrationPlanSchema.safeParse({
    summary: typeof source.summary === 'string' ? source.summary : undefined,
    detectedObjects,
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
      defectReason: `Defecto reportado por el operador sobre ${claimTarget.label}`,
      claimAmountUsd: 120,
    });
  }
  for (const item of stockTargets) {
    const isRam = /ram|memoria/.test(item.label.toLowerCase());
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

export function executeMuseCodeMarginCalc(
  rawLLMCode: string,
  baseCost: number,
  targetMarginPct: number,
  taxPct: number
): { finalPrice: number; cleanCodeShownInUI: string; usedFallback: boolean } {
  const strippedBody = rawLLMCode
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```\w*\n?|\n?```/g, '')
    .replace(/import\s+.*?from\s+['"].*?['"];?/g, '')
    .trim();

  const deterministicFallbackPrice = Number(
    ((baseCost / (1 - targetMarginPct / 100)) * (1 + taxPct / 100)).toFixed(2)
  );

  try {
    const sandbox = { baseCost, targetMarginPct, taxPct, outputPrice: 0 };
    vm.createContext(sandbox);

    const wrappedScript = `
      ${strippedBody}
      if (typeof calculatePrice === 'function') {
        outputPrice = Number(calculatePrice(baseCost, targetMarginPct, taxPct).toFixed(2));
      }
    `;
    vm.runInContext(wrappedScript, sandbox, { timeout: 300 });

    if (typeof sandbox.outputPrice === 'number' && sandbox.outputPrice > baseCost && !Number.isNaN(sandbox.outputPrice)) {
      return {
        finalPrice: sandbox.outputPrice,
        cleanCodeShownInUI: strippedBody,
        usedFallback: false,
      };
    }
    throw new Error('Invalid numerical output from VM');
  } catch {
    const fallbackCodeSnippet = `function calculatePrice(cost, marginPct, taxPct) {\n  const netMarginPrice = cost / (1 - (marginPct / 100));\n  return netMarginPrice * (1 + (taxPct / 100));\n}`;
    return {
      finalPrice: deterministicFallbackPrice,
      cleanCodeShownInUI: fallbackCodeSnippet,
      usedFallback: true,
    };
  }
}