import { normalizeWavAudioBase64 } from './audioNormalization';

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(new ArrayBuffer(len));
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64WavToObjectUrl(base64: string): string {
  const bytes = base64ToUint8Array(base64);
  const blob = new Blob([bytes], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

interface ParsedWav {
  audioFormat: number;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  pcmData: Uint8Array;
}

function parseWavBuffer(bytes: Uint8Array): ParsedWav | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Verify RIFF and WAVE headers
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    return null;
  }

  let audioFormat = 1;
  let sampleRate = 24000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let pcmData: Uint8Array | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;

    if (chunkId === 'fmt ' && dataStart + 16 <= bytes.length) {
      audioFormat = view.getUint16(dataStart, true);
      numChannels = view.getUint16(dataStart + 2, true);
      sampleRate = view.getUint32(dataStart + 4, true);
      bitsPerSample = view.getUint16(dataStart + 14, true);
    } else if (chunkId === 'data') {
      const end = Math.min(bytes.length, dataStart + chunkSize);
      pcmData = bytes.subarray(dataStart, end);
      break;
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  if (!pcmData) return null;
  return { audioFormat, sampleRate, numChannels, bitsPerSample, pcmData };
}

/**
 * Stitches multiple Gemini unary WAV clips (24kHz mono 16-bit PCM) into a single
 * clean downloadable WAV file with subtle 350ms silence breath between chapters.
 */
export function stitchWavBase64Clips(
  base64Clips: string[],
  options?: { normalizeTargetLufs?: number | null }
): Blob | null {
  const parsedClips: ParsedWav[] = [];
  const targetLufs = options?.normalizeTargetLufs;
  for (const clip of base64Clips) {
    const processedClip =
      typeof targetLufs === 'number' && Number.isFinite(targetLufs)
        ? normalizeWavAudioBase64(clip, { targetLufs }).audioBase64
        : clip;
    const bytes = base64ToUint8Array(processedClip);
    const parsed = parseWavBuffer(bytes);
    if (parsed) {
      parsedClips.push(parsed);
    }
  }

  if (parsedClips.length === 0) return null;

  const { sampleRate, numChannels, bitsPerSample } = parsedClips[0];
  const bytesPerSample = bitsPerSample / 8;
  const pauseBytes = Math.floor(sampleRate * 0.35) * numChannels * bytesPerSample;

  let totalPcmBytes = 0;
  parsedClips.forEach((clip, idx) => {
    totalPcmBytes += clip.pcmData.byteLength;
    if (idx < parsedClips.length - 1) {
      totalPcmBytes += pauseBytes;
    }
  });

  const output = new Uint8Array(44 + totalPcmBytes);
  const view = new DataView(output.buffer);

  // RIFF header
  output.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + totalPcmBytes, true);
  output.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt subchunk
  output.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
  view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  output.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, totalPcmBytes, true);

  let writeOffset = 44;
  parsedClips.forEach((clip, idx) => {
    output.set(clip.pcmData, writeOffset);
    writeOffset += clip.pcmData.byteLength;
    if (idx < parsedClips.length - 1) {
      // Zero bytes already represent silence
      writeOffset += pauseBytes;
    }
  });

  return new Blob([output], { type: 'audio/wav' });
}

export function getWavDurationSeconds(base64: string): number {
  const bytes = base64ToUint8Array(base64);
  const parsed = parseWavBuffer(bytes);
  if (!parsed) return 0;
  const byteRate = parsed.sampleRate * parsed.numChannels * (parsed.bitsPerSample / 8);
  if (byteRate <= 0) return 0;
  return parsed.pcmData.byteLength / byteRate;
}

const WAVEFORM_CACHE_LIMIT = 24;
const waveformPeaksCache = new Map<string, Float32Array>();

function stripBase64DataUrlPrefix(raw: string): string {
  const trimmed = raw.trim();
  const commaIdx = trimmed.indexOf(',');
  if (trimmed.startsWith('data:') && commaIdx !== -1) {
    return trimmed.slice(commaIdx + 1);
  }
  return trimmed;
}

