export type LoudnessTargetPreset = -16 | -14 | -18;

export interface LoudnessPresetOption {
  targetLufs: LoudnessTargetPreset;
  label: string;
  shortLabel: string;
  description: string;
}

export const DEFAULT_LOUDNESS_TARGET_LUFS: LoudnessTargetPreset = -16;

export const LOUDNESS_PRESETS: LoudnessPresetOption[] = [
  {
    targetLufs: -16,
    label: '-16 LUFS · Podcast Standard',
    shortLabel: '-16 LUFS',
    description: 'Standard spoken-word podcast loudness across chapters',
  },
  {
    targetLufs: -14,
    label: '-14 LUFS · Commute Boost',
    shortLabel: '-14 LUFS',
    description: 'Stronger vocal presence for transit and car playback',
  },
  {
    targetLufs: -18,
    label: '-18 LUFS · Studio Headroom',
    shortLabel: '-18 LUFS',
    description: 'Wider dynamic range for quiet headphone listening',
  },
];

export interface WavLoudnessMetrics {
  inputLufs: number;
  outputLufs: number;
  gainAppliedDb: number;
  peakDbfs: number;
  targetLufs: number;
  normalized: boolean;
}

export interface NormalizeWavOptions {
  targetLufs?: number;
  ceilingDbfs?: number;
  maxGainDb?: number;
  minGainDb?: number;
}

export interface NormalizedWavResult {
  audioBase64: string;
  metrics: WavLoudnessMetrics;
}

interface ParsedPcmWav {
  audioFormat: number;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  pcmData: Uint8Array;
}

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function stripDataUrlPrefix(raw: string): string {
  const trimmed = raw.trim();
  const commaIdx = trimmed.indexOf(',');
  if (trimmed.startsWith('data:') && commaIdx !== -1) {
    return trimmed.slice(commaIdx + 1);
  }
  return trimmed;
}

function decodeBase64Universal(cleanBase64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(cleanBase64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(cleanBase64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64Universal(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      'base64'
    );
  }
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    let chunkStr = '';
    for (let i = 0; i < slice.length; i++) {
      chunkStr += String.fromCharCode(slice[i]);
    }
    parts.push(chunkStr);
  }
  return btoa(parts.join(''));
}

function parseWavContainer(bytes: Uint8Array): ParsedPcmWav | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let audioFormat = 1;
  let sampleRate = 24000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let pcmData: Uint8Array | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;

    if (chunkId === 'fmt ' && dataStart + 16 <= bytes.byteLength) {
      audioFormat = view.getUint16(dataStart, true);
      numChannels = Math.max(1, view.getUint16(dataStart + 2, true));
      sampleRate = Math.max(8000, view.getUint32(dataStart + 4, true));
      bitsPerSample = view.getUint16(dataStart + 14, true);
    } else if (chunkId === 'data') {
      const end = Math.min(bytes.byteLength, dataStart + chunkSize);
      pcmData = bytes.subarray(dataStart, end);
      break;
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  if (!pcmData || pcmData.byteLength === 0) return null;
  if (audioFormat !== 1 && audioFormat !== 3) return null;
  return { audioFormat, sampleRate, numChannels, bitsPerSample, pcmData };
}

function readSampleFloat(
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
      const f = view.getFloat32(byteOffset, true);
      return Number.isFinite(f) ? Math.max(-1, Math.min(1, f)) : 0;
    }
    return view.getInt32(byteOffset, true) / 2147483648;
  }
  return 0;
}

function decodeSamplesInterleaved(parsed: ParsedPcmWav): Float32Array | null {
  const bytesPerSample = Math.floor(parsed.bitsPerSample / 8);
  const frameSize = bytesPerSample * parsed.numChannels;
  if (bytesPerSample <= 0 || frameSize <= 0) return null;

  const totalFrames = Math.floor(parsed.pcmData.byteLength / frameSize);
  if (totalFrames <= 0) return null;

  const view = new DataView(
    parsed.pcmData.buffer,
    parsed.pcmData.byteOffset,
    parsed.pcmData.byteLength
  );
  const samples = new Float32Array(totalFrames * parsed.numChannels);

  let sampleIdx = 0;
  for (let f = 0; f < totalFrames; f++) {
    const frameByteOffset = f * frameSize;
    for (let ch = 0; ch < parsed.numChannels; ch++) {
      samples[sampleIdx++] = readSampleFloat(
        view,
        frameByteOffset + ch * bytesPerSample,
        parsed.bitsPerSample,
        parsed.audioFormat
      );
    }
  }
  return samples;
}

