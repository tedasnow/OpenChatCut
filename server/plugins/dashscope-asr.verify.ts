import assert from 'node:assert/strict';

import { transcribeDashscopeAudio } from './dashscope-asr.ts';
import { TranscriptionConfigurationError } from './transcription-types.ts';
import type { TranscriptionOptions } from './transcription-types.ts';

const options: TranscriptionOptions = {
  openaiBaseUrl: '',
  openaiApiKey: '',
  openaiModel: '',
  mistralBaseUrl: '',
  mistralApiKey: '',
  mistralModel: '',
  deepgramApiKey: '',
  deepgramModel: '',
  groqBaseUrl: '',
  groqApiKey: '',
  groqModel: '',
  elevenApiKey: '',
  elevenModel: '',
  cartesiaApiKey: '',
  cartesiaModel: '',
  dashscopeApiKey: 'dashscope-test-key',
  dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  dashscopeModel: 'qwen-audio-3.1-asr-flash-filetrans',
  language: 'zh',
  diarization: true,
};

// MP3 frame sync so the extension sniffer picks .mp3.
const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);

const transcriptionPayload = {
  transcripts: [{
    sentences: [
      {
        begin_time: 520,
        end_time: 2120,
        text: '你好世界',
        speaker_id: 0,
        words: [
          { begin_time: 520, end_time: 1000, text: '你好' },
          { begin_time: 1240, end_time: 2120, text: '世界' },
        ],
      },
      {
        begin_time: 24310,
        end_time: 25470,
        text: '说了半天白说',
        speaker_id: 1,
        words: [{ begin_time: 24310, end_time: 25470, text: '说了半天白说' }],
      },
      // No word detail: must synthesize one word from the sentence.
      { begin_time: 30000, end_time: 31000, text: '没有词级细节', speaker_id: 0 },
    ],
  }],
};

function okJson(body: unknown): Response {
  return Response.json(body);
}

function makeFetch(handlers: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Response | Promise<Response> }>) {
  const seen: string[] = [];
  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    for (const handler of handlers) {
      if (handler.match(url, init)) return handler.respond(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchFn: fetchFn as typeof fetch, seen };
}

const noSleep = () => Promise.resolve();

// ── 1. Bailian endpoint: getPolicy upload → submit → poll → normalize ──
{
  const { fetchFn, seen } = makeFetch([
    {
      match: (url) => url.includes('/uploads?action=getPolicy'),
      respond: () => okJson({
        data: {
          policy: 'p', signature: 's', oss_access_key_id: 'ak',
          upload_dir: 'dashscope-instant/acct/2026-09-24', upload_host: 'https://oss.test',
        },
      }),
    },
    { match: (url) => url.startsWith('https://oss.test'), respond: () => new Response(null, { status: 200 }) },
    {
      match: (url, init) => url.includes('/services/audio/asr/transcription') && init?.method === 'POST',
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          input: { file_urls: string[] };
          parameters: Record<string, unknown>;
        };
        assert.equal(body.model, 'qwen-audio-3.1-asr-flash-filetrans');
        assert.match(body.input.file_urls[0]!, /^oss:\/\/dashscope-instant\/acct\/2026-09-24\/.+\.mp3$/);
        assert.deepEqual(body.parameters, {
          channel_id: [0], enable_words: true, diarization_enabled: true, language_hints: ['zh'],
        });
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('X-DashScope-Async'), 'enable');
        return okJson({ output: { task_id: 'task-1', task_status: 'PENDING' } });
      },
    },
    {
      match: (url, init) => url.endsWith('/tasks/task-1') && (!init || !init.method),
      respond: (_url, init) => {
        // The QwenAI-platform gateway 403s task queries carrying the async
        // header — polling must never send it.
        assert.equal(new Headers(init?.headers).get('X-DashScope-Async'), null);
        return okJson({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ transcription_url: 'https://result.test/out.json' }],
          },
        });
      },
    },
    { match: (url) => url === 'https://result.test/out.json', respond: () => okJson(transcriptionPayload) },
  ]);

  const result = await transcribeDashscopeAudio(options, {
    provider: 'dashscope', audio, language: 'zh', diarize: true,
  }, { fetchFn, sleep: noSleep });

  assert.deepEqual(result, {
    text: '你好世界\n说了半天白说\n没有词级细节',
    words: [
      { text: '你好', start: 520, end: 1000, speaker: '0' },
      { text: '世界', start: 1240, end: 2120, speaker: '0' },
      { text: '说了半天白说', start: 24310, end: 25470, speaker: '1' },
      { text: '没有词级细节', start: 30000, end: 31000, speaker: '0' },
    ],
    utterances: [
      {
        speaker: '0', text: '你好世界', start: 520, end: 2120,
        words: [
          { text: '你好', start: 520, end: 1000, speaker: '0' },
          { text: '世界', start: 1240, end: 2120, speaker: '0' },
        ],
      },
      {
        speaker: '1', text: '说了半天白说', start: 24310, end: 25470,
        words: [{ text: '说了半天白说', start: 24310, end: 25470, speaker: '1' }],
      },
      {
        speaker: '0', text: '没有词级细节', start: 30000, end: 31000,
        words: [{ text: '没有词级细节', start: 30000, end: 31000, speaker: '0' }],
      },
    ],
  });
  assert.ok(seen.some((url) => url.includes('/uploads?action=getPolicy')), 'Bailian endpoint must try getPolicy first');
  console.log('dashscope-asr.verify: ok (Bailian getPolicy path + normalization)');
}

