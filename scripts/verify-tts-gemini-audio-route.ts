// Execute the actual route and provider helper. Only I/O is replaced; never calls a provider.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { fetch as UndiciFetch } from 'undici';
import * as provider from '../src/lib/gemini-tts-provider.server';
import * as timing from '../src/lib/tts-timing';
import * as internal from '../src/lib/internal-ai-access';
import { finalizeTtsPcm } from '../src/lib/pcm-tail-fade';
import { pcmSamples, RATE, wav } from './fixtures/gemini-audio';

delete process.env.INTERNAL_AI_ALLOWED_EMAILS;
delete process.env.INTERNAL_AI_ALLOWED_DOMAINS;
const files = new Map<string, Buffer>();
let email = 'synthetic@aoacademy.co';
let mode = 'preview';
let calls: Array<{ model: string; text: string; pcm: Buffer; rate: number }> = [];
let settled = 0;
let now = Date.now();
const fs = {
  mkdirSync: () => {}, existsSync: (p: string) => files.has(p),
  statSync: (p: string) => ({ size: files.get(p)!.length }),
  writeFileSync: (p: string, bytes: Buffer) => { files.set(p, Buffer.from(bytes)); },
  unlinkSync: (p: string) => { files.delete(p); },
};
const fakeFetch = (async (url: string, options: { body: string }) => {
  const text = JSON.parse(options.body).contents[0].parts[0].text as string;
  const model = url.split('/models/')[1].split(':')[0];
  const index = calls.length;
  const samples = mode === 'guard' && index === 0 ? 2400
    : mode === 'preview' ? 32400 : Math.round(text.replace(/\s+/g, '').length / 14 * RATE) + 7;
  const pcm = pcmSamples(samples);
  const rate = mode === 'rate-fallback' && index === 1 ? 16000 : RATE;
  calls.push({ model, text, pcm, rate });
  const bytes = mode === 'fallback' && index === 1 ? Buffer.from('RIFF')
    : model === 'gemini-2.5-flash-preview-tts' ? pcm : wav(pcm, rate);
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: {
    mimeType: model === 'gemini-2.5-flash-preview-tts' ? `audio/L16;rate=${rate}` : 'audio/wav',
    data: bytes.toString('base64'),
  } }] } }] }) };
}) as unknown as typeof UndiciFetch;

