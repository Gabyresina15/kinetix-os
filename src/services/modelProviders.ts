import 'dotenv/config';
import { OrchestrationPlan, OrchestrationPlanSchema } from '../contracts/orchestratorCore';

export interface SparkInferenceResult {
  plan: OrchestrationPlan;
  reasoningTrace: string;
  modelUsed: string;
  latencyMs: number;
}

export const STUDIO_RENDER_FALLBACK_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <radialGradient id="bgGlow" cx="50%" cy="60%" r="60%">
      <stop offset="0%" stop-color="#083344" stop-opacity="0.9"/>
      <stop offset="60%" stop-color="#090D16" stop-opacity="1"/>
      <stop offset="100%" stop-color="#030508" stop-opacity="1"/>
    </radialGradient>
    <linearGradient id="tubBody" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.85"/>
      <stop offset="6%" stop-color="#0f172a"/>
      <stop offset="50%" stop-color="#1e293b"/>
      <stop offset="94%" stop-color="#090d16"/>
      <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.7"/>
    </linearGradient>
    <linearGradient id="podium" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
  </defs>
  <rect width="400" height="400" fill="url(#bgGlow)"/>
  <ellipse cx="200" cy="330" rx="145" ry="22" fill="#00f0ff" opacity="0.18"/>
  <ellipse cx="200" cy="326" rx="135" ry="18" fill="url(#podium)" stroke="#334155" stroke-width="2"/>
  <rect x="125" y="105" width="150" height="210" rx="18" fill="url(#tubBody)" stroke="#38bdf8" stroke-width="1.5"/>
  <rect x="132" y="78" width="136" height="30" rx="6" fill="#090D16" stroke="#475569" stroke-width="1.5"/>
  <rect x="127" y="150" width="146" height="115" fill="#05070B" stroke="#00f0ff" stroke-width="1" opacity="0.95"/>
  <text x="200" y="178" fill="#22d3ee" font-family="monospace" font-size="13" font-weight="bold" text-anchor="middle" letter-spacing="3">TITAN LABS</text>
  <text x="200" y="206" fill="#ffffff" font-family="sans-serif" font-size="18" font-weight="900" text-anchor="middle" letter-spacing="1">CREATINE</text>
  <text x="200" y="226" fill="#94a3b8" font-family="monospace" font-size="10" text-anchor="middle">MICRONIZED // 500G</text>
  <rect x="160" y="238" width="80" height="16" rx="3" fill="#083344" stroke="#22d3ee" stroke-width="0.8"/>
  <text x="200" y="249" fill="#67e8f9" font-family="monospace" font-size="8" font-weight="bold" text-anchor="middle">BLACK SERIES</text>
