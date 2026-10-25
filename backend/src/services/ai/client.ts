import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { backoffDelay, sleep } from '../../utils/async.js';
import { extractJsonObject, truncate } from '../../utils/text.js';

export type AiFailure =
  | 'not_configured'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'invalid_json'
  | 'insufficient_credits'
  | 'invalid_model'
  | 'provider';

export class AiRequestError extends AppError {
  aiCode: AiFailure;
  upstreamStatus?: number;

  constructor(
    aiCode: AiFailure,
    message: string,
    options: { statusCode?: number; retryable?: boolean; cause?: unknown; upstreamStatus?: number } = {},
  ) {
    const status =
      options.statusCode ??
      (aiCode === 'auth' || aiCode === 'invalid_model'
        ? 502
        : aiCode === 'rate_limit'
          ? 429
          : aiCode === 'not_configured'
            ? 503
            : 502);
    super(status, aiCode === 'not_configured' ? 'AI_NOT_CONFIGURED' : 'AI_ERROR', message, {
      retryable: options.retryable,
      cause: options.cause,
    });
    this.name = 'AiRequestError';
    this.aiCode = aiCode;
    this.upstreamStatus = options.upstreamStatus;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  model: string;
  finishReason: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number | null;
  pricing: Record<string, string> | null;
  supportedParameters: string[];
  description: string;
}

let modelCache: { at: number; models: OpenRouterModel[] } | null = null;
const MODEL_CACHE_MS = 10 * 60_000;

function authHeaders(): Record<string, string> {
  if (!env.aiConfigured) {
    throw new AiRequestError('not_configured', 'OPENROUTER_API_KEY is not configured.');
  }
  return {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    'HTTP-Referer': env.OPENROUTER_HTTP_REFERER,
    'X-Title': env.OPENROUTER_APP_TITLE,
    'Content-Type': 'application/json',
  };
}

function classifyStatus(status: number, body: string): AiRequestError {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403) {
    return new AiRequestError('auth', 'OpenRouter rejected the API key (authentication failed).');
  }
  if (status === 402 || lower.includes('insufficient credits') || lower.includes('insufficient_quota')) {
    return new AiRequestError(
      'insufficient_credits',
      'OpenRouter reports insufficient credits for this request.',
    );
  }
  if (status === 429) {
    return new AiRequestError('rate_limit', 'OpenRouter rate limit reached.', { retryable: true });
  }
  if (status === 404) {
    return new AiRequestError('invalid_model', 'The selected OpenRouter model was not found.');
  }
  if (status === 400 || status === 422) {
    if (lower.includes('model')) {
      return new AiRequestError('invalid_model', 'OpenRouter rejected the selected model or request.');
    }
    return new AiRequestError('provider', 'OpenRouter rejected the request.', { statusCode: 502 });
  }
  return new AiRequestError('provider', `OpenRouter request failed with status ${status}.`, {
    retryable: status >= 500,
  });
}

async function readErrorBody(response: Response): Promise<{ message: string; body: string }> {
  const raw = await response.text().catch(() => '');
  let message = raw.slice(0, 300);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) message = parsed.error.message.slice(0, 300);
  } catch {
    // Keep the truncated raw body.
  }
  return { message, body: raw.slice(0, 2000) };
}

