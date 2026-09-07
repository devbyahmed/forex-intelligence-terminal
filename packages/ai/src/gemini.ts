/**
 * The Gemini client.
 *
 * Verified on the free tier, 2026-08-30: `responseSchema` structured output behaves
 * as documented, but two things do not.
 *
 *  - **`gemini-3.7-flash` returned 503 on 4 of 4 attempts**, and `gemini-2.5-flash`
 *    returned **404 despite being listed** by the models endpoint. Model availability
 *    is a runtime condition, not a configuration constant, so a failure to reach the
 *    configured model falls back to the next one and records which was actually used.
 *  - **Errors can arrive as HTTP 200** with an error body — the same trait observed on
 *    Twelve Data. A 200 is therefore not treated as success until the payload parses.
 *
 * The client returns a discriminated result rather than throwing: an unavailable model
 * is an ordinary operating condition for this product, and the analysis is published
 * without an AI layer when it happens. Nothing in the deterministic layers depends on
 * the model answering.
 */

import { assessmentSchema, GEMINI_RESPONSE_SCHEMA, type Assessment } from './schema.js';

export interface GeminiOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly fallbackModel?: string;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export type GeminiResult =
  | {
      readonly kind: 'OK';
      readonly assessment: Assessment;
      readonly raw: unknown;
      readonly model: string;
      readonly latencyMs: number;
      readonly promptTokens: number | null;
      readonly responseTokens: number | null;
    }
  | {
      readonly kind: 'MALFORMED';
      /** Parsed JSON that failed our schema, or the raw text if it was not JSON. */
      readonly raw: unknown;
      readonly errors: readonly string[];
      readonly model: string;
      readonly latencyMs: number;
    }
  | {
      readonly kind: 'UNAVAILABLE';
      readonly reason: string;
      readonly modelsTried: readonly string[];
    };

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiClient {
  private readonly options: GeminiOptions;

  constructor(options: GeminiOptions) {
    this.options = options;
  }

  isConfigured(): boolean {
    return this.options.apiKey.trim() !== '';
  }

  async generate(prompt: string): Promise<GeminiResult> {
    if (!this.isConfigured()) {
      return { kind: 'UNAVAILABLE', reason: 'NOT_CONFIGURED', modelsTried: [] };
    }

    const models = [this.options.model, this.options.fallbackModel].filter(
      (m): m is string => m !== undefined && m !== '',
    );
    const tried: string[] = [];
    let lastReason = 'NO_MODELS_CONFIGURED';

    for (const model of models) {
      tried.push(model);
      const result = await this.callModel(model, prompt);
      // A malformed response is the model's answer, not an availability problem —
      // falling through to the fallback would hide a prompt or schema defect behind a
      // second model that might happen to comply.
      if (result.kind !== 'UNAVAILABLE') return result;
      lastReason = result.reason;
    }

    return { kind: 'UNAVAILABLE', reason: lastReason, modelsTried: tried };
  }

  private async callModel(model: string, prompt: string): Promise<GeminiResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const baseUrl = this.options.baseUrl ?? DEFAULT_BASE_URL;
    const url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`;

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_RESPONSE_SCHEMA,
        // Deterministic-leaning: the same evidence should not produce materially
        // different prose run to run, or a stored report stops being explainable.
        temperature: 0.2,
        /**
         * Observed 2026-09-05: 1,600 truncated the response mid-JSON, producing a
         * `MALFORMED` result on an otherwise healthy call. The pipeline handled it
         * correctly — no statements written, run stored `AI_UNAVAILABLE` — but a
         * budget that clips a valid answer is a self-inflicted outage. The schema
         * caps the prose at roughly 1,900 characters; 4,096 tokens leaves room for
         * that plus the JSON scaffolding without inviting an essay.
         */
        maxOutputTokens: 16_384,
      },
    };

    const started = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      return {
        kind: 'UNAVAILABLE',
        reason: `TRANSPORT: ${error instanceof Error ? error.message : 'unknown'}`,
        modelsTried: [model],
      };
    }

    const latencyMs = Date.now() - started;
    const text = await response.text();

    if (!response.ok) {
      return {
        kind: 'UNAVAILABLE',
        reason: `HTTP_${String(response.status)}: ${text.slice(0, 200)}`,
        modelsTried: [model],
      };
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      // A 200 carrying non-JSON is the observed error-as-200 behaviour.
      return { kind: 'MALFORMED', raw: text.slice(0, 2000), errors: ['Response was not JSON'], model, latencyMs };
    }

    /**
     * A truncated response is reported as truncated, not as "not JSON".
     *
     * Observed 2026-09-05: at 1,600 and again at 4,096 output tokens the response was
     * cut mid-object, and the parse failure surfaced as `Candidate text was not JSON
     * despite responseSchema` — which reads like a provider defect and would have sent
     * whoever saw it hunting the wrong problem. `gemini-3.5-flash` spends part of the
     * budget on reasoning tokens, so the visible text is only a fraction of it.
     */
    const finishReason = extractFinishReason(envelope);
    if (finishReason === 'MAX_TOKENS') {
      return {
        kind: 'MALFORMED',
        raw: extractText(envelope) ?? envelope,
        errors: [
          'Response truncated: the model hit maxOutputTokens before closing the JSON. ' +
            'Raise the budget or shorten the bundle.',
        ],
        model,
        latencyMs,
      };
    }

    const inner = extractText(envelope);
    if (inner === null) {
      return {
        kind: 'MALFORMED',
        raw: envelope,
        errors: ['No candidate text in the response envelope'],
        model,
        latencyMs,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(inner);
    } catch {
      return {
        kind: 'MALFORMED',
        raw: inner.slice(0, 2000),
        errors: ['Candidate text was not JSON despite responseSchema'],
        model,
        latencyMs,
      };
    }

    const validated = assessmentSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        kind: 'MALFORMED',
        raw: parsed,
        errors: validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        model,
        latencyMs,
      };
    }

    const usage = extractUsage(envelope);
    return {
      kind: 'OK',
      assessment: validated.data,
      raw: parsed,
      model,
      latencyMs,
      promptTokens: usage.prompt,
      responseTokens: usage.response,
    };
  }
}

function extractText(envelope: unknown): string | null {
  if (envelope === null || typeof envelope !== 'object') return null;
  const candidates = (envelope as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as { content?: { parts?: { text?: unknown }[] } };
  const parts = first.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
  return text === '' ? null : text;
}

function extractFinishReason(envelope: unknown): string | null {
  if (envelope === null || typeof envelope !== 'object') return null;
  const candidates = (envelope as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const reason = (candidates[0] as { finishReason?: unknown }).finishReason;
  return typeof reason === 'string' ? reason : null;
}

function extractUsage(envelope: unknown): { prompt: number | null; response: number | null } {
  if (envelope === null || typeof envelope !== 'object') return { prompt: null, response: null };
  const usage = (envelope as { usageMetadata?: Record<string, unknown> }).usageMetadata;
  if (usage === undefined) return { prompt: null, response: null };
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return { prompt: num(usage.promptTokenCount), response: num(usage.candidatesTokenCount) };
}