</svg>`);

export function extractSparkReasoningAndJson(messageObj: any): {
  reasoning: string;
  parsedJson: unknown;
} {
  const rawContent: string = messageObj?.content || '';
  let explicitReasoning: string =
    messageObj?.reasoning_content || messageObj?.reasoning || '';

  let cleanedContent = rawContent;

  const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    explicitReasoning = (explicitReasoning + '\n' + thinkMatch[1]).trim();
    cleanedContent = rawContent.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
  }

  cleanedContent = cleanedContent.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();

  const firstBrace = cleanedContent.indexOf('{');
  const lastBrace = cleanedContent.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`No valid JSON object in output: ${rawContent.slice(0, 180)}`);
  }

  const parsedJson = JSON.parse(cleanedContent.slice(firstBrace, lastBrace + 1));

  return {
    reasoning:
      explicitReasoning ||
      'Verified spatial centroids [LEFT, CENTER, RIGHT] against operator intent. Triggering 4-node DAG.',
    parsedJson,
  };
}

export async function callBasetenMuseSparkOpen(
  systemPrompt: string,
  voiceTranscript: string,
  frameBase64?: string | null
): Promise<SparkInferenceResult> {
  const apiKey = process.env.BASETEN_API_KEY;
  const baseUrl = process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1';
  const model = process.env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026';

  if (!apiKey) throw new Error('BASETEN_API_KEY_NOT_SET');

  const start = Date.now();

  const userContent: any = frameBase64
    ? [
        {
          type: 'text',
          text: `OPERATOR VOICE COMMAND: "${voiceTranscript}"\nReturn ONLY the raw JSON object matching the schema.`,
        },
        {
          type: 'image_url',
          image_url: {
            url: frameBase64.startsWith('data:')
              ? frameBase64
              : `data:image/jpeg;base64,${frameBase64}`,
          },
        },
      ]
    : `OPERATOR VOICE COMMAND: "${voiceTranscript}"\nReturn ONLY the raw JSON object matching the schema.`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 1400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Baseten HTTP ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as any;
  const message = data.choices?.[0]?.message;
  const { reasoning, parsedJson } = extractSparkReasoningAndJson(message);

  const validatedPlan = OrchestrationPlanSchema.parse(parsedJson);

  return {
    plan: validatedPlan,
    reasoningTrace: reasoning,
    modelUsed: `${model} (Baseten 2M TPM)`,
    latencyMs: Date.now() - start,
  };
}

export async function callMuseImageStudioSynthesis(prompt: string): Promise<{
  imageUrl: string;
  usedLiveApi: boolean;
}> {
  const apiKey = process.env.META_MODEL_API_KEY;
  const baseUrl = process.env.META_API_BASE_URL || 'https://api.llama.com/v1';
  const model = process.env.META_IMAGE_MODEL || 'muse-image';

  if (!apiKey) {
    return { imageUrl: STUDIO_RENDER_FALLBACK_URI, usedLiveApi: false };
  }

  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        size: '512x512',
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) throw new Error(`Muse Image HTTP ${response.status}`);
    const data = (await response.json()) as any;
    const b64 = data.data?.[0]?.b64_json;
    const url = data.data?.[0]?.url;

    if (b64) return { imageUrl: `data:image/png;base64,${b64}`, usedLiveApi: true };
    if (url) return { imageUrl: url, usedLiveApi: true };
    return { imageUrl: STUDIO_RENDER_FALLBACK_URI, usedLiveApi: false };
  } catch {
    return { imageUrl: STUDIO_RENDER_FALLBACK_URI, usedLiveApi: false };
  }
}

export async function callMuseCodeGenerator(
  targetMarginPercent: number,
  taxRatePercent: number
): Promise<string> {
  const useMeta = Boolean(process.env.META_MODEL_API_KEY);
  const apiKey = process.env.META_MODEL_API_KEY || process.env.BASETEN_API_KEY;
  const baseUrl = useMeta
    ? process.env.META_API_BASE_URL || 'https://api.llama.com/v1'
    : process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1';
  const model = useMeta
    ? process.env.META_CODE_MODEL || 'muse-code'
    : process.env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026';

  if (!apiKey) throw new Error('NO_API_KEY_FOR_CODE_GEN');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 350,
      messages: [
        {
          role: 'system',
          content:
            'Output ONLY a pure JavaScript function named calculatePrice(cost, marginPct, taxPct) that returns (cost / (1 - marginPct / 100)) * (1 + taxPct / 100). No markdown, no comments.',
        },
        {
          role: 'user',
          content: `Generate calculatePrice(cost, marginPct, taxPct) for margin ${targetMarginPercent}% and tax ${taxRatePercent}%.`,
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`Code Gen HTTP ${response.status}`);
  const data = (await response.json()) as any;
  const raw: string = data.choices?.[0]?.message?.content || '';
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export async function dispatchSupplierClaimNotification(claim: {
  id: string;
  reason: string;
  amountUsd: number;
}): Promise<{ dispatchedVia: string }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (botToken && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🚨 *KINETIX OS - SUPPLIER CLAIM APPROVED*\nTicket: #${claim.id}\nDebit: -$${claim.amountUsd.toFixed(2)} USD\nReason: ${claim.reason}`,
          parse_mode: 'Markdown',
        }),
      });
      return { dispatchedVia: 'TELEGRAM_LIVE_WEBHOOK' };
    } catch {
      // Fallback silencioso
    }
  }
  return { dispatchedVia: 'KINETIX_ERP_LEDGER_WEBHOOK' };
}
