// DashScope (Qwen ASR) file transcription. Unlike every other cloud provider,
// the async filetrans API only accepts a URL — audio bytes must be staged first.
// Staging uses the project's existing Cloudflare R2 store with a presigned GET
// (DashScope's getPolicy temp upload is rejected by the filetrans service for
// QwenAI-platform keys with REQUEST_INVALID_FILE_URL_VALUE, so R2 is required).
// Polling deliberately omits X-DashScope-Async — the QwenAI-platform gateway
// 403s task queries carrying it ("current user api does not support
// asynchronous calls"), while Bailian accepts its absence.
import { randomUUID } from 'node:crypto';

import { deleteTempObject, presignTempGetUrl, putTempObject } from '../r2.ts';

import type {
  CloudTranscriptionRequest,
  NormalizedTranscriptResult,
  NormalizedTranscriptUtterance,
  NormalizedTranscriptWord,
  TranscriptionOptions,
} from './transcription-types.ts';
import { TranscriptionConfigurationError } from './transcription-types.ts';

const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PRESIGN_EXPIRES_SECONDS = 3600;

interface DashscopeDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override R2 staging (tests); defaults to the project R2 store. */
  stageR2?: (audio: Uint8Array, ext: string) => Promise<{ url: string; cleanup: () => Promise<void> } | null>;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

function baseUrlOf(options: TranscriptionOptions): string {
  return (options.dashscopeBaseUrl || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '');
}