function removeDcOffsetInPlace(samples: Float32Array, numChannels: number): void {
  const totalFrames = Math.floor(samples.length / numChannels);
  if (totalFrames <= 0) return;

  for (let ch = 0; ch < numChannels; ch++) {
    let sum = 0;
    for (let f = 0; f < totalFrames; f++) {
      sum += samples[f * numChannels + ch];
    }
    const mean = sum / totalFrames;
    if (Math.abs(mean) > 1e-6) {
      for (let f = 0; f < totalFrames; f++) {
        samples[f * numChannels + ch] -= mean;
      }
    }
  }
}

/**
 * Sample-rate-adaptive ITU-R BS.1770-4 K-Weighting biquad filter pair:
 * 1) Acoustic head-modeling high-shelf (+4.0 dB above ~1.68 kHz)
 * 2) RLB low-frequency high-pass (~38.1 Hz)
 */
function buildKWeightingFilters(sampleRate: number): [BiquadCoeffs, BiquadCoeffs] {
  const safeSr = Math.max(8000, sampleRate);

  // Stage 1: +4.0 dB high-shelf
  const fcShelf = Math.min(1681.974450955533, safeSr * 0.44);
  const qShelf = 0.7071752369554196;
  const vh = 1.5848931924611136; // 10^(4/20)
  const vb = Math.pow(vh, 0.4996667741545416);
  const kShelf = Math.tan((Math.PI * fcShelf) / safeSr);
  const kShelfSq = kShelf * kShelf;
  const a0Shelf = 1 + kShelf / qShelf + kShelfSq;
  const shelf: BiquadCoeffs = {
    b0: (vh + (vb * kShelf) / qShelf + kShelfSq) / a0Shelf,
    b1: (2 * (kShelfSq - vh)) / a0Shelf,
    b2: (vh - (vb * kShelf) / qShelf + kShelfSq) / a0Shelf,
    a1: (2 * (kShelfSq - 1)) / a0Shelf,
    a2: (1 - kShelf / qShelf + kShelfSq) / a0Shelf,
  };

  // Stage 2: RLB high-pass
  const fcHp = Math.min(38.13547087602444, safeSr * 0.44);
  const qHp = 0.5003270373238773;
  const kHp = Math.tan((Math.PI * fcHp) / safeSr);
  const kHpSq = kHp * kHp;
  const a0Hp = 1 + kHp / qHp + kHpSq;
  const highPass: BiquadCoeffs = {
    b0: 1 / a0Hp,
    b1: -2 / a0Hp,
    b2: 1 / a0Hp,
    a1: (2 * (kHpSq - 1)) / a0Hp,
    a2: (1 - kHp / qHp + kHpSq) / a0Hp,
  };

  return [shelf, highPass];
}

/**
 * Computes ITU-R BS.1770-4 gated integrated speech loudness in LUFS.
 * Speech gating ensures chapters with natural dramatic pauses are matched
 * by spoken voice level rather than silence ratio.
 */
