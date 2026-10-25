import { env } from '../../config/env.js';
import { getSettings, resolveModel } from '../settingsService.js';
import { AiRequestError, chatCompletion, listModels } from './client.js';

export async function aiStatus() {
  const settings = await getSettings();
  return {
    configured: env.aiConfigured,
    provider: 'openrouter',
    baseUrl: env.OPENROUTER_BASE_URL,
    model: resolveModel(settings),
    envModel: env.OPENROUTER_MODEL,
    deterministicFallback: true,
    limits: {
      timeoutMs: env.AI_TIMEOUT_MS,
      maxRetries: env.AI_MAX_RETRIES,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
      maxInputChars: env.AI_MAX_INPUT_CHARS,
    },
  };
}

export async function testAiConnection(input?: { model?: string }) {
  const settings = await getSettings();
  const model = (input?.model || resolveModel(settings)).trim();

  if (!env.aiConfigured) {
    return {
      ok: false,
      configured: false,
      model,
      message: 'OPENROUTER_API_KEY is missing. Add it to .env and restart the backend container.',
    };
  }
  if (!model) {
    return {
      ok: false,
      configured: true,
      model,
      message: 'No model selected. Pick one in Settings or set OPENROUTER_MODEL.',
    };
  }

  try {
    const result = await chatCompletion({
      model,
      messages: [
        { role: 'system', content: 'Reply with exactly: OK' },
        { role: 'user', content: 'Connection test' },
      ],
      maxTokens: 16,
      temperature: 0,
      retries: 1,
      timeoutMs: 30_000,
    });
    return {
      ok: true,
      configured: true,
      model: result.model,
      message: 'OpenRouter responded successfully.',
      reply: result.content.slice(0, 40),
      usage: result.usage,
    };
  } catch (error) {
    const detail =
      error instanceof AiRequestError
        ? { code: error.aiCode, message: error.message }
        : { code: 'provider', message: error instanceof Error ? error.message : 'unknown error' };
    return { ok: false, configured: true, model, ...detail };
  }
}

export async function availableModels(force = false) {
  if (!env.aiConfigured) {
    return { configured: false, models: [], note: 'Set OPENROUTER_API_KEY to load models.' };
  }
  try {
    const models = await listModels(force);
    return { configured: true, models, note: '' };
  } catch (error) {
    return {
      configured: true,
      models: [],
      note: error instanceof Error ? error.message : 'Could not load models. Enter the model ID manually.',
    };
  }
}
