import 'dotenv/config';
import { OrchestrationPlan, OrchestrationPlanSchema, salvageOrchestrationPlan } from '../contracts/orchestratorCore';

export const RAW_WAREHOUSE_CROP_FALLBACK_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#0b0f17"/>
  <rect y="275" width="400" height="125" fill="#161d2a"/>
  <line x1="0" y1="275" x2="400" y2="275" stroke="#334155" stroke-width="2"/>
  <rect x="95" y="120" width="210" height="145" rx="8" fill="#1e293b" stroke="#475569" stroke-width="2"/>
  <circle cx="165" cy="192" r="46" fill="#0f172a" stroke="#334155" stroke-width="2"/>
  <circle cx="165" cy="192" r="16" fill="#1e293b" stroke="#475569" stroke-width="1.5"/>
  <rect x="230" y="148" width="55" height="14" rx="2" fill="#0f172a"/>
  <rect x="230" y="170" width="55" height="14" rx="2" fill="#0f172a"/>
  <rect x="230" y="192" width="55" height="14" rx="2" fill="#0f172a"/>
  <rect x="82" y="106" width="236" height="172" rx="6" fill="#22d3ee" fill-opacity="0.08" stroke="#22d3ee" stroke-width="2" stroke-dasharray="8 4"/>
  <rect x="82" y="106" width="142" height="20" fill="#083344"/>
  <text x="153" y="120" fill="#67e8f9" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">FALLBACK_CROP</text>
