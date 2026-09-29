// Synthetic audio only. No provider calls or captured user media.
export const RATE = 24000;
export function pcmSamples(samples = 4800): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(15000 * Math.sin(i / 10)), i * 2);
  return pcm;
}
export function chunk(id: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(id);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
}
export function fmt(rate = RATE, extraBytes = 0): Buffer {
  const body = Buffer.alloc(16 + extraBytes);
  body.writeUInt16LE(1, 0);
  body.writeUInt16LE(1, 2);
  body.writeUInt32LE(rate, 4);
  body.writeUInt32LE(rate * 2, 8);
  body.writeUInt16LE(2, 12);
  body.writeUInt16LE(16, 14);
  return body;
}
export function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
export function wav(pcm: Buffer, rate = RATE): Buffer {
  return riff([
    chunk('JUNK', Buffer.from([1, 2, 3])),
    chunk('fmt ', fmt(rate, 2)),
    chunk('LIST', Buffer.from('synthetic metadata')),
    chunk('data', pcm),
    chunk('C2PA', Buffer.alloc(6012, 0x7f)),
  ]);
}