function measureGatedLoudnessAndPeak(
  samples: Float32Array,
  sampleRate: number,
  numChannels: number
): { loudnessLufs: number; peakDbfs: number } {
  const totalFrames = Math.floor(samples.length / numChannels);
  if (totalFrames <= 0) {
    return { loudnessLufs: -70, peakDbfs: -96 };
  }

  const [shelf, hp] = buildKWeightingFilters(sampleRate);
  const kWeightedFrameEnergy = new Float32Array(totalFrames);

  // Per-channel biquad states (Direct Form II Transposed)
  const s1z1 = new Float64Array(numChannels);
  const s1z2 = new Float64Array(numChannels);
  const s2z1 = new Float64Array(numChannels);
  const s2z2 = new Float64Array(numChannels);

  let maxAbsPeak = 0;

  for (let f = 0; f < totalFrames; f++) {
    let frameSumSq = 0;
    const baseIdx = f * numChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const x = samples[baseIdx + ch];
      const absX = Math.abs(x);
      if (absX > maxAbsPeak) maxAbsPeak = absX;

      // Stage 1 biquad
      const y1 = shelf.b0 * x + s1z1[ch];
      s1z1[ch] = shelf.b1 * x - shelf.a1 * y1 + s1z2[ch];
      s1z2[ch] = shelf.b2 * x - shelf.a2 * y1;

      // Stage 2 biquad
      const y2 = hp.b0 * y1 + s2z1[ch];
      s2z1[ch] = hp.b1 * y1 - hp.a1 * y2 + s2z2[ch];
      s2z2[ch] = hp.b2 * y1 - hp.a2 * y2;

      frameSumSq += y2 * y2;
    }
    kWeightedFrameEnergy[f] = frameSumSq / numChannels;
  }

  const peakDbfs =
    maxAbsPeak > 1e-6 ? Math.max(-96, 20 * Math.log10(maxAbsPeak)) : -96;

  // 400 ms momentary loudness windows with 100 ms hop (75% overlap)
  const blockFrames = Math.max(1, Math.round(sampleRate * 0.4));
  const hopFrames = Math.max(1, Math.round(sampleRate * 0.1));

  if (totalFrames < blockFrames) {
    let activeSum = 0;
    let activeCount = 0;
    const gateEnergy = Math.pow(10, (-55 + 0.691) / 10);
    for (let f = 0; f < totalFrames; f++) {
      if (kWeightedFrameEnergy[f] >= gateEnergy) {
        activeSum += kWeightedFrameEnergy[f];
        activeCount++;
      }
    }
    const meanSq =
      activeCount > 0
        ? activeSum / activeCount
        : kWeightedFrameEnergy.reduce((a, b) => a + b, 0) / totalFrames;
    const lufs =
      meanSq > 1e-10 ? Math.max(-70, -0.691 + 10 * Math.log10(meanSq)) : -70;
    return {
      loudnessLufs: Math.round(lufs * 10) / 10,
      peakDbfs: Math.round(peakDbfs * 10) / 10,
    };
  }

  // Prefix sum for O(1) window energy lookup
  const prefixEnergy = new Float64Array(totalFrames + 1);
  for (let f = 0; f < totalFrames; f++) {
    prefixEnergy[f + 1] = prefixEnergy[f] + kWeightedFrameEnergy[f];
  }

  const blockEnergies: number[] = [];
  const absGateEnergy = Math.pow(10, (-70 + 0.691) / 10);

  for (let start = 0; start + blockFrames <= totalFrames; start += hopFrames) {
    const meanEnergy =
      (prefixEnergy[start + blockFrames] - prefixEnergy[start]) / blockFrames;
    if (meanEnergy > absGateEnergy) {
      blockEnergies.push(meanEnergy);
    }
  }

  if (blockEnergies.length === 0) {
    return {
      loudnessLufs: -70,
      peakDbfs: Math.round(peakDbfs * 10) / 10,
    };
  }

  // Absolute-gated average -> Relative gate (-10 LU below ungated speech average)
  const absAvgEnergy =
    blockEnergies.reduce((sum, e) => sum + e, 0) / blockEnergies.length;
  const relGateEnergy = absAvgEnergy * 0.1; // -10 dB in power

  let relSum = 0;
  let relCount = 0;
  for (let i = 0; i < blockEnergies.length; i++) {
    if (blockEnergies[i] >= relGateEnergy) {
      relSum += blockEnergies[i];
      relCount++;
    }
  }

  const finalMeanEnergy = relCount > 0 ? relSum / relCount : absAvgEnergy;
  const loudnessLufs =
    finalMeanEnergy > 1e-10
      ? Math.max(-70, -0.691 + 10 * Math.log10(finalMeanEnergy))
      : -70;

  return {
    loudnessLufs: Math.round(loudnessLufs * 10) / 10,
    peakDbfs: Math.round(peakDbfs * 10) / 10,
  };
}

/**
 * Applies linear gain followed by a transparent 2.5ms-lookahead soft-knee peak
 * limiter so boosted speech chapters never clip on plosives or laughter.
 */