</svg>`);

export interface SparkInferenceResult {
  plan: OrchestrationPlan;
  reasoningTrace: string;
  modelUsed: string;
  latencyMs: number;
  firstTokenLatencyMs?: number;
}

export const STUDIO_RENDER_FALLBACK_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <radialGradient id="bgGlow" cx="50%" cy="55%" r="60%">
      <stop offset="0%" stop-color="#083344" stop-opacity="0.85"/>
      <stop offset="65%" stop-color="#090D16" stop-opacity="1"/>
      <stop offset="100%" stop-color="#030508" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#bgGlow)"/>
  <ellipse cx="200" cy="322" rx="140" ry="18" fill="#0f172a" stroke="#334155" stroke-width="1.5"/>
  <rect x="95" y="135" width="210" height="150" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <circle cx="165" cy="210" r="48" fill="#05070B" stroke="#22d3ee" stroke-width="1.2"/>
  <circle cx="165" cy="210" r="18" fill="#0f172a" stroke="#64748b" stroke-width="1"/>
  <text x="255" y="195" fill="#22d3ee" font-family="monospace" font-size="11" font-weight="bold" text-anchor="middle">ATX PSU</text>
  <text x="255" y="214" fill="#94a3b8" font-family="monospace" font-size="9" text-anchor="middle">MODULAR UNIT</text>
  <rect x="220" y="228" width="70" height="16" rx="3" fill="#083344" stroke="#22d3ee" stroke-width="0.8"/>
  <text x="255" y="239" fill="#67e8f9" font-family="monospace" font-size="8" font-weight="bold" text-anchor="middle">SVG FALLBACK</text>
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

  const pools = [rawContent, reasoningContent, `${rawContent}\n${reasoningContent}`].filter((p) => p.trim());
  const explicitReasoning = reasoningContent || rawContent;
  let best: { score: number; parsed: unknown } | null = null;

  for (const searchPool of pools) {
    const candidates = collectJsonCandidates(searchPool);
    for (const candidate of candidates) {
      try {
        const cleaned = candidate.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']').trim();
        const parsed = JSON.parse(cleaned);
        if (!parsed || typeof parsed !== 'object') continue;
        const score =
          (Array.isArray((parsed as any).actions) ? (parsed as any).actions.length * 10 : 0) +
          (Array.isArray((parsed as any).detectedObjects) ? (parsed as any).detectedObjects.length : 0) +
          ((parsed as any).summary ? 1 : 0);
        if (score > 0 && (!best || score > best.score)) best = { score, parsed };
      } catch {
        // try next candidate
      }
    }
  }

  if (!best) {
    const preview = (rawContent || reasoningContent).slice(0, 500);
    throw new Error(`No valid JSON object in output: ${preview}`);
  }

  return {
    reasoning: explicitReasoning.trim() || 'Spatial plan locked.',
    parsedJson: best.parsed,
  };
}

function collectJsonCandidates(searchPool: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < searchPool.length; i++) {
    const c = searchPool[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(searchPool.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (start !== -1) {
    let truncated = searchPool.slice(start).replace(/,\s*$/, '');
    const opens = (truncated.match(/\{/g) || []).length;
    const closes = (truncated.match(/\}/g) || []).length;
    const openArr = (truncated.match(/\[/g) || []).length;
    const closeArr = (truncated.match(/\]/g) || []).length;
    truncated += ']'.repeat(Math.max(0, openArr - closeArr));
    truncated += '}'.repeat(Math.max(0, opens - closes));
    candidates.push(truncated);
  }
  return candidates;
}

export interface DetectedObjectDraft {
  id: string;
  label: string;
  bbox: [number, number, number, number];
  confidence: number;
  isSensitivePII?: boolean;
}

function tryExtractDetectedObjects(text: string): DetectedObjectDraft[] | null {
  const key = text.indexOf('"detectedObjects"');
  if (key === -1) return null;
  const bracket = text.indexOf('[', key);
  if (bracket === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = bracket; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try {
          const cleaned = text
            .slice(bracket, i + 1)
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']');
          const parsed = JSON.parse(cleaned);
          if (!Array.isArray(parsed) || parsed.length === 0) return null;
          const drafts: DetectedObjectDraft[] = [];
          for (const item of parsed) {
            if (!item || !Array.isArray(item.bbox) || item.bbox.length < 4) continue;
            drafts.push({
              id: String(item.id || ''),
              label: String(item.label || 'Detected Object'),
              bbox: item.bbox.slice(0, 4).map(Number) as [number, number, number, number],
              confidence: Number(item.confidence ?? 0.8),
              isSensitivePII: Boolean(item.isSensitivePII),
            });
          }
          return drafts.length ? drafts : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function readChatStream(
  response: Response,
  onSnapshot: (content: string, reasoning: string) => void
): Promise<{ content: string; reasoning: string }> {
  const reader = response.body?.getReader();
  if (!reader) return { content: '', reasoning: '' };
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta || json.choices?.[0]?.message || {};
        if (typeof delta.content === 'string') content += delta.content;
        const extra = delta.reasoning_content || delta.reasoning || '';
        if (typeof extra === 'string') reasoning += extra;
        onSnapshot(content, reasoning);
      } catch {
        // incomplete SSE chunk
      }
    }
  }
  return { content, reasoning };
}

function isRealKey(raw?: string): boolean {
  if (!raw) return false;
  const t = raw.trim();
  return Boolean(t && !t.startsWith('your_') && !t.endsWith('_here'));
}

function normalizeMetaBaseUrl(raw?: string): string {
  const candidate = (raw || 'https://api.meta.ai/v1').trim();
  return candidate.includes('api.llama.com') ? 'https://api.meta.ai/v1' : candidate;
}

export async function callBasetenMuseSparkOpen(
  systemPrompt: string,
  voiceTranscript: string,
  frameBase64?: string | null,
  onDetectedObjects?: (objects: DetectedObjectDraft[]) => void,
  signal?: AbortSignal,
  onReasoningProgress?: (partialReasoning: string, elapsedMs: number) => void
): Promise<SparkInferenceResult> {
  const useBaseten = isRealKey(process.env.BASETEN_API_KEY);
  const useMetaDirect = !useBaseten && isRealKey(process.env.META_MODEL_API_KEY);

  if (!useBaseten && !useMetaDirect) {
    throw new Error('NO_SPARK_API_KEY_CONFIGURED');
  }

  const apiKey = useBaseten ? process.env.BASETEN_API_KEY!.trim() : process.env.META_MODEL_API_KEY!.trim();
  const baseUrl = useBaseten
    ? process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1'
    : normalizeMetaBaseUrl(process.env.META_API_BASE_URL);
  const model = useBaseten
    ? process.env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026'
    : process.env.META_SPARK_MODEL || 'muse-spark-1.3';
  const providerTag = useBaseten ? 'Baseten 2M TPM' : 'Meta Model API';

  const start = Date.now();
  let firstChunkAt = 0;

  const contentParts: any[] = [
    {
      type: 'text',
      text: `OPERATOR VOICE COMMAND: "${voiceTranscript}"\nInspect the attached workspace image: detect every visible object with normalized [x, y, w, h] boxes, bind the command to them, assess defectSeverity and damageFactor for any damaged item, and extract exact colors, container geometry, material and label text for any studio catalog item. Return ONLY the raw JSON object. Put detectedObjects first.`,
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
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 2048,
      stream: true,
      ...(useBaseten ? { reasoning_effort: 'low' } : {}),
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

  let spatialNotified = false;
  let lastProgressAt = 0;
  let lastSentLen = 0;
  const notify = (content: string, reasoning: string) => {
    const now = Date.now();
    if (!firstChunkAt && (content.length > 0 || reasoning.length > 0)) {
      firstChunkAt = now;
    }
    if (onReasoningProgress && reasoning.length > lastSentLen && now - lastProgressAt >= 180) {
      lastProgressAt = now;
      lastSentLen = reasoning.length;
      onReasoningProgress(reasoning.slice(-520), now - start);
    }
    if (spatialNotified || !onDetectedObjects) return;
    const drafts = tryExtractDetectedObjects(content) || tryExtractDetectedObjects(reasoning);
    if (!drafts) return;
    spatialNotified = true;
    console.log('[SPATIAL_LOCK EARLY]', drafts.length, 'objects in', now - start, 'ms');
    onDetectedObjects(drafts);
  };

  const contentType = response.headers.get('content-type') || '';
  let content = '';
  let reasoning = '';

  if (!contentType.includes('application/json')) {
    const streamed = await readChatStream(response, notify);
    content = streamed.content;
    reasoning = streamed.reasoning;
  } else {
    const data = (await response.json()) as any;
    const message = data.choices?.[0]?.message || {};
    content = message.content || '';
    reasoning = message.reasoning_content || message.reasoning || '';
    notify(content, reasoning);
  }

  let parsedReasoning = reasoning || content || 'Spatial plan locked.';
  let parsedJson: unknown = null;
  try {
    const extracted = extractSparkReasoningAndJson({
      content,
      reasoning_content: reasoning,
    });
    parsedReasoning = extracted.reasoning;
    parsedJson = extracted.parsedJson;
  } catch (err) {
    console.warn('[SPARK JSON]', (err as Error).message);
  }

  if (!spatialNotified) notify(content, reasoning);

  const strict = parsedJson ? OrchestrationPlanSchema.safeParse(parsedJson) : null;
  const validatedPlan = strict?.success ? strict.data : salvageOrchestrationPlan(parsedJson);
  if (!validatedPlan || validatedPlan.actions.length === 0) {
    throw new Error('Spark JSON did not contain a usable action plan');
  }
  if (strict && !strict.success) {
    console.warn('[SPARK SALVAGED]', strict.error.issues.slice(0, 3));
  }

  const totalLatencyMs = Date.now() - start;
  return {
    plan: validatedPlan,
    reasoningTrace: parsedReasoning,
    modelUsed: `${model} (${providerTag})`,
    latencyMs: totalLatencyMs,
    firstTokenLatencyMs: firstChunkAt ? firstChunkAt - start : totalLatencyMs,
  };
}

export async function callMuseImageStudioSynthesis(
  prompt: string,
  signal?: AbortSignal
): Promise<{
  imageUrl: string;
  usedLiveApi: boolean;
  resolution: string;
}> {
  const apiKey = process.env.META_MODEL_API_KEY;
  const baseUrl = normalizeMetaBaseUrl(process.env.META_API_BASE_URL);
  const model = process.env.META_IMAGE_MODEL || 'muse-image-1.0';
  const requestedSize = process.env.META_IMAGE_SIZE || '512x512';

  if (!isRealKey(apiKey)) {
    return { imageUrl: STUDIO_RENDER_FALLBACK_URI, usedLiveApi: false, resolution: 'SVG_FALLBACK' };
  }

  const trySize = async (size: string) => {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey!.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Muse Image] HTTP ${response.status} (size=${size}): ${errText.slice(0, 300)}`);
      return null;
    }

    const data = (await response.json()) as any;
    const b64 = data.data?.[0]?.b64_json;
    const url = data.data?.[0]?.url;
    if (b64) return { imageUrl: `data:image/png;base64,${b64}`, usedLiveApi: true, resolution: size };
    if (url) return { imageUrl: url, usedLiveApi: true, resolution: size };
    return null;
  };

  try {
    const primary = await trySize(requestedSize);
    if (primary) return primary;
    if (requestedSize !== '512x512') {
      const secondary = await trySize('512x512');
      if (secondary) return secondary;
    }
    return { imageUrl: STUDIO_RENDER_FALLBACK_URI, usedLiveApi: false, resolution: 'SVG_FALLBACK' };
  } catch (err) {
    console.warn('[Muse Image] failed:', (err as Error).message);
    return { imageUrl: STUDIO_RENDER_FALLBACK_URI, usedLiveApi: false, resolution: 'SVG_FALLBACK' };
  }
}

