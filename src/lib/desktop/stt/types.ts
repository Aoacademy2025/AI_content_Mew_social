export type DesktopSttWord = { w: string; start: number; end: number };
export type DesktopSttSegment = { text: string; start: number; end: number };

export type DesktopSttResult = {
  words: DesktopSttWord[];
  segments: DesktopSttSegment[];
  language: string;
  provider: string;
};

export type DesktopSttOptions = {
  language: string;
  mimeType?: string;
  durationSec?: number;
};

export interface DesktopSttProvider {
  readonly name: string;
  transcribe(buffer: Buffer, options: DesktopSttOptions): Promise<DesktopSttResult>;
}
