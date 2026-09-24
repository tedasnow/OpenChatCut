import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-keystore-default-'));
const checkout = join(fixture, 'checkout');
const envPath = join(checkout, '.env.local');
const previousCwd = process.cwd();
const previousProfile = process.env.OPENCHATCUT_DEV_PROFILE_ID;

try {
  await mkdir(checkout, { recursive: true });
  await writeFile(envPath, 'OPENAI_API_KEY=old\n', { mode: 0o644 });
  process.chdir(checkout);
  delete process.env.OPENCHATCUT_DEV_PROFILE_ID;
  const { setKeys } = await import('./keystore.ts');
  await setKeys({ OPENAI_API_KEY: 'new-secret' });
  if (process.platform !== 'win32') assert.equal((await stat(envPath)).mode & 0o777, 0o600);

  // A no-op save must not rewrite the file: the default profile's ENV_PATH is
  // the checkout's .env.local, which Vite watches — a content-identical write
  // still bumps mtime and restarts the dev server (initXaiOauth's startup
  // clear would loop that restart forever).
  const fixed = new Date('2001-02-03T04:05:06.789Z');
  await utimes(envPath, fixed, fixed);
  await setKeys({ OPENAI_API_KEY: 'new-secret' });
  assert.equal((await stat(envPath)).mtimeMs, fixed.getTime(), 'no-op setKeys must not rewrite .env.local');
  await setKeys({ LLM_XAI_OAUTH_API_KEY: '' }); // clearing an absent key is also a no-op
  assert.equal((await stat(envPath)).mtimeMs, fixed.getTime(), 'clearing an unset key must not rewrite .env.local');
} finally {
  process.chdir(previousCwd);
  if (previousProfile === undefined) delete process.env.OPENCHATCUT_DEV_PROFILE_ID;
  else process.env.OPENCHATCUT_DEV_PROFILE_ID = previousProfile;
  await rm(fixture, { recursive: true, force: true });
}