type SamMask = {
  id: string;
  label: string;
  bbox: [number, number, number, number];
  isSensitivePII?: boolean;
};

function readImageSize(dataUrl: string): { w: number; h: number } | null {
  const encoded = dataUrl.split(',')[1];
  if (!encoded) return null;
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { h: buf.readUInt16BE(offset + 5), w: buf.readUInt16BE(offset + 7) };
    }
    if (offset + 4 > buf.length) break;
    const size = buf.readUInt16BE(offset + 2);
    if (size < 2) break;
    offset += 2 + size;
  }
  return null;
}

function inflateBox(
  box: [number, number, number, number],
  pad: number
): [number, number, number, number] {
  const x = Math.max(0, box[0] - box[2] * pad);
  const y = Math.max(0, box[1] - box[3] * pad);
  const right = Math.min(1, box[0] + box[2] + box[2] * pad);
  const bottom = Math.min(1, box[1] + box[3] + box[3] * pad);
  return [x, y, Math.max(0.02, right - x), Math.max(0.02, bottom - y)];
}

export function computeIoU(
  a: [number, number, number, number],
  b: [number, number, number, number]
): number {
  const xA = Math.max(a[0], b[0]);
  const yA = Math.max(a[1], b[1]);
  const xB = Math.min(a[0] + a[2], b[0] + b[2]);
  const yB = Math.min(a[1] + a[3], b[1] + b[3]);

  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;

  const areaA = Math.max(0.0001, a[2] * a[3]);
  const areaB = Math.max(0.0001, b[2] * b[3]);
  return interArea / (areaA + areaB - interArea);
}

