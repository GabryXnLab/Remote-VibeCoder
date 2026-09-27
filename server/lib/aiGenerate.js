'use strict';

const fsp  = require('fs/promises');
const path = require('path');
const simpleGit = require('simple-git');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_DIFF_LENGTH = 100_000;
const UNTRACKED_CONTENT_LIMIT = 2_000;

// AI locale (ai-stack): router OpenAI-compatibile sulla stessa macchina.
// LOCAL_AI_URL vuota disattiva il provider locale.
const LOCAL_AI_URL        = process.env.LOCAL_AI_URL ?? 'http://127.0.0.1:11435/v1';
const LOCAL_AI_MODEL      = process.env.LOCAL_AI_MODEL || 'qwen3.5-4b';
const LOCAL_AI_TIMEOUT_MS = Number(process.env.LOCAL_AI_TIMEOUT_MS) || 60_000;
// Il modello locale ha ~4k token di contesto per slot e fa il prefill a ~80 token/s su CPU:
// oltre questa soglia il diff non entra o la risposta arriva dopo il timeout.
const LOCAL_MAX_DIFF_LENGTH = Number(process.env.LOCAL_AI_MAX_DIFF_CHARS) || 6_000;

/**
 * Builds a unified diff string for the given repo (staged + unstaged + untracked).
 * @param {string} repoPath  absolute realpath of the repo
 * @returns {Promise<string>}
 */
async function getRepoDiff(repoPath) {
  const git = simpleGit(repoPath);
  let diffText = '';

  try {
    diffText = await git.diff(['HEAD']);
  } catch {
    // HEAD may not exist on a brand-new repo with no commits
    try { diffText = await git.diff([]); } catch {}
  }

  // Append untracked file contents as synthetic diff chunks
  let untracked = [];
  try {
    const st = await git.status();
    untracked = st.not_added || [];
  } catch {}

  const untrackedChunks = [];
  for (const relPath of untracked) {
    const fullPath = path.join(repoPath, relPath);
    try {
      let content = await fsp.readFile(fullPath, 'utf8');
      if (content.length > UNTRACKED_CONTENT_LIMIT) {
        content = content.slice(0, UNTRACKED_CONTENT_LIMIT) + '\n...[truncated]';
      }
      untrackedChunks.push(`--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1 @@\n${content}`);
    } catch {
      untrackedChunks.push(`--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1 @@\n[Binary or unreadable file]`);
    }
  }

  if (untrackedChunks.length > 0) {
    diffText += '\n\n' + untrackedChunks.join('\n\n');
  }

  if (diffText.length > MAX_DIFF_LENGTH) {
    diffText = diffText.slice(0, MAX_DIFF_LENGTH) + `\n\n[Diff truncated to ${MAX_DIFF_LENGTH} characters]`;
  }

  return diffText.trim();
}

/**
 * Calls the Gemini REST API to generate a conventional commit message.
 * @param {string} diffText
 * @param {string} apiKey    Gemini API key
 * @param {string} [model]   Gemini model ID
 * @returns {Promise<{ title: string, body: string }>}
 */
const SYSTEM_INSTRUCTION = `You are an expert developer. Your task is to write a clean, conventional commit message based on a git diff.
The output MUST be a valid JSON object with:
- "title": short, imperative commit title (max 60 chars).
- "body": detailed description of changes and why.

Requirements:
- Language: English.
- Use conventional commits (feat, fix, chore, style, refactor, docs, build, ci).
- No markdown formatting in the response.`;

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    body:  { type: 'string' },
  },
  required: ['title', 'body'],
};

function parseCommitJson(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      title: parsed.title || 'Update files',
      body:  parsed.body  || '',
    };
  } catch {
    return { title: 'Update files via AI', body: text };
  }
}

async function generateCommitMessage(diffText, apiKey, model = 'gemini-1.5-flash') {
  if (!apiKey) throw new Error('Gemini API key not configured');
  if (!diffText) return { title: 'Update files', body: 'No differences found.' };

  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method:  'POST',
    headers: { 
      'Content-Type': 'application/json'
    },
    body:    JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ parts: [{ text: `Git Diff:\n${diffText}` }] }],
      generation_config: { 
        response_mime_type: 'application/json',
        response_schema: COMMIT_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const msg = errBody.error?.message ?? `Gemini API error: HTTP ${response.status}`;
    throw new Error(msg);
  }

  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
  return parseCommitJson(text);
}

/**
 * Generates a commit message with the local OpenAI-compatible router (ai-stack).
 * @param {string} diffText
 * @param {{ baseUrl?: string, model?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ title: string, body: string }>}
 */
async function generateCommitMessageLocal(diffText, opts = {}) {
  const baseUrl   = opts.baseUrl   ?? LOCAL_AI_URL;
  const model     = opts.model     ?? LOCAL_AI_MODEL;
  const timeoutMs = opts.timeoutMs ?? LOCAL_AI_TIMEOUT_MS;
  if (!baseUrl) throw new Error('Local AI disabled');
  if (!diffText) return { title: 'Update files', body: 'No differences found.' };

  const diff = diffText.length > LOCAL_MAX_DIFF_LENGTH
    ? diffText.slice(0, LOCAL_MAX_DIFF_LENGTH) + `\n\n[Diff truncated to ${LOCAL_MAX_DIFF_LENGTH} characters]`
    : diffText;

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        { role: 'user',   content: `Git Diff:\n${diff}` },
      ],
      // I modelli Qwen3.5 sono "reasoning": senza questo spendono il budget di token a pensare.
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'commit', schema: COMMIT_SCHEMA } },
      temperature: 0.2,
      max_tokens:  400,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error?.message ?? `Local AI error: HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('Local AI returned an empty response');
  return parseCommitJson(text);
}

/**
 * Local AI first, Gemini as fallback (only if an API key is available).
 * @param {string} diffText
 * @param {{ geminiApiKey?: string, geminiModel?: string, local?: object }} [opts]
 * @returns {Promise<{ title: string, body: string, provider: 'local' | 'gemini' }>}
 */
async function generateCommitMessageAuto(diffText, { geminiApiKey, geminiModel, local } = {}) {
  let localErr;
  try {
    return { ...(await generateCommitMessageLocal(diffText, local)), provider: 'local' };
  } catch (err) {
    localErr = err;
  }
  if (!geminiApiKey) {
    throw new Error(`Local AI unavailable (${localErr.message}) and Gemini API key not configured`);
  }
  console.warn('[ai] local AI failed, falling back to Gemini:', localErr.message);
  return { ...(await generateCommitMessage(diffText, geminiApiKey, geminiModel)), provider: 'gemini' };
}

module.exports = { getRepoDiff, generateCommitMessage, generateCommitMessageLocal, generateCommitMessageAuto };
