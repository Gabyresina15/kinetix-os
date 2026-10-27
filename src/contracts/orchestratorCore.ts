import vm from 'node:vm';
import { z } from 'zod';

export const OrchestrationPlanSchema = z.object({
  summary: z.string().default('Parallel spatial DAG execution plan locked.'),
  requiresHumanConfirmation: z.boolean().default(true),
  actions: z.array(
    z.discriminatedUnion('tool', [
      z.object({
        tool: z.literal('quarantine_and_claim'),
        targetMaskId: z.string().default('mask_left_01'),
        defectReason: z.string().default('Structural container damage detected in LEFT zone'),
        claimAmountUsd: z.coerce.number().default(145.0),
      }),
      z.object({
        tool: z.literal('mutate_inventory'),
        targetMaskId: z.string().default('mask_center_02'),
        sku: z.string().default('SKU-WHEY-2LB'),
        delta: z.coerce.number().default(12),
      }),
      z.object({
        tool: z.literal('generate_studio_catalog'),
        targetMaskId: z.string().default('mask_right_03'),
        productTitle: z.string().default('Titan Micronized Creatine 500g - Black Series'),
        museImagePrompt: z.string().default('Commercial studio product shot on dark slate podium'),
      }),
      z.object({
        tool: z.literal('recalculate_margins_vm'),
        targetMarginPercent: z.coerce.number().default(30),
        taxRatePercent: z.coerce.number().default(21),
      }),
    ])
  ),
});

export type OrchestrationPlan = z.infer<typeof OrchestrationPlanSchema>;

export const GOLDEN_FALLBACK_PLAN: OrchestrationPlan = {
  summary: 'Executing 4 parallel spatial mutations across inventory, claims, studio catalog, and financial VM.',
  requiresHumanConfirmation: true,
  actions: [
    {
      tool: 'quarantine_and_claim',
      targetMaskId: 'mask_left_01',
      defectReason: 'Structural side dent detected on incoming lot',
      claimAmountUsd: 145.0,
    },
    {
      tool: 'mutate_inventory',
      targetMaskId: 'mask_center_02',
      sku: 'SKU-WHEY-2LB',
      delta: 12,
    },
    {
      tool: 'generate_studio_catalog',
      targetMaskId: 'mask_right_03',
      productTitle: 'Titan Micronized Creatine 500g - Black Series',
      museImagePrompt:
        'Commercial studio product shot, matte black supplement container, dark slate surface, cyan rim light',
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