function boxesAreSameObject(
  original: [number, number, number, number],
  refined: [number, number, number, number]
): boolean {
  const originalArea = Math.max(0, original[2]) * Math.max(0, original[3]);
  const refinedArea = Math.max(0, refined[2]) * Math.max(0, refined[3]);
  if (originalArea < 0.0002 || refinedArea < 0.0002) return false;

  const search = inflateBox(original, 0.25);
  const centerX = refined[0] + refined[2] / 2;
  const centerY = refined[1] + refined[3] / 2;

  const centerInside =
    centerX >= search[0] &&
    centerX <= search[0] + search[2] &&
    centerY >= search[1] &&
    centerY <= search[1] + search[3];

  const iou = computeIoU(original, refined);
  const areaRatio = refinedArea / originalArea;

  return centerInside && iou >= 0.35 && areaRatio >= 0.55 && areaRatio <= 1.55;
}

function parseSamBoxes(
  text: string,
  fallbackSize: { w: number; h: number }
): Array<[number, number, number, number]> {
  const found: Array<[number, number, number, number]> = [];
  const re = /(?:(\d+)\s*)?<\|box;x1=([\d.]+);y1=([\d.]+);x2=([\d.]+);y2=([\d.]+)(?:;w=([\d.]+);h=([\d.]+))?\|?>/g;

  for (const match of text.matchAll(re)) {
    const x1 = Number(match[2]);
    const y1 = Number(match[3]);
    const x2 = Number(match[4]);
    const y2 = Number(match[5]);
    const w = match[6] ? Number(match[6]) : fallbackSize.w;
    const h = match[7] ? Number(match[7]) : fallbackSize.h;

    if (w < 2 || h < 2 || x2 <= x1 || y2 <= y1) continue;
    const nx = Math.min(0.98, Math.max(0, x1 / w));
    const ny = Math.min(0.98, Math.max(0, y1 / h));
    const nw = Math.min(1 - nx, Math.max(0.02, (x2 - x1) / w));
    const nh = Math.min(1 - ny, Math.max(0.02, (y2 - y1) / h));
    found.push([
      Number(nx.toFixed(3)),
      Number(ny.toFixed(3)),
      Number(nw.toFixed(3)),
      Number(nh.toFixed(3)),
    ]);
  }
  return found;
}

