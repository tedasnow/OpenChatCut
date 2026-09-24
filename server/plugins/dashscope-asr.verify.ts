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
  dashscopeBaseUrl: 'https://maas.qianwenaiapi.com/api/v1',
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

const expectedResult = {
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
};

// ── 1. R2 presigned staging → submit → poll → normalize ──
{
  let cleanedUp = false;
  const { fetchFn } = makeFetch([
    {
      match: (url, init) => url.includes('/services/audio/asr/transcription') && init?.method === 'POST',
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          input: { file_urls: string[] };
          parameters: Record<string, unknown>;
        };
        assert.equal(body.model, 'qwen-audio-3.1-asr-flash-filetrans');
        assert.match(body.input.file_urls[0]!, /^https:\/\/r2\.test\/asr-tmp\/.+\.mp3\?sig=/);
        assert.deepEqual(body.parameters, {
          channel_id: [0], enable_words: true, diarization_enabled: true, language_hints: ['zh'],
        });
        assert.equal(new Headers(init?.headers).get('X-DashScope-Async'), 'enable');
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
  }, {
    fetchFn,
    sleep: noSleep,
    stageR2: async () => ({
      url: 'https://r2.test/asr-tmp/x.mp3?sig=abc',
      cleanup: async () => { cleanedUp = true; },
    }),
  });
  assert.deepEqual(result, expectedResult);
  assert.ok(cleanedUp, 'R2 temp object must be cleaned up after success');
  console.log('dashscope-asr.verify: ok (R2 staging + poll + normalization + cleanup)');
}

// ── 2. OGG audio is staged with the .ogg extension ──
{
  const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]); // "OggS"
  const { fetchFn } = makeFetch([
    {
      match: (url) => url.includes('/services/audio/asr/transcription'),
      respond: (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: { file_urls: string[] } };
        assert.match(body.input.file_urls[0]!, /\.ogg\?sig=/);
        return okJson({ output: { task_id: 'task-ogg', task_status: 'PENDING' } });
      },
    },
    {
      match: (url) => url.endsWith('/tasks/task-ogg'),
      respond: () => okJson({
        output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://result.test/out.json' }] },
      }),
    },
    { match: (url) => url === 'https://result.test/out.json', respond: () => okJson(transcriptionPayload) },
  ]);
  const result = await transcribeDashscopeAudio(options, {
    provider: 'dashscope', audio: ogg, language: 'auto', diarize: false,
  }, {
    fetchFn,
    sleep: noSleep,
    stageR2: async (_bytes, ext) => ({ url: `https://r2.test/asr-tmp/x.${ext}?sig=abc`, cleanup: async () => {} }),
  });
  assert.equal(result.words.length, 4);
  console.log('dashscope-asr.verify: ok (ogg extension sniffing)');
}

// ── 3. R2 unavailable → configuration error with guidance ──
{
  const { fetchFn, seen } = makeFetch([]);
  await assert.rejects(
    transcribeDashscopeAudio(options, {
      provider: 'dashscope', audio, language: 'zh', diarize: false,
    }, { fetchFn, sleep: noSleep, stageR2: async () => null }),
    (error: unknown) => {
      assert.ok(error instanceof TranscriptionConfigurationError);
      assert.match(error.message, /R2/);
      return true;
    },
  );
  assert.equal(seen.length, 0, 'no network request may happen without staged audio');
  console.log('dashscope-asr.verify: ok (R2 missing → actionable configuration error)');
}

// ── 4. Task failure is surfaced with code/message ──
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
    transcribeDashscopeAudio(options, {
      provider: 'dashscope', audio, language: 'auto', diarize: false,
    }, {
      fetchFn,
      sleep: noSleep,
      stageR2: async () => ({ url: 'https://r2.test/asr-tmp/x.mp3?sig=abc', cleanup: async () => {} }),
    }),
    /FILE_DOWNLOAD_FAILED.*cannot fetch/,
  );
  console.log('dashscope-asr.verify: ok (task failure surfaces code/message)');
}

// ── 5. Invalid key surfaces as a configuration error ──
{
  const { fetchFn } = makeFetch([
    {
      match: (url) => url.includes('/services/audio/asr/transcription'),
      respond: () => new Response('{"code":"Unauthorized"}', { status: 401 }),
    },
  ]);
  await assert.rejects(
    transcribeDashscopeAudio(options, {
      provider: 'dashscope', audio, language: 'auto', diarize: false,
    }, {
      fetchFn,
      sleep: noSleep,
      stageR2: async () => ({ url: 'https://r2.test/asr-tmp/x.mp3?sig=abc', cleanup: async () => {} }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof TranscriptionConfigurationError);
      assert.match(error.message, /401/);
      return true;
    },
  );
  console.log('dashscope-asr.verify: ok (401 → configuration error)');
}