async function main() {
  const filename = 'src/app/api/videos/tts-gemini/route.ts';
  const mocks: Record<string, Record<string, unknown>> = {
    'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    fs: { default: fs },
    child_process: { execFile: (_cmd: unknown, _args: unknown, _opts: unknown, callback: (err: null, out: string, errout: string) => void) => callback(null, '', '') },
    '@/lib/ffmpeg-path': { getFfmpegPath: () => 'inert-ffmpeg' },
    '@/lib/clerk-auth': { getCurrentUser: async () => ({ id: 'synthetic-user' }) },
    '@/lib/prisma': { prisma: { user: { findUnique: async () => ({ email, plan: 'PRO' }) } } },
    '@/lib/api-error': { apiError: ({ error }: { error: unknown }) => { throw error; } },
    '@/lib/gemini-key': { resolveGeminiKey: () => ({ key: 'synthetic', mode: 'byok' }), KeyRequiredError: class extends Error {} },
    '@/lib/minute-limits': { checkMinuteQuota: async () => ({ allowed: true }), reserveMinutes: () => { throw new Error('BYOK should not reserve minutes'); } },
    '@/lib/ai-spend-limits': {
      reserveAiAudioMinutes: async () => ({ allowed: true }), refundAiAudioMinutes: async () => {},
      reconcileAiAudioMinutes: async (_id: string, _reserved: number, actual: number) => { settled = actual; },
      estimateTtsAudioMinutes: () => 1,
    },
    '@/lib/mcp/video-job-funding': { walletFundingForCurrentRequest: () => { throw new Error('BYOK should not use wallet'); } },
    '@/lib/telemetry': { recordTelemetryEvent: async () => {} },
    '@/lib/internal-ai-access': { isInternalAiBetaEnabledFor: internal.isInternalAiBetaEnabledFor },
    '@/lib/gemini-tts-provider.server': { ...provider, callGeminiTts: (...args: Parameters<typeof provider.callGeminiTts>) => {
      args[5] = { fetch: fakeFetch, sleep: async () => { throw new Error('Unexpected provider retry'); } };
      return provider.callGeminiTts(...args);
    } },
  };
  const real = new Set(['gemini-voices', 'tts-minute-admission', 'gemini-errors', 'gemini-voice-styles', 'pcm-tail-fade', 'tts-timing', 'thai-loanwords', 'thai-compounds', 'voice-preview-cache']);
  const bundle = await build({ entryPoints: [filename], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', plugins: [{ name: 'inert-io', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path: specifier }) => {
      if (specifier in mocks) return { path: specifier, namespace: 'fixture' };
      if (specifier.startsWith('@/lib/')) {
        assert.ok(real.has(specifier.slice(6)), `Unexpected dependency: ${specifier}`);
        return { path: path.resolve('src/lib', specifier.slice(6) + '.ts') };
      }
    });
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: specifier }) => ({ contents: Object.keys(mocks[specifier]).map(name => name === 'default'
      ? `export default fixtures[${JSON.stringify(specifier)}].default;`
      : `export const ${name} = fixtures[${JSON.stringify(specifier)}][${JSON.stringify(name)}];`).join('\n') }));
  } }] });
  const subject = { exports: {} as { POST: (req: Request) => Promise<Response> } };
  vm.runInNewContext(bundle.outputFiles[0].text, { module: subject, exports: subject.exports, require: createRequire(path.resolve(filename)), fixtures: mocks,
    process: { env: {}, cwd: () => '/synthetic' }, Buffer, console, Date: class extends Date { static now() { return now++; } },
  });
  const request = async (text: string, preview = false, style = 'neutral') => {
    const res = await subject.exports.POST(new Request('http://fixture/tts', { method: 'POST', body: JSON.stringify({ text, preview, style, voiceName: 'Puck' }) }));
    assert.equal(res.status, 200);
    return res.json();
  };
  const checkOutput = (body: { voiceUrl: string; audioDurationMs: number }, expected: Buffer, rate = RATE) => {
    const bytes = files.get('/synthetic/public/renders/' + body.voiceUrl.split('/').at(-1))!;
    assert.ok(bytes);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt32LE(24), rate);
    assert.equal(bytes.readUInt32LE(40), expected.length);
    assert.deepEqual(bytes.subarray(44), expected, 'written WAV contains only final decoded samples, no nested headers/C2PA');
    assert.ok(Math.abs(body.audioDurationMs - timing.pcmDurationMs(expected.length, rate)) <= 1, 'reported duration matches final sample count');
    assert.ok(Math.abs(settled * 60000 - body.audioDurationMs) <= 1, 'settlement uses final duration');
  };
  // Seed the old key through the same hash algorithm; the real route must bypass it.
  const crypto = await import('node:crypto');
  const text = 'synthetic preview';
  const hash = crypto.createHash('sha256').update(['gemini', 'synthetic-user', 'Puck', text, 'v2'].join('\n')).digest('hex').slice(0, 24);
  const oldPath = `/synthetic/public/renders/voice-preview-gemini-${hash}.wav`;
  files.set(oldPath, Buffer.from('old malformed audio'));
  const preview = await request(text, true);
  assert.equal(preview.cached, false, 'v2 cannot serve from the new route');
  assert.equal(calls[0].model, provider.GEMINI_TTS_38_MODEL);
  checkOutput(preview, finalizeTtsPcm(calls[0].pcm, RATE));
  const cacheHit = await request(text, true);
  assert.equal(cacheHit.cached, true);
  assert.equal(calls.length, 1);
  assert.equal(files.get(oldPath)!.toString(), 'old malformed audio', 'no existing media deleted');
  calls = [];
  const styled = await request('synthetic style', true, 'warm');
  assert.equal(calls[0].model, 'gemini-2.5-flash-preview-tts');
  assert.match(calls[0].text, /^Speak warmly/);
  checkOutput(styled, finalizeTtsPcm(calls[0].pcm, RATE));
  calls = []; email = 'synthetic@example.invalid';
  const external = await request('synthetic external', true, 'warm');
  assert.equal(calls[0].model, 'gemini-2.5-flash-preview-tts');
  assert.equal(calls[0].text, 'synthetic external', 'public style remains ignored');
  checkOutput(external, finalizeTtsPcm(calls[0].pcm, RATE));
  email = 'synthetic@aoacademy.co';
  for (mode of ['single', 'segmented', 'guard', 'fallback', 'rate-fallback']) {
    calls = [];
    const script = mode === 'single' ? 'short synthetic script' : 'word '.repeat(400).trim();
    const chunks = timing.splitScriptForTts(script);
    const body = await request(script);
    let kept = calls.slice(0, chunks.length);
    if (mode === 'fallback' || mode === 'rate-fallback') {
      assert.equal(calls.length, 3, 'broken second segment triggers single-call fallback');
      assert.equal(body.timing, undefined, 'fallback remains available without subtitle gate');
      kept = calls.slice(-1);
    } else {
      if (mode === 'guard') {
        assert.equal(calls.length, chunks.length + 1, 'short first segment is retried once');
        kept[0] = calls.at(-1)!;
      } else assert.equal(calls.length, chunks.length);
      let boundary = 0;
      let byteCount = 0;
      for (let i = 0; i < kept.length; i++) {
        assert.equal(body.timing.segments[i].startMs, boundary);
        byteCount += kept[i].pcm.length;
        const ms = Math.round(timing.pcmDurationMs(byteCount, RATE)) - boundary;
        assert.equal(body.timing.segments[i].durationMs, ms);
        boundary += ms;
      }
      assert.equal(body.audioDurationMs, boundary);
    }
    checkOutput(body, Buffer.concat(kept.map(c => finalizeTtsPcm(c.pcm, c.rate))));
  }
  console.log('PASS real Gemini route: v2 bypass/cache hit, internal/styled/public routing, preview/single/segments/guard/fallback WAV bytes and timing');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
