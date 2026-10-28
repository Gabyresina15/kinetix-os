import vm from 'node:vm';
import { z } from 'zod';

export const VisualDnaSchema = z.object({
  containerGeometry: z.string().default('modular ATX power supply unit chassis with fan grille'),
  exactColorPalette: z.string().default('matte stealth black anodized metal'),
  detectedBrandOrText: z.string().default('MODULAR 850W 80+ GOLD PSU'),
  surfaceMaterial: z.string().default('powder-coated steel enclosure'),
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

export const GOLDEN_FALLBACK_PLAN: OrchestrationPlan = {
  summary:
    'Resolved 10 spatial masks: quarantined damaged CPU Air Cooler, ingested RAM + NVMe into stock, synthesized 8K studio asset for Modular PSU, recalculated 32% margins.',
  requiresHumanConfirmation: true,
  actions: [
    {
      tool: 'quarantine_and_claim',
      targetMaskId: 'mask_air_cooler',
      defectReason: 'Bent upper aluminum cooling fin & copper heatpipe dent on Tower CPU Cooler',
      claimAmountUsd: 165.0,
    },
    {
      tool: 'mutate_inventory',
      targetMaskId: 'mask_ram_sticks',
      sku: 'SKU-DDR5-32GB-KIT',
      itemName: 'Fury Beast DDR5 32GB (2x16GB) Black',
      delta: 2,
      unitCostUsd: 95.0,
    },
    {
      tool: 'mutate_inventory',
      targetMaskId: 'mask_nvme_ssd',
      sku: 'SKU-NVME-2TB-GEN4',
      itemName: 'M.2 NVMe PCIe 4.0 SSD 2TB',
      delta: 1,
      unitCostUsd: 110.0,
    },
    {
      tool: 'generate_studio_catalog',
      targetMaskId: 'mask_psu_modular',
      productTitle: 'Kinetix 850W 80+ Gold Full-Modular ATX PSU',
      visualDna: {
        containerGeometry: 'rectangular ATX modular power supply unit with top fan grille',
        exactColorPalette: 'matte obsidian black casing with subtle metallic dark grey grille',
        detectedBrandOrText: 'FULL MODULAR ATX PSU // 12VHPWR READY',
        surfaceMaterial: 'brushed powder-coated steel chassis',
      },
    },
    {
      tool: 'recalculate_margins_vm',
      targetMarginPercent: 32,
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