function applyGainAndSoftKneeLimiterInPlace(
  samples: Float32Array,
  sampleRate: number,
  numChannels: number,
  linearGain: number,
  ceilingLinear: number
): void {
  const totalFrames = Math.floor(samples.length / numChannels);
  if (totalFrames <= 0) return;

  // Apply makeup / attenuation gain and compute per-frame peak amplitude
  const framePeaks = new Float32Array(totalFrames);
  let maxPeakAfterGain = 0;

  for (let f = 0; f < totalFrames; f++) {
    let fPeak = 0;
    const baseIdx = f * numChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const amplified = samples[baseIdx + ch] * linearGain;
      samples[baseIdx + ch] = amplified;
      const absVal = Math.abs(amplified);
      if (absVal > fPeak) fPeak = absVal;
    }
    framePeaks[f] = fPeak;
    if (fPeak > maxPeakAfterGain) maxPeakAfterGain = fPeak;
  }

  const kneeStart = ceilingLinear * 0.7943282347; // -2.0 dB below ceiling
  if (maxPeakAfterGain <= kneeStart) {
    return;
  }

  // Compute target gain reduction per frame using a smooth hyperbolic soft knee
  const headroomSpan = Math.max(1e-5, ceilingLinear - kneeStart);
  const targetGain = new Float32Array(totalFrames);
  for (let f = 0; f < totalFrames; f++) {
    const pk = framePeaks[f];
    if (pk <= kneeStart) {
      targetGain[f] = 1.0;
    } else {
      const excess = pk - kneeStart;
      // Smoothly approaches ceilingLinear asymptotically without hard clipping
      const compressed =
        kneeStart + headroomSpan * (excess / (excess + headroomSpan));
      targetGain[f] = Math.min(1.0, compressed / pk);
    }
  }

  // 2.5 ms lookahead minimum filter so fast consonant transients are caught cleanly
  const lookaheadFrames = Math.max(1, Math.round(sampleRate * 0.0025));
  const attackCoeff = Math.exp(-1 / Math.max(1, sampleRate * 0.0015)); // 1.5 ms attack
  const releaseCoeff = Math.exp(-1 / Math.max(1, sampleRate * 0.065)); // 65 ms release

  let envGain = 1.0;
  for (let f = 0; f < totalFrames; f++) {
    let minLookaheadGain = targetGain[f];
    const windowEnd = Math.min(totalFrames, f + lookaheadFrames);
    for (let k = f + 1; k < windowEnd; k++) {
      if (targetGain[k] < minLookaheadGain) {
        minLookaheadGain = targetGain[k];
      }
    }

    if (minLookaheadGain < envGain) {
      envGain = attackCoeff * envGain + (1 - attackCoeff) * minLookaheadGain;
    } else {
      envGain = releaseCoeff * envGain + (1 - releaseCoeff) * minLookaheadGain;
    }

    const baseIdx = f * numChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const limited = samples[baseIdx + ch] * envGain;
      // Final safety clamp at ceilingLinear
      samples[baseIdx + ch] = Math.max(
        -ceilingLinear,
        Math.min(ceilingLinear, limited)
      );
    }
  }
}

function encode16BitPcmWav(
  samples: Float32Array,
  sampleRate: number,
  numChannels: number
): Uint8Array {
  const bytesPerSample = 2;
  const dataByteLength = samples.length * bytesPerSample;
  const output = new Uint8Array(44 + dataByteLength);
  const view = new DataView(output.buffer);

  // RIFF / WAVE header
  output.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataByteLength, true);
  output.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt subchunk
  output.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM = 1
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);

  // data subchunk
  output.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataByteLength, true);

  // Deterministic lightweight LCG for +/- 0.5 LSB TPDF quantization dither
  let rngState = 0x6d2b79f5;
  const nextRandUnit = (): number => {
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
    return rngState / 4294967296;
  };

  let writeOffset = 44;
  for (let i = 0; i < samples.length; i++) {
    const tpdf = (nextRandUnit() - nextRandUnit()) * 0.5;
    const scaled = samples[i] * 32767 + tpdf;
    const clamped = Math.max(-32768, Math.min(32767, Math.round(scaled)));
    view.setInt16(writeOffset, clamped, true);
    writeOffset += 2;
  }

  return output;
}

/**
 * Measures integrated gated loudness (LUFS) and sample peak (dBFS) of a WAV base64 payload
 * without modifying the audio.
 */
export function measureWavLoudnessBase64(
  base64: string,
  targetLufs: number = DEFAULT_LOUDNESS_TARGET_LUFS
): WavLoudnessMetrics | null {
  if (!base64 || base64 === 'hosted' || base64.length < 64) {
    return null;
  }

  try {
    const clean = stripDataUrlPrefix(base64);
    const bytes = decodeBase64Universal(clean);
    const parsed = parseWavContainer(bytes);
    if (!parsed) return null;

    const samples = decodeSamplesInterleaved(parsed);
    if (!samples || samples.length === 0) return null;

    const { loudnessLufs, peakDbfs } = measureGatedLoudnessAndPeak(
      samples,
      parsed.sampleRate,
      parsed.numChannels
    );

    return {
      inputLufs: loudnessLufs,
      outputLufs: loudnessLufs,
      gainAppliedDb: 0,
      peakDbfs,
      targetLufs,
      normalized: Math.abs(loudnessLufs - targetLufs) <= 0.8,
    };
  } catch {
    return null;
  }
}

