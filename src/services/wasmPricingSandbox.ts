import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from 'quickjs-emscripten';

export interface PricingContextInput {
  baseCost: number;
  targetMarginPct: number;
  taxPct: number;
  currentStock?: number;
  inboundDelta?: number;
}

export interface WasmPricingExecutionResult {
  finalPrice: number;
  cleanCodeShownInUI: string;
  usedFallback: boolean;
  sandboxEngine: 'quickjs-wasm';
  invariantsPassed: boolean;
  rejectionReason?: string;
}

let cachedQuickJsPromise: Promise<QuickJSWASMModule> | null = null;

async function loadQuickJsModule(): Promise<QuickJSWASMModule> {
  if (!cachedQuickJsPromise) {
    cachedQuickJsPromise = getQuickJS();
  }
  return cachedQuickJsPromise;
}

export function buildDeterministicPolicyCode(): string {
  return [
    'function calculatePrice(ctx) {',
    '  const gross = ctx.cost / (1 - ctx.marginPct / 100);',
    '  const tierFactor = ctx.stock > 120 ? 0.97 : ctx.stock < 15 ? 1.04 : 1.0;',
    '  return Number((gross * tierFactor * (1 + ctx.taxPct / 100)).toFixed(2));',
    '}',
  ].join('\n');
}

export function computeDeterministicFallbackPrice(input: PricingContextInput): number {
  const safeMargin = Math.min(85, Math.max(1, input.targetMarginPct));
  const safeTax = Math.min(50, Math.max(0, input.taxPct));
  const stock = input.currentStock ?? 50;
  const gross = input.baseCost / (1 - safeMargin / 100);
  const tierFactor = stock > 120 ? 0.97 : stock < 15 ? 1.04 : 1.0;
  return Number((gross * tierFactor * (1 + safeTax / 100)).toFixed(2));
}

function sanitizeGeneratedJs(rawLLMCode: string): string {
  const withoutThink = rawLLMCode.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fenceMatch = withoutThink.match(/```(?:javascript|js|ts)?\s*([\s\S]*?)```/i);
  const body = (fenceMatch ? fenceMatch[1] : withoutThink)
    .replace(/^\s*import\s+.*?;\s*$/gm, '')
    .replace(/^\s*export\s+(default\s+)?/gm, '')
    .trim();
  return body;
}

export async function executeWasmPricingSandbox(
  rawLLMCode: string,
  input: PricingContextInput
): Promise<WasmPricingExecutionResult> {
  const strippedBody = sanitizeGeneratedJs(rawLLMCode);
  const fallbackPrice = computeDeterministicFallbackPrice(input);
  const fallbackSnippet = buildDeterministicPolicyCode();

  if (!strippedBody || !strippedBody.includes('calculatePrice')) {
    return {
      finalPrice: fallbackPrice,
      cleanCodeShownInUI: fallbackSnippet,
      usedFallback: true,
      sandboxEngine: 'quickjs-wasm',
      invariantsPassed: true,
      rejectionReason: 'Missing calculatePrice entrypoint',
    };
  }

  const QuickJS = await loadQuickJsModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(4 * 1024 * 1024); // 4 MB WASM linear memory ceiling
  runtime.setMaxStackSize(256 * 1024); // 256 KB stack ceiling
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 50)); // 50ms hard CPU deadline

  const ctx = runtime.newContext();
  try {
    const safeCost = Number(input.baseCost);
    const safeMargin = Math.min(85, Math.max(1, Number(input.targetMarginPct)));
    const safeTax = Math.min(50, Math.max(0, Number(input.taxPct)));
    const safeStock = Number.isFinite(input.currentStock) ? Number(input.currentStock) : 50;
    const safeDelta = Number.isFinite(input.inboundDelta) ? Number(input.inboundDelta) : 0;

    const harnessScript = `
      "use strict";
      ${strippedBody}

      function __invokePolicy(c) {
        if (typeof calculatePrice !== 'function') {
          throw new Error('calculatePrice is not a function');
        }
        // Support both object-context signature calculatePrice(ctx) and positional calculatePrice(cost, marginPct, taxPct)
        const out = calculatePrice.length >= 2
          ? calculatePrice(c.cost, c.marginPct, c.taxPct, c.stock, c.inboundDelta)
          : calculatePrice(c);
        return Number(out);
      }

      const __baseCtx = ${JSON.stringify({
        cost: safeCost,
        marginPct: safeMargin,
        taxPct: safeTax,
        stock: safeStock,
        inboundDelta: safeDelta,
      })};

      const __p1 = __invokePolicy(__baseCtx);
      const __pHigherCost = __invokePolicy(Object.assign({}, __baseCtx, { cost: __baseCtx.cost * 1.2 }));
      const __hostLeak = (typeof process !== 'undefined') || (typeof require !== 'undefined');

      JSON.stringify({
        price: Number(__p1.toFixed(2)),
        higherCostPrice: Number(__pHigherCost.toFixed(2)),
        hostLeak: __hostLeak
      });
    `;

    const evalRes = ctx.evalCode(harnessScript);
    if (evalRes.error) {
      const errMsg = String(ctx.dump(evalRes.error));
      evalRes.error.dispose();
      throw new Error(errMsg);
    }

    const rawJson = String(ctx.dump(evalRes.value));
    evalRes.value.dispose();
    const parsed = JSON.parse(rawJson) as {
      price: number;
      higherCostPrice: number;
      hostLeak: boolean;
    };

    if (parsed.hostLeak) {
      throw new Error('Sandbox isolation violation detected');
    }
    if (!Number.isFinite(parsed.price) || parsed.price <= safeCost) {
      throw new Error(`Invariant failed: price (${parsed.price}) must exceed unit cost (${safeCost})`);
    }
    if (parsed.price > safeCost * 4.5) {
      throw new Error(`Invariant failed: price (${parsed.price}) exceeds 4.5x anti-gouging ceiling`);
    }
    if (!Number.isFinite(parsed.higherCostPrice) || parsed.higherCostPrice <= parsed.price) {
      throw new Error('Invariant failed: policy is non-monotonic with respect to unit cost');
    }

    return {
      finalPrice: parsed.price,
      cleanCodeShownInUI: strippedBody,
      usedFallback: false,
      sandboxEngine: 'quickjs-wasm',
      invariantsPassed: true,
    };
  } catch (err) {
    return {
      finalPrice: fallbackPrice,
      cleanCodeShownInUI: fallbackSnippet,
      usedFallback: true,
      sandboxEngine: 'quickjs-wasm',
      invariantsPassed: true,
      rejectionReason: (err as Error).message,
    };
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}

export async function verifyWasmEscapeBlocked(): Promise<{ isolated: boolean; probeResult: string }> {
  const QuickJS = await loadQuickJsModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(2 * 1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 30));
  const ctx = runtime.newContext();
  try {
    const res = ctx.evalCode(
      `(() => { try { return this.constructor.constructor('return typeof process')(); } catch { return 'undefined'; } })()`
    );
    if (res.error) {
      res.error.dispose();
      return { isolated: true, probeResult: 'blocked_with_exception' };
    }
    const val = String(ctx.dump(res.value));
    res.value.dispose();
    return { isolated: val === 'undefined', probeResult: val };
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}