export async function chatCompletion(options: {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | null;
  timeoutMs?: number;
  retries?: number;
}): Promise<ChatResult> {
  const model = options.model.trim();
  if (!model) {
    throw new AiRequestError('invalid_model', 'No AI model is configured. Choose one in Settings.');
  }
  if (!env.aiConfigured) {
    throw new AiRequestError('not_configured', 'OPENROUTER_API_KEY is not configured.');
  }

  const totalChars = options.messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars > env.AI_MAX_INPUT_CHARS) {
    throw new AiRequestError(
      'provider',
      `Prompt too large (${totalChars} characters). Limit is ${env.AI_MAX_INPUT_CHARS}.`,
      { statusCode: 400 },
    );
  }

  const maxRetries = Math.max(0, Math.min(options.retries ?? env.AI_MAX_RETRIES, 6));
  const timeoutMs = options.timeoutMs ?? env.AI_TIMEOUT_MS;
  const url = `${env.OPENROUTER_BASE_URL.replace(/\/+$/, '')}/chat/completions`;

  let lastError: AiRequestError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: authHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: options.messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: Math.min(options.maxTokens ?? env.AI_MAX_OUTPUT_TOKENS, env.AI_MAX_OUTPUT_TOKENS),
          ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
        }),
      });

      if (!response.ok) {
        const { message, body } = await readErrorBody(response);
        const error = classifyStatus(response.status, body);
        error.upstreamStatus = response.status;
        logger.warn(
          { status: response.status, aiCode: error.aiCode, attempt, durationMs: Date.now() - started, detail: message },
          'OpenRouter request failed',
        );
        lastError = error;
        if (!error.retryable) throw error;

        const retryAfter = Number.parseFloat(response.headers.get('retry-after') ?? '');
        const waitMs = Number.isFinite(retryAfter)
          ? Math.min(10_000, retryAfter * 1000)
          : backoffDelay(attempt);
        if (attempt < maxRetries) await sleep(waitMs);
        continue;
      }

      const json = (await response.json()) as {
        model?: string;
        choices?: Array<{
          message?: { content?: string | Array<{ type?: string; text?: string }> };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        error?: { message?: string };
      };

      if (json.error?.message) {
        throw new AiRequestError('provider', `OpenRouter provider error: ${json.error.message.slice(0, 200)}`);
      }

      const rawContent = json.choices?.[0]?.message?.content;
      const content = Array.isArray(rawContent)
        ? rawContent.map((part) => part.text ?? '').join('')
        : (rawContent ?? '');
      if (!content.trim()) {
        throw new AiRequestError('provider', 'The model returned an empty response.', {
          retryable: true,
        });
      }

      logger.debug(
        { model: json.model ?? model, durationMs: Date.now() - started, outputChars: content.length },
        'OpenRouter request completed',
      );

      return {
        content,
        model: json.model ?? model,
        finishReason: json.choices?.[0]?.finish_reason ?? 'unknown',
        usage: json.usage
          ? {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens,
              totalTokens: json.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof AiRequestError) {
        if (!error.retryable) throw error;
        lastError = error;
      } else if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        lastError = new AiRequestError('timeout', `OpenRouter request timed out after ${timeoutMs} ms.`, {
          retryable: true,
        });
      } else {
        lastError = new AiRequestError(
          'provider',
          `Network error contacting OpenRouter: ${error instanceof Error ? error.message : 'unknown'}`,
          { retryable: true, cause: error },
        );
      }
      if (attempt < maxRetries) {
        const waitMs = backoffDelay(attempt);
        logger.debug({ attempt, waitMs }, 'Retrying OpenRouter request');
        await sleep(waitMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ??
    new AiRequestError('provider', 'OpenRouter request failed after retries.', { retryable: false })
  );
}

export async function listModels(force = false): Promise<OpenRouterModel[]> {
  if (!env.aiConfigured) return [];
  if (!force && modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${env.OPENROUTER_BASE_URL.replace(/\/+$/, '')}/models`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) {
      const { body } = await readErrorBody(response);
      throw classifyStatus(response.status, body);
    }
    const json = (await response.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        pricing?: Record<string, string>;
        supported_parameters?: string[];
        description?: string;
      }>;
    };
    const models: OpenRouterModel[] = (json.data ?? [])
      .filter((item): item is { id: string } & typeof item => Boolean(item.id))
      .map((item) => ({
        id: item.id,
        name: item.name ?? item.id,
        contextLength: item.context_length ?? null,
        pricing: item.pricing ?? null,
        supportedParameters: item.supported_parameters ?? [],
        description: (item.description ?? '').slice(0, 500),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    modelCache = { at: Date.now(), models };
    return models;
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiRequestError('timeout', 'Timed out fetching the OpenRouter model list.');
    }
    throw new AiRequestError('provider', 'Could not fetch the OpenRouter model list.', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export async function getModelCapabilities(modelId: string): Promise<{
  known: boolean;
  supportsJsonMode: boolean | null;
  supportsTools: boolean | null;
  contextLength: number | null;
}> {
  try {
    const models = await listModels();
    const model = models.find((item) => item.id === modelId);
    if (!model) return { known: false, supportsJsonMode: null, supportsTools: null, contextLength: null };
    const params = model.supportedParameters.map((item) => item.toLowerCase());
    const hasJson = params.some(
      (item) => item.includes('response_format') || item.includes('structured_output'),
    );
    const hasTools = params.includes('tools') || params.includes('tool_choice');
    return {
      known: true,
      supportsJsonMode: hasJson,
      supportsTools: hasTools,
      contextLength: model.contextLength,
    };
  } catch {
    return { known: false, supportsJsonMode: null, supportsTools: null, contextLength: null };
  }
}

export interface StructuredOptions<T> {
  model: string;
  task: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  temperature?: number;
  maxTokens?: number;
  /** Called at most once when the first response fails validation. */
  repairHint?: string;
}

export interface StructuredResult<T> {
  data: T;
  raw: string;
  model: string;
  attempts: number;
  usage?: ChatResult['usage'];
}

function schemaHint(schema: z.ZodType<unknown>): string {
  try {
    const json = z.toJSONSchema(schema, { io: 'output' });
    return truncate(JSON.stringify(json), 6_000);
  } catch {
    return 'Return a single JSON object matching the requested fields.';
  }
}

export async function completeStructured<T>(options: StructuredOptions<T>): Promise<StructuredResult<T>> {
  const capabilities = await getModelCapabilities(options.model);
  // Only use provider JSON mode when the catalog explicitly advertises support.
  let useJsonMode = capabilities.supportsJsonMode === true;
  let userPrompt = `${options.user}\n\nReturn ONLY one JSON object matching this JSON Schema:\n${schemaHint(options.schema)}\nDo not add markdown fences or commentary.`;
  let lastRaw = '';
  let lastError: Error | null = null;
  const maxAttempts = 2;
  let usage: ChatResult['usage'];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await chatCompletion({
        model: options.model,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: userPrompt },
        ],
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        responseFormat: useJsonMode ? 'json_object' : null,
        retries: 2,
      });
      lastRaw = result.content;
      usage = result.usage;

      let parsedJson: unknown;
      try {
        parsedJson = extractJsonObject(result.content);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : 'Invalid JSON');
      }

      const validated = options.schema.safeParse(parsedJson);
      if (validated.success) {
        return { data: validated.data, raw: result.content, model: result.model, attempts: attempt + 1, usage };
      }

      const issues = validated.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      lastError = new Error(`Schema validation failed: ${issues}`);
      logger.warn({ task: options.task, attempt, issues }, 'AI response failed schema validation');
      userPrompt = `${options.user}\n\nYour previous response was rejected: ${issues}. ${
        options.repairHint ?? 'Return corrected JSON only.'
      }\nJSON Schema:\n${schemaHint(options.schema)}`;
    } catch (error) {
      if (
        error instanceof AiRequestError &&
        useJsonMode &&
        (error.aiCode === 'invalid_model' ||
          error.upstreamStatus === 400 ||
          error.upstreamStatus === 422)
      ) {
        // Some providers reject response_format, or mislabel it as an invalid model.
        // Retry the same attempt in prompt-only JSON mode.
        logger.info({ task: options.task }, 'Retrying without provider JSON mode');
        useJsonMode = false;
        attempt -= 1;
        continue;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof AiRequestError && !error.retryable && error.aiCode === 'auth') throw error;
      logger.warn(
        { task: options.task, attempt, error: lastError.message },
        'Structured AI request attempt failed',
      );
      userPrompt = `${options.user}\n\nReturn ONLY valid JSON matching this JSON Schema:\n${schemaHint(options.schema)}`;
    }
  }

  const error = new AppError(
    502,
    'AI_ERROR',
    `The AI response for "${options.task}" could not be validated after retry.`,
    { details: { reason: lastError?.message, rawPreview: lastRaw.slice(0, 500) } },
  );
  (error as AppError & { aiCode?: string }).aiCode = 'invalid_json';
  throw error;
}

export function aiConfigured(): boolean {
  return env.aiConfigured;
}
