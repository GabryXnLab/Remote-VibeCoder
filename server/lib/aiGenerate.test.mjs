import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { generateCommitMessageLocal, generateCommitMessageAuto } = require('./aiGenerate.js');

const LOCAL = { baseUrl: 'http://local.test/v1', model: 'qwen3.5-4b', timeoutMs: 1000 };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const localOk  = (content) => jsonResponse({ choices: [{ message: { content } }] });
const geminiOk = (text)    => jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });

afterEach(() => { vi.restoreAllMocks(); });

describe('generateCommitMessageLocal', () => {
  it('chiama il router locale e disattiva il thinking', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(localOk('{"title":"feat: x","body":"y"}'));
    const res = await generateCommitMessageLocal('diff --git a b', LOCAL);

    expect(res).toEqual({ title: 'feat: x', body: 'y' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://local.test/v1/chat/completions');
    const payload = JSON.parse(init.body);
    expect(payload.model).toBe('qwen3.5-4b');
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('tronca i diff troppo lunghi per il contesto locale', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(localOk('{"title":"t","body":""}'));
    await generateCommitMessageLocal('x'.repeat(50_000), LOCAL);

    const userMsg = JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content;
    expect(userMsg.length).toBeLessThan(7_000);
    expect(userMsg).toContain('[Diff truncated');
  });

  it('fallisce se il provider locale è disattivato', async () => {
    await expect(generateCommitMessageLocal('d', { ...LOCAL, baseUrl: '' })).rejects.toThrow(/disabled/);
  });
});

describe('generateCommitMessageAuto', () => {
  it('usa il locale per primo, senza chiamare Gemini', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(localOk('{"title":"fix: a","body":"b"}'));
    const res = await generateCommitMessageAuto('d', { geminiApiKey: 'k', local: LOCAL });

    expect(res).toEqual({ title: 'fix: a', body: 'b', provider: 'local' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ripiega su Gemini se il locale non risponde', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(geminiOk('{"title":"docs: g","body":"h"}'));
    const res = await generateCommitMessageAuto('d', { geminiApiKey: 'k', geminiModel: 'm', local: LOCAL });

    expect(res).toEqual({ title: 'docs: g', body: 'h', provider: 'gemini' });
    expect(fetchMock.mock.calls[1][0]).toContain('generativelanguage.googleapis.com');
  });

  it('ripiega su Gemini se il locale risponde con errore HTTP', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'model not found' } }, 404))
      .mockResolvedValueOnce(geminiOk('{"title":"g","body":""}'));
    const res = await generateCommitMessageAuto('d', { geminiApiKey: 'k', local: LOCAL });

    expect(res.provider).toBe('gemini');
  });

  it('senza chiave Gemini riporta l\'errore del locale', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(generateCommitMessageAuto('d', { local: LOCAL }))
      .rejects.toThrow(/Local AI unavailable \(fetch failed\) and Gemini API key not configured/);
  });
});