// ── 2. QwenAI-platform endpoint: R2 is preferred, oss:// never submitted ──
{
  let stagedKey = '';
  let cleanedUp = false;
  const { fetchFn, seen } = makeFetch([
    {
      match: (url) => url.includes('/services/audio/asr/transcription'),
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: { file_urls: string[] } };
        assert.match(body.input.file_urls[0]!, /^https:\/\/r2\.test\/asr-tmp\/.+\.mp3\?sig=/);
        return okJson({ output: { task_id: 'task-2', task_status: 'PENDING' } });
      },
    },
    {
      match: (url) => url.endsWith('/tasks/task-2'),
      respond: () => okJson({
        output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://result.test/out.json' }] },
      }),
    },
    { match: (url) => url === 'https://result.test/out.json', respond: () => okJson(transcriptionPayload) },
  ]);

  const result = await transcribeDashscopeAudio(
    { ...options, dashscopeBaseUrl: 'https://maas.qianwenaiapi.com/api/v1' },
    { provider: 'dashscope', audio, language: 'zh', diarize: true },
    {
      fetchFn,
      sleep: noSleep,
      stageR2: async (_bytes, ext) => {
        stagedKey = `asr-tmp/test.${ext}`;
        return {
          url: `https://r2.test/${stagedKey}?sig=abc`,
          cleanup: async () => { cleanedUp = true; },
        };
      },
    },
  );
  assert.equal(result.words.length, 4);
  assert.ok(!seen.some((url) => url.includes('/uploads?action=getPolicy')), 'QwenAI endpoint must skip getPolicy');
  assert.ok(cleanedUp, 'R2 temp object must be cleaned up after success');
  console.log('dashscope-asr.verify: ok (QwenAI endpoint → R2 presigned staging + cleanup)');
}

// ── 3. Bailian oss:// rejected → falls back to R2 ──
{
  let r2Used = false;
  const { fetchFn } = makeFetch([
    {
      match: (url) => url.includes('/uploads?action=getPolicy'),
      respond: () => okJson({
        data: {
          policy: 'p', signature: 's', oss_access_key_id: 'ak',
          upload_dir: 'dashscope-instant/acct', upload_host: 'https://oss.test',
        },
      }),
    },
    { match: (url) => url.startsWith('https://oss.test'), respond: () => new Response(null, { status: 200 }) },
    {
      match: (url) => url.includes('/services/audio/asr/transcription'),
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: { file_urls: string[] } };
        return okJson({
          output: {
            task_id: body.input.file_urls[0]!.startsWith('oss://') ? 'task-oss' : 'task-r2',
            task_status: 'PENDING',
          },
        });
      },
    },
    {
      match: (url) => url.endsWith('/tasks/task-oss'),
      respond: () => okJson({
        output: { task_status: 'FAILED', code: 'REQUEST_INVALID_FILE_URL_VALUE', message: 'REQUEST_INVALID_FILE_URL_VALUE' },
      }),
    },
    {
      match: (url) => url.endsWith('/tasks/task-r2'),
      respond: () => okJson({
        output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://result.test/out.json' }] },
      }),
    },
    { match: (url) => url === 'https://result.test/out.json', respond: () => okJson(transcriptionPayload) },
  ]);

  const result = await transcribeDashscopeAudio(options, {
    provider: 'dashscope', audio, language: 'zh', diarize: true,
  }, {
    fetchFn,
    sleep: noSleep,
    stageR2: async () => {
      r2Used = true;
      return { url: 'https://r2.test/asr-tmp/x.mp3?sig=abc', cleanup: async () => {} };
    },
  });
  assert.equal(r2Used, true);
  assert.equal(result.words.length, 4);
  console.log('dashscope-asr.verify: ok (oss:// rejection falls back to R2)');
}

// ── 4. No staging available → configuration error with guidance ──
{
  const { fetchFn } = makeFetch([
    {
      match: (url) => url.includes('/uploads?action=getPolicy'),
      respond: () => new Response('not found', { status: 404 }),
    },
  ]);
  await assert.rejects(
    transcribeDashscopeAudio(
      { ...options, dashscopeBaseUrl: 'https://maas.qianwenaiapi.com/api/v1' },
      { provider: 'dashscope', audio, language: 'zh', diarize: false },
      { fetchFn, sleep: noSleep, stageR2: async () => null },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TranscriptionConfigurationError);
      assert.match(error.message, /R2/);
      return true;
    },
  );
  console.log('dashscope-asr.verify: ok (no staging → actionable configuration error)');
}

// ── 5. Task failure is surfaced with code/message ──
{
  const { fetchFn } = makeFetch([
    {
      match: (url) => url.includes('/services/audio/asr/transcription'),
      respond: () => okJson({ output: { task_id: 'task-bad', task_status: 'PENDING' } }),
    },
    {
      match: (url) => url.endsWith('/tasks/task-bad'),
      respond: () => okJson({
        output: { task_status: 'FAILED', code: 'FILE_DOWNLOAD_FAILED', message: 'cannot fetch' },
      }),
    },
  ]);
  await assert.rejects(
    transcribeDashscopeAudio(
      { ...options, dashscopeBaseUrl: 'https://maas.qianwenaiapi.com/api/v1' },
      { provider: 'dashscope', audio, language: 'auto', diarize: false },
      {
        fetchFn,
        sleep: noSleep,
        stageR2: async () => ({ url: 'https://r2.test/asr-tmp/x.mp3?sig=abc', cleanup: async () => {} }),
      },
    ),
    /FILE_DOWNLOAD_FAILED.*cannot fetch/,
  );
  console.log('dashscope-asr.verify: ok (task failure surfaces code/message)');
}