function getWaveformCacheKey(cleanBase64: string, bucketCount: number): string {
  const head = cleanBase64.slice(0, 32);
  const tail = cleanBase64.slice(-32);
  return `${cleanBase64.length}:${head}:${tail}:${bucketCount}`;
}

function rememberWaveformPeaks(key: string, peaks: Float32Array): void {
  if (waveformPeaksCache.has(key)) {
    waveformPeaksCache.delete(key);
  } else if (waveformPeaksCache.size >= WAVEFORM_CACHE_LIMIT) {
    const oldestKey = waveformPeaksCache.keys().next().value;
    if (oldestKey !== undefined) {
      waveformPeaksCache.delete(oldestKey);
    }
  }
  waveformPeaksCache.set(key, peaks);
}

function normalizeAmplitudeBuckets(rawBuckets: Float32Array): Float32Array {
  const count = rawBuckets.length;
  if (count === 0) return rawBuckets;

  // Use 96th-percentile scaling so isolated plosives don't squash speech phrasing
  const sorted = Float32Array.from(rawBuckets).sort();
  const refIdx = Math.min(count - 1, Math.floor(count * 0.96));
  const referencePeak = Math.max(sorted[refIdx], sorted[count - 1] * 0.65, 1e-4);

  const normalized = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const ratio = Math.min(1, rawBuckets[i] / referencePeak);
    // Gentle perceptual curve so quiet narration remains legible
    normalized[i] = ratio > 0.004 ? Math.pow(ratio, 0.78) : 0;
  }
  return normalized;
}

function readPcmSampleNormalized(
  view: DataView,
  byteOffset: number,
  bitsPerSample: number,
  audioFormat: number
): number {
  if (bitsPerSample === 16) {
    return view.getInt16(byteOffset, true) / 32768;
  }
  if (bitsPerSample === 8) {
    return (view.getUint8(byteOffset) - 128) / 128;
  }
  if (bitsPerSample === 24) {
    const b0 = view.getUint8(byteOffset);
    const b1 = view.getUint8(byteOffset + 1);
    const b2 = view.getUint8(byteOffset + 2);
    let val = b0 | (b1 << 8) | (b2 << 16);
    if (val & 0x800000) val |= ~0xffffff;
    return val / 8388608;
  }
  if (bitsPerSample === 32) {
    if (audioFormat === 3) {
      return Math.max(-1, Math.min(1, view.getFloat32(byteOffset, true)));
    }
    return view.getInt32(byteOffset, true) / 2147483648;
  }
  return 0;
}

/**
 * Synchronously extracts a normalized amplitude envelope (blended RMS + peak)
 * directly from a WAV `audioBase64` string, cached with an LRU cap.
 */
