// DashScope (Qwen ASR) file transcription. Unlike every other cloud provider,
// the async filetrans API only accepts a URL — audio bytes must be staged first:
//   1. DashScope getPolicy temp upload (dashscope-instant OSS bucket, zero extra
//      config, works on the Bailian endpoint dashscope.aliyuncs.com)
//   2. Cloudflare R2 presigned GET (reuses the project's existing R2 store; the
//      only working path on the QwenAI-platform endpoint maas.qianwenaiapi.com,
//      which rejects oss:// URLs with REQUEST_INVALID_FILE_URL_VALUE)
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

const BAILIAN_HOST_SUFFIX = '.aliyuncs.com';
const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PRESIGN_EXPIRES_SECONDS = 3600;

export class DashscopeUploadError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
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
  deps: Required<Pick<DashscopeDeps, 'fetchFn'>>,
  url: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await deps.fetchFn(url, {
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

/** getPolicy temp upload → oss:// URL (Bailian endpoint only; zero extra config). */
async function stageViaDashscopeUpload(
  options: TranscriptionOptions,
  audio: Uint8Array,
  deps: Required<Pick<DashscopeDeps, 'fetchFn'>>,
): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const base = baseUrlOf(options);
  const model = options.dashscopeModel;
  let policy: Record<string, unknown>;
  try {
    const body = await dashscopeFetch(deps, `${base}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, options.dashscopeApiKey);
    policy = asRecord(body.data) ?? body;
  } catch (error) {
    throw new DashscopeUploadError(`DashScope temp upload policy unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const uploadHost = typeof policy.upload_host === 'string' ? policy.upload_host : '';
  const uploadDir = typeof policy.upload_dir === 'string' ? policy.upload_dir : '';
  if (!uploadHost || !uploadDir || typeof policy.policy !== 'string' || typeof policy.signature !== 'string'
    || typeof policy.oss_access_key_id !== 'string') {
    throw new DashscopeUploadError('DashScope temp upload policy is incomplete');
  }
  const key = `${uploadDir}/${randomUUID()}.${sniffExtension(audio)}`;
  const form = new FormData();
  form.set('key', key);
  form.set('policy', policy.policy);
  form.set('OSSAccessKeyId', policy.oss_access_key_id);
  form.set('Signature', policy.signature);
  form.set('success_action_status', '200');
  form.set('x-oss-object-acl', typeof policy.x_oss_object_acl === 'string' ? policy.x_oss_object_acl : 'private');
  form.set('x-oss-forbid-overwrite', typeof policy.x_oss_forbid_overwrite === 'string' ? policy.x_oss_forbid_overwrite : 'true');
  form.set('file', new Blob([audio as unknown as BlobPart]), `audio.${sniffExtension(audio)}`);
  const response = await deps.fetchFn(uploadHost, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    throw new DashscopeUploadError(`DashScope temp upload failed: HTTP ${response.status}`);
  }
  // The instant bucket expires objects on its own (~48h); nothing to clean up.
  return { url: `oss://${key}`, cleanup: async () => {} };
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
  deps: Required<Pick<DashscopeDeps, 'fetchFn'>>,
): Promise<string> {
  const body = await dashscopeFetch(deps, `${baseUrlOf(options)}/services/audio/asr/transcription`, options.dashscopeApiKey, {
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
    const body = await dashscopeFetch(deps, `${baseUrlOf(options)}/tasks/${taskId}`, options.dashscopeApiKey);
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
      // oss:// URLs are rejected by the QwenAI-platform endpoint — the caller
      // may retry with the R2 strategy.
      if (code === 'REQUEST_INVALID_FILE_URL_VALUE') throw new DashscopeUploadError(`DashScope rejected the staged file URL (${code})`);
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
  deps: Required<Pick<DashscopeDeps, 'fetchFn'>>,
): Promise<NormalizedTranscriptResult> {
  const response = await deps.fetchFn(transcriptionUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
  const resolved = {
    fetchFn: deps.fetchFn ?? fetch,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    stageR2: deps.stageR2 ?? defaultStageR2,
  };
  const ext = sniffExtension(request.audio);
  const preferDashscopeUpload = hostOf(baseUrlOf(options)).endsWith(BAILIAN_HOST_SUFFIX);
  const strategies = preferDashscopeUpload ? ['dashscope', 'r2'] as const : ['r2', 'dashscope'] as const;
  let lastError: Error | null = null;
  for (const strategy of strategies) {
    let staged: { url: string; cleanup: () => Promise<void> } | null = null;
    try {
      staged = strategy === 'dashscope'
        ? await stageViaDashscopeUpload(options, request.audio, resolved)
        : await resolved.stageR2(request.audio, ext);
      if (!staged) continue; // R2 not configured — try the next strategy
      const taskId = await submitTask(options, staged.url, request, resolved);
      const transcriptionUrl = await pollTask(options, taskId, resolved);
      return await fetchTranscription(transcriptionUrl, resolved);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError instanceof TranscriptionConfigurationError) throw lastError;
      if (!(lastError instanceof DashscopeUploadError) || !lastError.retryable) throw lastError;
      // Retryable staging failure — fall through to the next strategy.
    } finally {
      await staged?.cleanup();
    }
  }
  throw new TranscriptionConfigurationError(
    `Qwen ASR requires a reachable file URL but no staging worked (${lastError?.message ?? 'no strategy available'}). `
    + 'Use the Bailian endpoint (https://dashscope.aliyuncs.com/api/v1) for zero-config temp uploads, '
    + 'or configure Cloudflare R2 in Settings so audio can be staged via a presigned URL.',
  );
}