/**
 * Normalizes a synthesized WAV segment to a consistent broadcast podcast loudness
 * (default -16.0 LUFS with a -1.0 dBFS lookahead soft-knee peak ceiling).
 * Safe in both Node.js (`server.ts`) and browser runtimes.
 */
export function normalizeWavAudioBase64(
  base64: string,
  options: NormalizeWavOptions = {}
): NormalizedWavResult {
  const targetLufs = options.targetLufs ?? DEFAULT_LOUDNESS_TARGET_LUFS;
  const ceilingDbfs = options.ceilingDbfs ?? -1.0;
  const maxGainDb = options.maxGainDb ?? 14.0;
  const minGainDb = options.minGainDb ?? -14.0;

  const fallbackMetrics: WavLoudnessMetrics = {
    inputLufs: targetLufs,
    outputLufs: targetLufs,
    gainAppliedDb: 0,
    peakDbfs: ceilingDbfs,
    targetLufs,
    normalized: false,
  };

  if (!base64 || base64 === 'hosted' || base64.length < 64) {
    return { audioBase64: base64, metrics: fallbackMetrics };
  }

  try {
    const clean = stripDataUrlPrefix(base64);
    const bytes = decodeBase64Universal(clean);
    const parsed = parseWavContainer(bytes);
    if (!parsed) {
      return { audioBase64: clean, metrics: fallbackMetrics };
    }

    const samples = decodeSamplesInterleaved(parsed);
    if (!samples || samples.length === 0) {
      return { audioBase64: clean, metrics: fallbackMetrics };
    }

    // 1. Remove per-channel DC offset
    removeDcOffsetInPlace(samples, parsed.numChannels);

    // 2. Measure pre-normalization ITU-R BS.1770-4 gated speech loudness
    const before = measureGatedLoudnessAndPeak(
      samples,
      parsed.sampleRate,
      parsed.numChannels
    );

    // Leave silent clips untouched so noise floors are never amplified
    if (before.loudnessLufs <= -65) {
      return {
        audioBase64: clean,
        metrics: {
          inputLufs: before.loudnessLufs,
          outputLufs: before.loudnessLufs,
          gainAppliedDb: 0,
          peakDbfs: before.peakDbfs,
          targetLufs,
          normalized: true,
        },
      };
    }

    const rawDeltaDb = targetLufs - before.loudnessLufs;
    const clampedGainDb = Math.max(minGainDb, Math.min(maxGainDb, rawDeltaDb));
    const ceilingLinear = Math.pow(10, ceilingDbfs / 20);

    // Fast path if already tightly matched to target loudness and under peak ceiling
    if (Math.abs(clampedGainDb) < 0.15 && before.peakDbfs <= ceilingDbfs + 0.05) {
      return {
        audioBase64: clean,
        metrics: {
          inputLufs: before.loudnessLufs,
          outputLufs: before.loudnessLufs,
          gainAppliedDb: 0,
          peakDbfs: before.peakDbfs,
          targetLufs,
          normalized: true,
        },
      };
    }

    // 3. Apply loudness gain + lookahead soft-knee true-peak limiter
    const linearGain = Math.pow(10, clampedGainDb / 20);
    applyGainAndSoftKneeLimiterInPlace(
      samples,
      parsed.sampleRate,
      parsed.numChannels,
      linearGain,
      ceilingLinear
    );

    // 4. Verify post-limiter gated loudness and encode clean 16-bit PCM WAV
    const after = measureGatedLoudnessAndPeak(
      samples,
      parsed.sampleRate,
      parsed.numChannels
    );
    const wavOutBytes = encode16BitPcmWav(
      samples,
      parsed.sampleRate,
      parsed.numChannels
    );
    const outBase64 = encodeBase64Universal(wavOutBytes);

    return {
      audioBase64: outBase64,
      metrics: {
        inputLufs: before.loudnessLufs,
        outputLufs: after.loudnessLufs,
        gainAppliedDb: Math.round(clampedGainDb * 10) / 10,
        peakDbfs: after.peakDbfs,
        targetLufs,
        normalized: true,
      },
    };
  } catch {
    return { audioBase64: base64, metrics: fallbackMetrics };
  }
}

export function formatSignedDb(db: number): string {
  if (!Number.isFinite(db) || Math.abs(db) < 0.05) return '0.0 dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}
