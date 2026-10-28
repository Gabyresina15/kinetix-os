import 'dotenv/config';
import { OrchestrationPlan, OrchestrationPlanSchema } from '../contracts/orchestratorCore';

export const RAW_WAREHOUSE_CROP_FALLBACK_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#18181b"/>
  <rect y="270" width="400" height="130" fill="#27272a"/>
  <line x1="0" y1="270" x2="400" y2="270" stroke="#3f3f46" stroke-width="3"/>
  <ellipse cx="215" cy="325" rx="95" ry="18" fill="#09090b" opacity="0.75"/>
  <g transform="rotate(-2 200 210)">
    <rect x="130" y="110" width="140" height="200" rx="14" fill="#1e293b" stroke="#475569" stroke-width="2"/>
    <rect x="138" y="84" width="124" height="28" rx="4" fill="#0f172a" stroke="#334155" stroke-width="2"/>
    <rect x="132" y="155" width="136" height="105" fill="#0f172a"/>
    <text x="200" y="185" fill="#94a3b8" font-family="monospace" font-size="11" font-weight="bold" text-anchor="middle">TITAN LABS</text>
    <text x="200" y="212" fill="#cbd5e1" font-family="sans-serif" font-size="16" font-weight="bold" text-anchor="middle">CREATINE</text>
    <text x="200" y="232" fill="#64748b" font-family="monospace" font-size="9" text-anchor="middle">500G RAW LOT</text>
  </g>
  <rect x="115" y="72" width="170" height="252" rx="8" fill="#00f0ff" fill-opacity="0.12" stroke="#22d3ee" stroke-width="2.5" stroke-dasharray="8 4"/>
  <rect x="115" y="72" width="115" height="22" fill="#083344"/>
  <text x="172" y="87" fill="#67e8f9" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">SAM_MASK</text>
</svg>`);

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
  const reasoningContent: string =
    messageObj?.reasoning_content || messageObj?.reasoning || '';

  console.log('[BASETEN RAW CONTENT]', JSON.stringify(rawContent).slice(0, 600));
  console.log('[BASETEN REASONING_CONTENT]', JSON.stringify(reasoningContent).slice(0, 800));

  const searchPool = (rawContent.trim() || reasoningContent).trim();
  const explicitReasoning = reasoningContent || rawContent;

  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < searchPool.length; i++) {
    if (searchPool[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (searchPool[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(searchPool.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const lastOpen = searchPool.lastIndexOf('{');
  const lastClose = searchPool.lastIndexOf('}');
  if (lastOpen !== -1 && lastClose > lastOpen) {
    candidates.push(searchPool.slice(lastOpen, lastClose + 1));
  }

  for (const candidate of candidates) {
    try {
      const cleaned = candidate
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        .trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === 'object' && (parsed.summary || parsed.detectedObjects || parsed.actions)) {
        return {
          reasoning: explicitReasoning.trim() || 'Spatial plan locked.',
          parsedJson: parsed,
        };
      }
    } catch {
      // try next
    }
  }

  throw new Error(`No valid JSON object in output: ${searchPool.slice(0, 500)}`);
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

  const contentParts: any[] = [
  {
    type: 'text',
    text: `OPERATOR VOICE COMMAND: "${voiceTranscript}"\nInspect the attached workspace image: detect every visible object with normalized [x, y, w, h] boxes, bind the command to them, and extract exact colors, container geometry, material and label text for any studio catalog item. Return ONLY the raw JSON object.`,
  },
];

if (frameBase64) {
  contentParts.push({
    type: 'image_url',
    image_url: {
      url: frameBase64.startsWith('data:') ? frameBase64 : `data:image/jpeg;base64,${frameBase64}`,
    },
  });
}

const userContent = contentParts.length > 1 ? contentParts : contentParts[0].text;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 8000,
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
  const baseUrl = process.env.META_API_BASE_URL || 'https://api.meta.ai/v1';
  const model = process.env.META_IMAGE_MODEL || 'muse-image-1.0';

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
        n: 1,
        size: '512x512',
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Muse Image] HTTP ${response.status}: ${errText.slice(0, 300)}`);
      return { imageUrl: STUDIO_RENDER_FALLBACK_URI, usedLiveApi: false };
    }

    const data = (await response.json()) as any;
    console.log('[Muse Image] response keys:', Object.keys(data));
    console.log('[Muse Image] data[0] keys:', Object.keys(data.data?.[0] || {}));
    const b64 = data.data?.[0]?.b64_json;
    const url = data.data?.[0]?.url;
    console.log('[Muse Image] has b64:', Boolean(b64), 'has url:', Boolean(url));

    if (b64) return { imageUrl: `data:image/png;base64,${b64}`, usedLiveApi: true };
    if (url) return { imageUrl: url, usedLiveApi: true };
    return { imageUrl: STUDIO_RENDER_FALLBACK_URI, usedLiveApi: false };
  } catch (err) {
    console.warn('[Muse Image] failed', (err as Error).message);
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
  mongoId?: string;
  reason: string;
  amountUsd: number;
  cropBase64?: string;
}): Promise<{ dispatchedVia: string; externalReceiptId: string }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const caption =
    `🚨 *KINETIX OS — ZERO-TRUST CLAIM DISPATCHED*\n` +
    `• *Ticket:* \`#${claim.id}\`\n` +
    `• *MongoDB Tx:* \`${claim.mongoId || 'local'}\`\n` +
    `• *Debit Amount:* *-$${claim.amountUsd.toFixed(2)} USD*\n` +
    `• *Spatial Defect:* ${claim.reason}`;

  if (botToken && chatId) {
    try {
      if (claim.cropBase64 && claim.cropBase64.startsWith('data:image')) {
        const cleanB64 = claim.cropBase64.replace(/^data:image\/\w+;base64,/, '');
        const imgBlob = new Blob([Buffer.from(cleanB64, 'base64')], { type: 'image/jpeg' });
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('photo', imgBlob, `defect-${claim.id}.jpg`);
        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');

        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          body: form,
        });
        if (tgRes.ok) {
          const tgJson = (await tgRes.json()) as any;
          return {
            dispatchedVia: 'TELEGRAM_LIVE_PHOTO_WEBHOOK',
            externalReceiptId: `TG-MSG-${tgJson.result?.message_id || Date.now()}`,
          };
        }
      }

      const tgTextRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: caption,
          parse_mode: 'Markdown',
        }),
      });
      if (tgTextRes.ok) {
        const tgJson = (await tgTextRes.json()) as any;
        return {
          dispatchedVia: 'TELEGRAM_LIVE_WEBHOOK',
          externalReceiptId: `TG-MSG-${tgJson.result?.message_id || Date.now()}`,
        };
      }
    } catch (err) {
      console.warn('Telegram webhook fallback:', (err as Error).message);
    }
  }

  return {
    dispatchedVia: 'LOCAL_LEDGER',
    externalReceiptId: `LEDGER-${Date.now().toString(36).toUpperCase()}`,
  };
}