async function readSamOutput(response: Response): Promise<string> {
  const raw = await response.text();
  if (!raw.includes('data:')) return raw;
  let deltaText = '';
  let finalText = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload) as { delta?: string; output_text?: string; text?: string };
      if (typeof ev.delta === 'string') deltaText += ev.delta;
      else if (ev.output_text || ev.text) finalText = ev.output_text || ev.text || finalText;
    } catch {}
  }
  return deltaText || finalText || raw;
}

export async function refineMasksWithSam31<T extends SamMask>(
  frameBase64: string | null | undefined,
  masks: T[]
): Promise<{ masks: T[]; used: boolean; latencyMs: number; refined: number }> {
  const started = Date.now();
  const apiKey = process.env.META_MODEL_API_KEY;
  const actionable = masks.filter((mask) => !mask.isSensitivePII);
  const size = frameBase64 ? readImageSize(frameBase64) : null;
  if (!isRealKey(apiKey) || !frameBase64?.startsWith('data:image') || actionable.length === 0 || !size) {
    return { masks, used: false, latencyMs: 0, refined: 0 };
  }

  const endpoint = process.env.META_SAM_URL || `${normalizeMetaBaseUrl(process.env.META_API_BASE_URL)}/responses`;
  const model = process.env.META_SAM_MODEL || 'sam-3.1';
  const prompt = `<0f>${actionable
    .map((mask, index) => {
      const boxArea = mask.bbox[2] * mask.bbox[3];
      const adaptivePad = boxArea < 0.012 ? 0.16 : 0.08;
      const search = inflateBox(mask.bbox, adaptivePad);

      const maxW = size.w - 1;
      const maxH = size.h - 1;
      const x1 = Math.max(0, Math.min(maxW - 2, Math.floor(search[0] * size.w)));
      const y1 = Math.max(0, Math.min(maxH - 2, Math.floor(search[1] * size.h)));
      const x2 = Math.max(x1 + 2, Math.min(maxW, Math.ceil((search[0] + search[2]) * size.w)));
      const y2 = Math.max(y1 + 2, Math.min(maxH, Math.ceil((search[1] + search[3]) * size.h)));
      return `${index + 1}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${size.w};h=${size.h}|>`;
    })
    .join(',')}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: `Bearer ${apiKey!.trim()}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: frameBase64 },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[SAM 3.1] HTTP ${response.status}: ${errText.slice(0, 220)}`);
      return { masks, used: false, latencyMs: Date.now() - started, refined: 0 };
    }

    const output = await readSamOutput(response);
    console.log(
      '[SAM 3.1 BOXES ONLY]',
      output.replace(/<\|mask;[^|]*\|>/g, '<|mask|>').slice(0, 500)
    );

    const candidateBoxes = parseSamBoxes(output, size);
    const usedCandidateIndices = new Set<number>();
    let refined = 0;
    let rejected = 0;

    const refinedMasks = masks.map((mask) => {
      if (mask.isSensitivePII) return mask;

      let bestIdx = -1;
      let bestIoU = -1;

      for (let i = 0; i < candidateBoxes.length; i++) {
        if (usedCandidateIndices.has(i)) continue;
        const iou = computeIoU(mask.bbox, candidateBoxes[i]);
        if (iou > bestIoU) {
          bestIoU = iou;
          bestIdx = i;
        }
      }

      const candidate = bestIdx !== -1 ? candidateBoxes[bestIdx] : null;
      if (!candidate || !boxesAreSameObject(mask.bbox, candidate)) {
        if (candidate) rejected += 1;
        return mask;
      }

      usedCandidateIndices.add(bestIdx);
      refined += 1;
      return { ...mask, bbox: candidate };
    });

    console.log(
      `[SAM 3.1 IoU] parsed=${candidateBoxes.length}, kept=${refined}/${actionable.length}, rejected=${rejected}`
    );
    return { masks: refinedMasks, used: refined > 0, latencyMs: Date.now() - started, refined };
  } catch (err) {
    console.warn('[SAM 3.1] failed', (err as Error).message);
    return { masks, used: false, latencyMs: Date.now() - started, refined: 0 };
  }
}

export async function callMuseCodeGenerator(
  targetMarginPercent: number,
  taxRatePercent: number,
  operatorDirective?: string,
  signal?: AbortSignal,
  warehouseAnomalyContext?: {
    hasCriticalClaim?: boolean;
    defectSeverity?: string;
    damageFactor?: number;
  }
): Promise<{ code: string; modelUsed: string }> {
  const useMeta = isRealKey(process.env.META_MODEL_API_KEY);
  const apiKey = useMeta ? process.env.META_MODEL_API_KEY!.trim() : process.env.BASETEN_API_KEY?.trim();
  const baseUrl = useMeta
    ? normalizeMetaBaseUrl(process.env.META_API_BASE_URL)
    : process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1';

  const rawConfiguredModel = process.env.META_CODE_MODEL;
  const metaCodeModel =
    !rawConfiguredModel || rawConfiguredModel === 'muse-code' ? 'muse-wonder-1.0' : rawConfiguredModel;
  const model = useMeta
    ? metaCodeModel
    : process.env.BASETEN_MODEL || 'meta-models/muse-spark-open-1026';

  if (!apiKey || !isRealKey(apiKey)) throw new Error('NO_API_KEY_FOR_CODE_GEN');

  const anomalyRuleLine = warehouseAnomalyContext?.hasCriticalClaim
    ? `Active warehouse inspection detected a ${warehouseAnomalyContext.defectSeverity || 'CRITICAL'} batch anomaly (damageFactor=${warehouseAnomalyContext.damageFactor ?? 0.85}); include a quality-assurance handling adjustment (1% to 2%) if inboundDelta > 0.`
    : 'Standard inbound batch with no lot-wide revocation penalty.';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1500,
      reasoning_effort: 'low',
      messages: [
        {
          role: 'system',
          content: [
            'You are the Kinetix OS Warehouse Commercial Policy Synthesizer (Muse Code).',
            'Keep internal reasoning under 35 words. Output ONLY executable JavaScript (6-10 lines, no markdown fences, no prose).',
            'Synthesize function calculatePrice(ctx) where ctx = { cost, marginPct, taxPct, stock, inboundDelta }.',
            'Business rules to synthesize dynamically into code:',
            '1. Derive gross selling price from unit acquisition cost (ctx.cost) and target operating margin percentage (ctx.marginPct).',
            '2. Apply warehouse inventory tiering: an overstock clearance discount (3% off) when ctx.stock > 120, or a low-stock scarcity buffer (+4%) when ctx.stock < 15.',
            `3. ${anomalyRuleLine}`,
            '4. Apply VAT/tax rate percentage (ctx.taxPct) and return a finite number rounded to 2 decimals that strictly increases with ctx.cost.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Target Margin: ${targetMarginPercent}%, Tax Rate: ${taxRatePercent}%. Operator Directive: "${(operatorDirective || '').slice(0, 220)}"`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Policy Synth (${model}) HTTP ${response.status}: ${errText.slice(0, 160)}`);
  }
  const data = (await response.json()) as any;
  const raw: string = data.choices?.[0]?.message?.content || '';
  return {
    code: raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
    modelUsed: useMeta ? `${model} (Meta Model API)` : `${model} (Baseten)`,
  };
}

function escapeTelegramHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function dispatchSupplierClaimNotification(claim: {
  id: string;
  mongoId?: string;
  reason: string;
  amountUsd: number;
  cropBase64?: string;
}): Promise<{ dispatchedVia: string; externalReceiptId: string; deliveredExternally: boolean }> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const caption =
    `<b>KINETIX OS — GUARDRAIL CLAIM AUTHORIZED</b>\n` +
    `• <b>Ticket:</b> <code>#${escapeTelegramHtml(claim.id)}</code>\n` +
    `• <b>Ledger Tx:</b> <code>${escapeTelegramHtml(claim.mongoId || 'local')}</code>\n` +
    `• <b>Debit Amount:</b> <b>-$${claim.amountUsd.toFixed(2)} USD</b>\n` +
    `• <b>Spatial Defect:</b> ${escapeTelegramHtml(claim.reason)}`;

  if (botToken && chatId) {
    try {
      if (claim.cropBase64 && claim.cropBase64.startsWith('data:image')) {
        const cleanB64 = claim.cropBase64.replace(/^data:image\/\w+;base64,/, '');
        const imgBlob = new Blob([Buffer.from(cleanB64, 'base64')], { type: 'image/jpeg' });
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('photo', imgBlob, `defect-${claim.id}.jpg`);
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');

        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          body: form,
        });
        if (tgRes.ok) {
          const tgJson = (await tgRes.json()) as any;
          return {
            dispatchedVia: 'TELEGRAM_LIVE_PHOTO_WEBHOOK',
            externalReceiptId: `TG-MSG-${tgJson.result?.message_id || Date.now()}`,
            deliveredExternally: true,
          };
        }
        const errBody = await tgRes.text();
        console.warn(`[Telegram sendPhoto] HTTP ${tgRes.status}: ${errBody.slice(0, 240)}`);
      }

      const tgTextRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: caption,
          parse_mode: 'HTML',
        }),
      });
      if (tgTextRes.ok) {
        const tgJson = (await tgTextRes.json()) as any;
        return {
          dispatchedVia: 'TELEGRAM_LIVE_WEBHOOK',
          externalReceiptId: `TG-MSG-${tgJson.result?.message_id || Date.now()}`,
          deliveredExternally: true,
        };
      }
      const errBody = await tgTextRes.text();
      console.warn(`[Telegram sendMessage] HTTP ${tgTextRes.status}: ${errBody.slice(0, 240)}`);
    } catch (err) {
      console.warn('Telegram webhook failed, recording in local ledger:', (err as Error).message);
    }
  }

  return {
    dispatchedVia: 'LOCAL_LEDGER_ONLY',
    externalReceiptId: `LEDGER-${Date.now().toString(36).toUpperCase()}`,
    deliveredExternally: false,
  };
}

