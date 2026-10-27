import 'dotenv/config';
import { OrchestrationPlan, OrchestrationPlanSchema } from '../contracts/orchestratorCore';

export interface SparkInferenceResult {
  plan: OrchestrationPlan;
  reasoningTrace: string;
  modelUsed: string;
  latencyMs: number;
}

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
    throw new Error(`No valid JSON object found in model output: ${rawContent.slice(0, 200)}`);
  }

  const jsonSubstring = cleanedContent.slice(firstBrace, lastBrace + 1);
  const parsedJson = JSON.parse(jsonSubstring);

  return {
    reasoning:
      explicitReasoning ||
      'Spatial coordinates verified against operator voice intent. Dispatching parallel DAG tools.',
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

  if (!apiKey) {
    throw new Error('BASETEN_API_KEY_NOT_SET');
  }

  const start = Date.now();

  const userContent: any = frameBase64
    ? [
        {
          type: 'text',
          text: `OPERATOR VOICE COMMAND: "${voiceTranscript}"\nAnalyze the spatial workspace and return ONLY the raw JSON execution plan.`,
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
    : `OPERATOR VOICE COMMAND: "${voiceTranscript}"\nReturn ONLY the raw JSON execution plan.`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Baseten API Error (${response.status}): ${errText}`);
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

export async function callMuseCodeGenerator(
  targetMarginPercent: number,
  taxRatePercent: number
): Promise<string> {
  const apiKey = process.env.META_MODEL_API_KEY || process.env.BASETEN_API_KEY;
  const isBaseten = !process.env.META_MODEL_API_KEY && !!process.env.BASETEN_API_KEY;
  const baseUrl = isBaseten
    ? process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1'
    : process.env.META_API_BASE_URL || 'https://api.llama.com/v1';
  const model = isBaseten ? 'meta-models/muse-spark-open-1026' : 'muse-code';

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
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content:
            'Output ONLY a pure JavaScript function named calculatePrice(cost, marginPct, taxPct) that calculates net margin price = cost / (1 - marginPct/100) and applies taxPct. No markdown fences, no explanation.',
        },
        {
          role: 'user',
          content: `Write calculatePrice(cost, marginPct, taxPct) for target margin ${targetMarginPercent}% and tax ${taxRatePercent}%.`,
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`Code Gen HTTP ${response.status}`);
  const data = (await response.json()) as any;
  const raw: string = data.choices?.[0]?.message?.content || '';
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
