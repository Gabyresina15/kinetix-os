import { z } from 'zod';
import vm from 'node:vm';

// ============================================================================
// CONTRATOS ZOD ESTRICTOS
// ============================================================================

export const SpatialObjectSchema = z.object({
  maskId: z.string(),
  zone: z.enum(['LEFT', 'CENTER', 'RIGHT', 'BOTTOM_PII']),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  cropBase64: z.string(),
  isSensitivePII: z.boolean().default(false),
});

export const SpatialSceneSchema = z.object({
  objects: z.array(SpatialObjectSchema),
});

export const OrchestrationPlanSchema = z.object({
  summary: z.string(),
  requiresHumanConfirmation: z.boolean(),
  edgeTelemetry: z
    .object({
      piiMasksRedacted: z.number().optional(),
      estimatedCloudTokensSavedPct: z.number().optional(),
    })
    .optional(),
  actions: z.array(
    z.discriminatedUnion('tool', [
      z.object({
        tool: z.literal('quarantine_and_claim'),
        targetMaskId: z.string(),
        defectReason: z.string(),
        claimAmountUsd: z.number(),
      }),
      z.object({
        tool: z.literal('mutate_inventory'),
        targetMaskId: z.string(),
        sku: z.string(),
        delta: z.number(),
      }),
      z.object({
        tool: z.literal('generate_studio_catalog'),
        targetMaskId: z.string(),
        productTitle: z.string(),
        museImagePrompt: z.string(),
      }),
      z.object({
        tool: z.literal('recalculate_margins_vm'),
        targetMarginPercent: z.number(),
        taxRatePercent: z.number(),
      }),
    ])
  ),
});

export type SpatialScene = z.infer<typeof SpatialSceneSchema>;
export type OrchestrationPlan = z.infer<typeof OrchestrationPlanSchema>;

// ============================================================================
// SANDBOX SEGURO PARA MUSE CODE (node:vm con Fallback)
// ============================================================================

export function executeMuseCodeMarginCalc(
  rawLLMCode: string,
  baseCost: number,
  targetMarginPct: number,
  taxPct: number
): { finalPrice: number; cleanCodeShownInUI: string; usedFallback: boolean } {
  const strippedBody = rawLLMCode
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

    if (typeof sandbox.outputPrice === 'number' && sandbox.outputPrice > baseCost) {
      return {
        finalPrice: sandbox.outputPrice,
        cleanCodeShownInUI: strippedBody,
        usedFallback: false,
      };
    }
    throw new Error('Invalid numerical output from VM');
  } catch {
    const fallbackCodeSnippet = `function calculatePrice(cost, marginPct, taxPct) {\n  const net = cost / (1 - marginPct / 100);\n  return net * (1 + taxPct / 100);\n}`;
    return {
      finalPrice: deterministicFallbackPrice,
      cleanCodeShownInUI: fallbackCodeSnippet,
      usedFallback: true,
    };
  }
}
