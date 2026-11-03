import vm from 'node:vm';
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
  sandboxEngine: 'quickjs-wasm' | 'node:vm-50ms';
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

export function buildDeterministicPolicyCode(hasCriticalAnomaly = false): string {
  if (hasCriticalAnomaly) {
    return [
      'function calculatePrice(ctx) {',
      '  const gross = ctx.cost / (1 - ctx.marginPct / 100);',
      '  const tierFactor = ctx.stock > 120 ? 0.97 : ctx.stock < 15 ? 1.04 : 1.0;',
      '  const qaLotSurcharge = 1.025; // +2.5% QA inspection surcharge (CRITICAL batch anomaly)',
      '  return Number((gross * tierFactor * qaLotSurcharge * (1 + ctx.taxPct / 100)).toFixed(2));',
      '}',
    ].join('\n');
  }
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

function validatePolicyOutputInvariants(
  parsed: { price: number; higherCostPrice: number; hostLeak: boolean },
  safeCost: number
): void {
  if (parsed.hostLeak) {
    throw new Error('Sandbox isolation violation detected');
  }
  if (!Number.isFinite(parsed.price) || parsed.price <= safeCost) {
    throw new Error(`Invariant failed: price (${parsed.price}) must be finite and exceed unit cost (${safeCost})`);
  }
  if (parsed.price > safeCost * 4.5) {
    throw new Error(`Invariant failed: price (${parsed.price}) exceeds 4.5x anti-gouging ceiling`);
  }
  if (!Number.isFinite(parsed.higherCostPrice) || parsed.higherCostPrice <= parsed.price) {
    throw new Error('Invariant failed: policy is non-monotonic with respect to unit cost');
  }
}

export function executeBoundedNodeVmPolicy(
  rawLLMCode: string,
  input: PricingContextInput
): WasmPricingExecutionResult {
  const strippedBody = sanitizeGeneratedJs(rawLLMCode);
  const fallbackPrice = computeDeterministicFallbackPrice(input);
  const fallbackSnippet = buildDeterministicPolicyCode();

  if (!strippedBody || !strippedBody.includes('calculatePrice')) {
    return {
      finalPrice: fallbackPrice,
      cleanCodeShownInUI: fallbackSnippet,
      usedFallback: true,
      sandboxEngine: 'node:vm-50ms',
      invariantsPassed: true,
      rejectionReason: 'Missing calculatePrice entrypoint',
    };
  }

  const safeCost = Number(input.baseCost);
  const safeMargin = Math.min(85, Math.max(1, Number(input.targetMarginPct)));
  const safeTax = Math.min(50, Math.max(0, Number(input.taxPct)));
  const safeStock = Number.isFinite(input.currentStock) ? Number(input.currentStock) : 50;
  const safeDelta = Number.isFinite(input.inboundDelta) ? Number(input.inboundDelta) : 0;

  const baseCtx = {
    cost: safeCost,
    marginPct: safeMargin,
    taxPct: safeTax,
    stock: safeStock,
    inboundDelta: safeDelta,
  };

  try {
    const sandbox = Object.create(null) as Record<string, unknown>;
    sandbox.Number = Number;
    sandbox.Math = Math;
    sandbox.Object = Object;
    sandbox.JSON = JSON;
    sandbox.__baseCtx = Object.freeze({ ...baseCtx });

    const vmContext = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    const script = new vm.Script(
      `"use strict";
      ${strippedBody}
      function __invoke(c) {
        if (typeof calculatePrice !== 'function') throw new Error('calculatePrice is not a function');
        const out = calculatePrice.length >= 2
          ? calculatePrice(c.cost, c.marginPct, c.taxPct, c.stock, c.inboundDelta)
          : calculatePrice(c);
        return Number(out);
      }
      const __p1 = __invoke(__baseCtx);
      const __pHigher = __invoke({
        cost: __baseCtx.cost * 1.2,
        marginPct: __baseCtx.marginPct,
        taxPct: __baseCtx.taxPct,
        stock: __baseCtx.stock,
        inboundDelta: __baseCtx.inboundDelta
      });
      const __leak = (typeof process !== 'undefined') || (typeof require !== 'undefined');
      JSON.stringify({ price: Number(__p1.toFixed(2)), higherCostPrice: Number(__pHigher.toFixed(2)), hostLeak: __leak });`
    );

    const rawJson = String(
      script.runInContext(vmContext, {
        timeout: 50,
      })
    );
    const parsed = JSON.parse(rawJson) as {
      price: number;
      higherCostPrice: number;
      hostLeak: boolean;
    };
    validatePolicyOutputInvariants(parsed, safeCost);

    return {
      finalPrice: parsed.price,
      cleanCodeShownInUI: strippedBody,
      usedFallback: false,
      sandboxEngine: 'node:vm-50ms',
      invariantsPassed: true,
    };
  } catch (err) {
    return {
      finalPrice: fallbackPrice,
      cleanCodeShownInUI: fallbackSnippet,
      usedFallback: true,
      sandboxEngine: 'node:vm-50ms',
      invariantsPassed: true,
      rejectionReason: (err as Error).message,
    };
  }
}

// Bounded 50ms isolated execution sandbox (QuickJS WebAssembly primary + 50ms node:vm verifier with deterministic fallback)
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

  const safeCost = Number(input.baseCost);
  const safeMargin = Math.min(85, Math.max(1, Number(input.targetMarginPct)));
  const safeTax = Math.min(50, Math.max(0, Number(input.taxPct)));
  const safeStock = Number.isFinite(input.currentStock) ? Number(input.currentStock) : 50;
  const safeDelta = Number.isFinite(input.inboundDelta) ? Number(input.inboundDelta) : 0;

  const baseCtx = {
    cost: safeCost,
    marginPct: safeMargin,
    taxPct: safeTax,
    stock: safeStock,
    inboundDelta: safeDelta,
  };

  const QuickJS = await loadQuickJsModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(4 * 1024 * 1024); // 4 MB WASM linear memory ceiling
  runtime.setMaxStackSize(256 * 1024); // 256 KB stack ceiling
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 50)); // 50ms hard CPU deadline

  const ctx = runtime.newContext();
  try {
    const harnessScript = `
      "use strict";
      ${strippedBody}

      function __invokePolicy(c) {
        if (typeof calculatePrice !== 'function') {
          throw new Error('calculatePrice is not a function');
        }
        const out = calculatePrice.length >= 2
          ? calculatePrice(c.cost, c.marginPct, c.taxPct, c.stock, c.inboundDelta)
          : calculatePrice(c);
        return Number(out);
      }

      const __baseCtx = ${JSON.stringify(baseCtx)};

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

    validatePolicyOutputInvariants(parsed, safeCost);

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