export async function callMuseVoiceTranscribe(
  wavBuffer: Buffer,
  catalogKeywords: string[] = [],
  signal?: AbortSignal
): Promise<{
  transcript: string;
  audioDurationMs: number;
  latencyMs: number;
  sessionId: string;
  modelUsed: string;
  biasedKeywordsCount: number;
}> {
  const started = Date.now();
  const apiKey = process.env.META_MODEL_API_KEY;
  if (!isRealKey(apiKey)) throw new Error('META_MODEL_API_KEY_NOT_SET');

  const baseUrl = normalizeMetaBaseUrl(process.env.META_API_BASE_URL);
  const rawModel = process.env.META_VOICE_MODEL;
  const model =
    !rawModel || rawModel === 'voice-transcribe' ? 'muse-voice-transcribe-1.0' : rawModel;

  const domainTerms = [
    'reclamo',
    'margen',
    'stock',
    'cooler',
    'aleta',
    'fuente modular',
    'estudio',
    'DDR5',
    'DDR4',
    'NVMe',
    'SSD',
    'M.2',
    'ATX 3.0',
    'PSU',
    'SKU',
    ...catalogKeywords,
  ];
  const uniqueKeywords = Array.from(new Set(domainTerms.map((k) => k.trim()).filter(Boolean))).slice(0, 45);
  const sessionId = `kinetix-asr-${Date.now().toString(36)}`;

  const requestMeta = JSON.stringify({
    mode: 'PUSH_TO_TALK',
    model,
    audioEncoding: 'WAV',
    languageBias: ['Spanish', 'English'],
    keywords: uniqueKeywords,
  });

  const form = new FormData();
  form.append('request', new Blob([requestMeta], { type: 'application/json' }));
  form.append('audio', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'operator-command.wav');

  const res = await fetch(`${baseUrl}/asr/transcribe?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${apiKey!.trim()}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Muse Voice ASR HTTP ${res.status}: ${errText.slice(0, 220)}`);
  }

  const data = (await res.json()) as {
    sessionId?: string;
    transcript?: string;
    audioDurationMs?: number;
  };

  return {
    transcript: (data.transcript || '').trim(),
    audioDurationMs: Number(data.audioDurationMs ?? 0),
    latencyMs: Date.now() - started,
    sessionId: data.sessionId || sessionId,
    modelUsed: `${model} (Meta Model API)`,
    biasedKeywordsCount: uniqueKeywords.length,
  };
}
