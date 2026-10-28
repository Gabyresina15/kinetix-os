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

export const OrchestrationPlanSchema = z.object({
  summary: z.string().default('Multi-object spatial DAG locked across N detected workbench items.'),
  detectedObjects: z.array(DetectedSceneObjectSchema).optional(),
  requiresHumanConfirmation: z.boolean().default(true),
  actions: z.array(
    z.discriminatedUnion('tool', [
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
    ])
  ),
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