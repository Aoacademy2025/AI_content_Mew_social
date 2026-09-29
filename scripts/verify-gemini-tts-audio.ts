import assert from 'node:assert/strict';
import type { fetch as UndiciFetch } from 'undici';
import { callGeminiTts } from '../src/lib/gemini-tts-provider.server';
import { chunk, fmt, pcmSamples, RATE, riff, wav } from './fixtures/gemini-audio';

async function call(bytes: Buffer, mimeType = 'audio/wav', model = 'gemini-3.8-flash-tts') {
  let calls = 0;
  const result = await callGeminiTts('synthetic-key', 'synthetic fixture', 'Puck', model, undefined, {
    fetch: (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: {
        parts: [{ inlineData: { mimeType, data: bytes.toString('base64') } }],
      } }] }) };
    }) as unknown as typeof UndiciFetch,
    sleep: async () => { throw new Error('Malformed audio must not trigger paid retries'); },
  });
  assert.equal(calls, 1);
  return result;
}
async function main() {
  const pcm = pcmSamples();
  const raw = await call(pcm, 'audio/L16;codec=pcm;rate=24000', 'gemini-2.5-flash-preview-tts');
  assert.ok(raw.ok);
  assert.deepEqual(raw.pcm, pcm, 'legacy L16 samples stay byte-identical');
  assert.equal(raw.sampleRate, RATE);
  const decoded = await call(wav(pcm));
  assert.ok(decoded.ok);
  assert.equal(decoded.pcm.length, pcm.length, 'WAV/C2PA container bytes must never become audio samples');
  assert.deepEqual(decoded.pcm, pcm);
  assert.equal(decoded.sampleRate, RATE);
  assert.equal(decoded.model, 'gemini-3.8-flash-tts');
  for (const [bytes, mimeType, rate] of [
    [riff([chunk('fmt ', fmt(16000)), chunk('data', pcm)]), 'audio/x-wav;rate=24000', 16000],
    [wav(pcm), 'audio/L16;rate=24000', RATE],
    [riff([chunk('data', pcm), chunk('fmt ', fmt())]), 'audio/wave', RATE],
    [pcm, 'audio/L16; rate=16000; channels=1', 16000],
  ] as const) {
    const r = await call(bytes, mimeType);
    assert.ok(r.ok);
    assert.deepEqual(r.pcm, pcm);
    assert.equal(r.sampleRate, rate, 'WAV fmt is authoritative over MIME');
  }
  const standard = riff([chunk('fmt ', fmt()), chunk('data', pcm)]);
  const badFmt = (offset: number, value: number, width = 2) => {
    const format = fmt();
    if (width === 4) format.writeUInt32LE(value, offset); else format.writeUInt16LE(value, offset);
    return riff([chunk('fmt ', format), chunk('data', pcm)]);
  };
  const tooBig = Buffer.from(standard); tooBig.writeUInt32LE(0xffffffff, 40);
  const shortRiff = Buffer.from(standard); shortRiff.writeUInt32LE(4, 4);
  const invalid: Array<[string, Buffer, string?]> = [
    ['truncated header', Buffer.from('RIFF')],
    ['truncated body', standard.subarray(0, -1)],
    ['oversized chunk', tooBig],
    ['RIFF length mismatch', shortRiff],
    ['non-WAVE RIFF', Buffer.from('RIFF\x04\0\0\0AVI ')],
    ['missing fmt', riff([chunk('data', pcm)])],
    ['missing data', riff([chunk('fmt ', fmt())])],
    ['short fmt', riff([chunk('fmt ', Buffer.alloc(14)), chunk('data', pcm)])],
    ['duplicate fmt', riff([chunk('fmt ', fmt()), chunk('fmt ', fmt()), chunk('data', pcm)])],
    ['duplicate data', riff([chunk('fmt ', fmt()), chunk('data', pcm), chunk('data', pcm)])],
    ['empty samples', riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(0))])],
    ['odd PCM', riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(3))])],
    ['float', badFmt(0, 3)], ['stereo', badFmt(2, 2)], ['8-bit', badFmt(14, 8)],
    ['bad alignment', badFmt(12, 4)], ['zero rate', badFmt(4, 0, 4)],
    ['bad byte rate', badFmt(8, 100, 4)], ['unbounded rate', badFmt(4, 0xffffffff, 4)],
    ['truncated chunk header', riff([chunk('fmt ', fmt()), chunk('data', pcm), Buffer.from('JUNK')])],
    ['missing odd padding', riff([chunk('fmt ', fmt()), chunk('data', pcm), chunk('JUNK', Buffer.from([1])).subarray(0, -1)])],
    ['raw mislabeled as WAV', pcm], ['odd L16', Buffer.alloc(3), 'audio/L16;rate=24000'],
    ['invalid L16 rate', pcm, 'audio/L16;rate=0'], ['stereo L16', pcm, 'audio/L16;rate=24000;channels=2'],
    ['unsupported media', pcm, 'audio/mpeg'], ['unsupported RIFF variant', Buffer.from('RIFXabcdefgh'), 'audio/L16'],
  ];
  for (const [name, bytes, mime] of invalid) {
    const r = await call(bytes, mime);
    assert.equal(r.ok, false, `${name}: invalid media must fail safely`);
    if (!r.ok) assert.equal(r.status, 502, name);
  }
  console.log(`PASS Gemini helper: raw L16, WAV/C2PA, header variants, ${invalid.length} malformed/unsupported cases`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
