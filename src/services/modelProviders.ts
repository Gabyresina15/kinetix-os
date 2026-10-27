import { RawSamMask } from './spatialNormalizer';

/**
 * 1. Baseten Serverless GPU -> SAM 3.1 Spatial Instance Segmentation
 */
export async function callBasetenSam31(frameBase64: string): Promise<RawSamMask[]> {
  const apiKey = process.env.BASETEN_API_KEY;
  const endpointUrl = process.env.BASETEN_SAM31_URL;
  if (!apiKey || !endpointUrl || !frameBase64) {
    throw new Error('BASETEN_SAM31_NOT_CONFIGURED_OR_NO_FRAME');
  }

  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image: frameBase64.replace(/^data:image\/\w+;base64,/, ''),
      prompts: ['damaged container', 'supplement tub', 'product box', 'id card'],
      threshold: 0.65,
    }),
  });

  if (!res.ok) throw new Error(`Baseten SAM 3.1 HTTP ${res.status}`);
  const data = (await res.json()) as { masks: RawSamMask[] };
  return data.masks;
}

/**
 * 2. Fireworks AI Serverless -> Muse Glimmer 30B (Open-Weights Edge Filter & PII Audit)
 */
export async function callFireworksMuseGlimmer(voiceTranscript: string): Promise<{
  routeTo: 'LOCAL_CACHE' | 'ESCALATE_TO_SPARK';
  piiRiskDetected: boolean;
  cloudTokensSavedPct: number;
}> {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) throw new Error('FIREWORKS_API_KEY_MISSING');

  const res = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.FIREWORKS_GLIMMER_MODEL || 'accounts/fireworks/models/muse-glimmer-30b',
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are an Edge Cognitive Filter. Return JSON: {"routeTo":"ESCALATE_TO_SPARK","piiRiskDetected":true,"cloudTokensSavedPct":68}',
        },
        { role: 'user', content: voiceTranscript },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Fireworks Glimmer HTTP ${res.status}`);
  const json = (await res.json()) as any;
  return JSON.parse(json.choices[0].message.content);
}

/**
 * 3. Meta Model API -> Muse Spark (Main Agentic Orchestrator)
 */
export async function callMetaMuseSpark(systemPrompt: string, userTranscript: string): Promise<unknown> {
  const apiKey = process.env.META_MODEL_API_KEY;
  const baseUrl = process.env.META_API_BASE_URL || 'https://api.llama.com/v1/chat/completions';
  if (!apiKey) throw new Error('META_MODEL_API_KEY_MISSING');

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'muse-spark',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userTranscript },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Muse Spark HTTP ${res.status}`);
  const json = (await res.json()) as any;
  return JSON.parse(json.choices[0].message.content);
}