export function extractWavWaveformPeaks(
  base64: string | undefined,
  bucketCount = 160
): Float32Array | null {
  if (!base64 || base64 === 'hosted' || base64.length < 64) {
    return null;
  }

  const clean = stripBase64DataUrlPrefix(base64);
  if (clean.length < 64) return null;

  const cacheKey = getWaveformCacheKey(clean, bucketCount);
  const cached = waveformPeaksCache.get(cacheKey);
  if (cached) {
    // Refresh LRU recency
    waveformPeaksCache.delete(cacheKey);
    waveformPeaksCache.set(cacheKey, cached);
    return cached;
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToUint8Array(clean);
  } catch {
    return null;
  }

  const parsed = parseWavBuffer(bytes);
  if (!parsed) return null;

  const { audioFormat, numChannels, bitsPerSample, pcmData } = parsed;
  const bytesPerSample = Math.floor(bitsPerSample / 8);
  const frameSize = bytesPerSample * Math.max(1, numChannels);
  if (frameSize <= 0 || pcmData.byteLength < frameSize) return null;

  const totalFrames = Math.floor(pcmData.byteLength / frameSize);
  if (totalFrames <= 0) return null;

  const view = new DataView(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
  const rawBuckets = new Float32Array(bucketCount);
  const framesPerBucket = totalFrames / bucketCount;

  for (let b = 0; b < bucketCount; b++) {
    const startFrame = Math.floor(b * framesPerBucket);
    const endFrame = Math.min(totalFrames, Math.max(startFrame + 1, Math.floor((b + 1) * framesPerBucket)));
    const span = endFrame - startFrame;
    // Subsample very long buckets to keep extraction strictly sub-millisecond
    const stride = Math.max(1, Math.floor(span / 96));

    let sumSq = 0;
    let peak = 0;
    let sampled = 0;

    for (let f = startFrame; f < endFrame; f += stride) {
      let frameAmp = 0;
      const frameOffset = f * frameSize;
      for (let ch = 0; ch < numChannels; ch++) {
        frameAmp += readPcmSampleNormalized(
          view,
          frameOffset + ch * bytesPerSample,
          bitsPerSample,
          audioFormat
        );
      }
      const mono = frameAmp / numChannels;
      const abs = Math.abs(mono);
      if (abs > peak) peak = abs;
      sumSq += mono * mono;
      sampled++;
    }

    const rms = sampled > 0 ? Math.sqrt(sumSq / sampled) : 0;
    // Blend RMS (sustained vocal body) with peak (crisp consonant transients)
    rawBuckets[b] = rms * 0.65 + peak * 0.35;
  }

  const normalized = normalizeAmplitudeBuckets(rawBuckets);
  rememberWaveformPeaks(cacheKey, normalized);
  return normalized;
}

/**
 * Async fallback for non-WAV base64 audio payloads using Web Audio decodeAudioData.
 */
export async function decodeAudioBase64WaveformPeaks(
  base64: string | undefined,
  bucketCount = 160
): Promise<Float32Array | null> {
  if (!base64 || base64 === 'hosted' || base64.length < 64) {
    return null;
  }

  const syncWav = extractWavWaveformPeaks(base64, bucketCount);
  if (syncWav) return syncWav;

  const clean = stripBase64DataUrlPrefix(base64);
  const cacheKey = getWaveformCacheKey(clean, bucketCount);
  const cached = waveformPeaksCache.get(cacheKey);
  if (cached) return cached;

  const AudioCtxCtor =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      : undefined;
  if (!AudioCtxCtor) return null;

  let ctx: AudioContext | null = null;
  try {
    const bytes = base64ToUint8Array(clean);
    ctx = new AudioCtxCtor();
    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const channelData = audioBuffer.getChannelData(0);
    const totalSamples = channelData.length;
    if (totalSamples === 0) return null;

    const rawBuckets = new Float32Array(bucketCount);
    const samplesPerBucket = totalSamples / bucketCount;

    for (let b = 0; b < bucketCount; b++) {
      const start = Math.floor(b * samplesPerBucket);
      const end = Math.min(totalSamples, Math.max(start + 1, Math.floor((b + 1) * samplesPerBucket)));
      const stride = Math.max(1, Math.floor((end - start) / 96));

      let sumSq = 0;
      let peak = 0;
      let sampled = 0;
      for (let i = start; i < end; i += stride) {
        const val = channelData[i];
        const abs = Math.abs(val);
        if (abs > peak) peak = abs;
        sumSq += val * val;
        sampled++;
      }

      const rms = sampled > 0 ? Math.sqrt(sumSq / sampled) : 0;
      rawBuckets[b] = rms * 0.65 + peak * 0.35;
    }

    const normalized = normalizeAmplitudeBuckets(rawBuckets);
    rememberWaveformPeaks(cacheKey, normalized);
    return normalized;
  } catch {
    return null;
  } finally {
    if (ctx) {
      ctx.close().catch(() => {});
    }
  }
}