/** The extracted ASR audio is .asr.ogg or .asr.mp3 — sniff the magic bytes. */
function sniffExtension(audio: Uint8Array): string {
  if (audio.length >= 4 && audio[0] === 0x4f && audio[1] === 0x67 && audio[2] === 0x67 && audio[3] === 0x53) return 'ogg'; // "OggS"
  if (audio.length >= 3 && audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) return 'mp3'; // "ID3"
  if (audio.length >= 2 && audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  if (audio.length >= 4 && audio[0] === 0x52 && audio[1] === 0x49 && audio[2] === 0x46 && audio[3] === 0x46) return 'wav'; // "RIFF"
  return 'mp3';
}

async function dashscopeFetch(
  fetchFn: typeof fetch,
  url: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new TranscriptionConfigurationError(`DashScope rejected the API key (HTTP ${response.status})`);
    }
    throw new Error(`DashScope request failed: HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  const body = asRecord(text ? JSON.parse(text) : null);
  if (!body) throw new Error('DashScope returned an invalid JSON response');
  return body;
}

async function defaultStageR2(
  audio: Uint8Array,
  ext: string,
): Promise<{ url: string; cleanup: () => Promise<void> } | null> {
  const key = `asr-tmp/${randomUUID()}.${ext}`;
  const stored = await putTempObject(key, audio, ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg');
  if (!stored) return null;
  const url = await presignTempGetUrl(key, PRESIGN_EXPIRES_SECONDS);
  if (!url) {
    await deleteTempObject(key).catch(() => {});
    return null;
  }
  return { url, cleanup: async () => { await deleteTempObject(key).catch(() => {}); } };
}

async function submitTask(
  options: TranscriptionOptions,
  fileUrl: string,
  request: CloudTranscriptionRequest,
  fetchFn: typeof fetch,
): Promise<string> {
  const body = await dashscopeFetch(fetchFn, `${baseUrlOf(options)}/services/audio/asr/transcription`, options.dashscopeApiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model: options.dashscopeModel,
      input: { file_urls: [fileUrl] },
      parameters: {
        channel_id: [0],
        enable_words: true,
        diarization_enabled: request.diarize,
        ...(request.language && request.language !== 'auto' ? { language_hints: [request.language] } : {}),
      },
    }),
  });
  const taskId = asRecord(body.output)?.task_id;
  if (typeof taskId !== 'string' || !taskId) throw new Error('DashScope did not return a task id');
  return taskId;
}

interface DashscopeSentence {
  begin_time: number;
  end_time: number;
  text: string;
  speaker_id?: number | string;
  words?: Array<{ begin_time: number; end_time: number; text: string }>;
}

async function pollTask(
  options: TranscriptionOptions,
  taskId: string,
  deps: Required<Pick<DashscopeDeps, 'fetchFn' | 'now' | 'sleep'>>,
): Promise<string> {
  const deadline = deps.now() + POLL_DEADLINE_MS;
  for (;;) {
    // No X-DashScope-Async here: the QwenAI-platform gateway rejects task
    // queries carrying it, and Bailian accepts its absence.
    const body = await dashscopeFetch(deps.fetchFn, `${baseUrlOf(options)}/tasks/${taskId}`, options.dashscopeApiKey);
    const output = asRecord(body.output);
    const status = output?.task_status;
    if (status === 'SUCCEEDED') {
      const results = Array.isArray(output?.results) ? output.results : [];
      const first = asRecord(results[0]);
      const transcriptionUrl = first?.transcription_url;
      if (typeof transcriptionUrl !== 'string' || !transcriptionUrl) {
        throw new Error('DashScope task succeeded without a transcription_url');
      }
      return transcriptionUrl;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const code = typeof output?.code === 'string' ? output.code : '';
      const message = typeof output?.message === 'string' ? output.message : `task ${String(status).toLowerCase()}`;
      throw new Error(`DashScope transcription failed${code ? ` (${code})` : ''}: ${message}`);
    }
    if (deps.now() > deadline) throw new Error('DashScope transcription timed out');
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

function normalizeSentences(sentences: DashscopeSentence[]): NormalizedTranscriptResult {
  const words: NormalizedTranscriptWord[] = [];
  const utterances: NormalizedTranscriptUtterance[] = [];
  const texts: string[] = [];
  for (const sentence of sentences) {
    const speaker = sentence.speaker_id == null ? null : String(sentence.speaker_id);
    const sentenceWords: NormalizedTranscriptWord[] = (sentence.words ?? [])
      .filter((w) => typeof w.text === 'string' && w.text.length > 0
        && Number.isFinite(w.begin_time) && Number.isFinite(w.end_time))
      .map((w) => ({ text: w.text, start: w.begin_time, end: Math.max(w.begin_time, w.end_time), speaker }));
    // Sentences without word detail still contribute one synthetic word so
    // word-level tooling never sees a gap.
    if (!sentenceWords.length && sentence.text) {
      sentenceWords.push({ text: sentence.text, start: sentence.begin_time, end: sentence.end_time, speaker });
    }
    words.push(...sentenceWords);
    if (sentence.text) {
      texts.push(sentence.text);
      utterances.push({
        speaker: speaker ?? '',
        text: sentence.text,
        start: sentence.begin_time,
        end: sentence.end_time,
        words: sentenceWords,
      });
    }
  }
  return { text: texts.join('\n'), words, utterances };
}

async function fetchTranscription(
  transcriptionUrl: string,
  fetchFn: typeof fetch,
): Promise<NormalizedTranscriptResult> {
  const response = await fetchFn(transcriptionUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`DashScope transcription download failed: HTTP ${response.status}`);
  const body = asRecord(await response.json());
  const transcripts = Array.isArray(body?.transcripts) ? body.transcripts : [];
  const sentences = transcripts.flatMap((transcript) => {
    const list = asRecord(transcript)?.sentences;
    return Array.isArray(list) ? list as DashscopeSentence[] : [];
  });
  if (!sentences.length) throw new Error('DashScope returned an empty transcription');
  return normalizeSentences(sentences);
}

export async function transcribeDashscopeAudio(
  options: TranscriptionOptions,
  request: CloudTranscriptionRequest,
  deps: DashscopeDeps = {},
): Promise<NormalizedTranscriptResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stageR2 = deps.stageR2 ?? defaultStageR2;

  const staged = await stageR2(request.audio, sniffExtension(request.audio));
  if (!staged) {
    throw new TranscriptionConfigurationError(
      'Qwen ASR stages audio through Cloudflare R2 (the DashScope filetrans API only accepts a fetchable URL). '
      + 'Configure R2 in Settings → Storage first.',
    );
  }
  try {
    const taskId = await submitTask(options, staged.url, request, fetchFn);
    const transcriptionUrl = await pollTask(options, taskId, { fetchFn, now, sleep });
    return await fetchTranscription(transcriptionUrl, fetchFn);
  } finally {
    await staged.cleanup();
  }
}
