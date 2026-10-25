import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiRequestError, chatCompletion, completeStructured } from '../src/services/ai/client.js';
import { env } from '../src/config/env.js';

function enableAi() {
  env.OPENROUTER_API_KEY = 'test-key';
  env.aiConfigured = true;
  env.AI_MAX_RETRIES = 1;
  env.AI_TIMEOUT_MS = 2_000;
}

function disableAi() {
  env.OPENROUTER_API_KEY = '';
  env.aiConfigured = false;
  env.AI_MAX_RETRIES = 3;
  env.AI_TIMEOUT_MS = 90_000;
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  disableAi();
});

describe('OpenRouter client', () => {
  it('refuses to call the provider without an API key', async () => {
    await expect(
      chatCompletion({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ aiCode: 'not_configured' });
  });

  it('retries a rate-limited request and then succeeds', async () => {
    enableAi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(
        jsonResponse({
          model: 'test/model',
          choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletion({
      model: 'test/model',
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(result.content).toBe('OK');
    expect(result.usage?.totalTokens).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies insufficient credits without retrying', async () => {
    enableAi();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'Insufficient credits' } }, 402));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chatCompletion({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ aiCode: 'insufficient_credits' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies authentication failures', async () => {
    enableAi();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: {} }, 401)));
    await expect(
      chatCompletion({ model: 'test/model', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ aiCode: 'auth' });
  });

  it('reports timeouts as retryable errors', async () => {
    enableAi();
    env.AI_MAX_RETRIES = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
    const error = await chatCompletion({
      model: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiRequestError);
    expect((error as AiRequestError).aiCode).toBe('timeout');
  });

  it('repairs invalid JSON with a second structured request', async () => {
    enableAi();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/models')) return jsonResponse({ data: [] });
      const callCount = fetchMock.mock.calls.filter((call) => String(call[0]).includes('chat/completions')).length;
      if (callCount <= 1) {
        return jsonResponse({
          model: 'test/model',
          choices: [{ message: { content: 'I cannot comply in JSON.' }, finish_reason: 'stop' }],
        });
      }
      return jsonResponse({
        model: 'test/model',
        choices: [{ message: { content: '{"ok": true, "count": 2}' }, finish_reason: 'stop' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const schema = z.object({ ok: z.boolean(), count: z.number().int() });
    const result = await completeStructured({
      model: 'test/model',
      task: 'test task',
      system: 'Return JSON',
      user: 'Give me a result',
      schema,
    });
    expect(result.data).toEqual({ ok: true, count: 2 });
    expect(result.attempts).toBe(2);
  });

  it('fails after repeated schema violations instead of returning unvalidated data', async () => {
    enableAi();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/models')) return jsonResponse({ data: [] });
        return jsonResponse({
          model: 'test/model',
          choices: [{ message: { content: '{"ok": "yes"}' }, finish_reason: 'stop' }],
        });
      }),
    );
    await expect(
      completeStructured({
        model: 'test/model',
        task: 'test task',
        system: 'Return JSON',
        user: 'Give me a result',
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toMatchObject({ code: 'AI_ERROR' });
  });
});
