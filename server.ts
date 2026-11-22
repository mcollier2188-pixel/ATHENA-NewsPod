import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';
import mammoth from 'mammoth';
import { extractText } from 'unpdf';
import { GoogleGenAI, Type } from '@google/genai';
import {
  registerSuiteRoutes,
  type ShareGovernanceController,
  type AuditedShareLink,
  type RawServerShareSnapshot,
} from './src/server/suiteRoutes.ts';
import { attachLiveVoiceServer } from './src/server/liveBridge.ts';
import { registerRssRoutes } from './src/server/rssRoutes.ts';
import {
  describeClientContext,
  extractTokenAuthMetadata,
  isVerifiedPrincipalToken,
  optionalAuth,
  type AuthRequest,
} from './src/middleware/auth.ts';
import { getOrCreateUser, recordUserActivityLog } from './src/db/queries.ts';
import {
  scrubProseString,
  scrubShareValueDeep,
} from './src/utils/sharePayloadInspector.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, 'dist');
const HAS_BUILT_CLIENT = fsSync.existsSync(path.join(DIST_DIR, 'index.html'));
const IS_DEV_SCRIPT = process.env.npm_lifecycle_event === 'dev';

const PORT = Number(process.env.PORT) || 3000;
const isProd =
  process.env.NODE_ENV === 'production' ||
  process.env.npm_lifecycle_event === 'start' ||
  (!IS_DEV_SCRIPT && process.env.NODE_ENV !== 'development' && HAS_BUILT_CLIENT);

const TEXT_MODEL_FALLBACK_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
] as const;

const TTS_MODEL_FALLBACK_CHAIN = [
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
] as const;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please check your API key in Settings > Secrets.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('503') ||
    msg.includes('500') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('DEADLINE_EXCEEDED')
  );
}

function shouldFallbackModel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('404') ||
    msg.includes('NOT_FOUND') ||
    msg.includes('503') ||
    msg.includes('UNAVAILABLE')
  );
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (!isTransientGeminiError(err) || attempt === maxRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 600 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

async function withModelFallback<T>(
  models: readonly string[],
  fn: (model: string) => Promise<T>,
  retriesPerModel = 1
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      return await withRetry(() => fn(model), retriesPerModel);
    } catch (err: unknown) {
      lastError = err;
      if (i < models.length - 1 && shouldFallbackModel(err)) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function withTextModelFallback<T>(fn: (model: string) => Promise<T>): Promise<T> {
  return withModelFallback(TEXT_MODEL_FALLBACK_CHAIN, fn, 1);
}

function withTtsModelFallback<T>(fn: (model: string) => Promise<T>): Promise<T> {
  return withModelFallback(TTS_MODEL_FALLBACK_CHAIN, fn, 1);
}

function formatApiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : 'An unexpected server error occurred.';
  if (raw.includes('API_KEY_INVALID') || raw.includes('PERMISSION_DENIED') || raw.includes('403')) {
    return {
      status: 403,
      message: 'API key error. Please verify your Gemini API key in Settings > Secrets.',
    };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return {
      status: 429,
      message: 'Rate limit reached on Gemini API. Please wait a few seconds and try again.',
    };
  }
  return { status: 500, message: raw };
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text.trim();
}

function stripCitationMarkers(text: string): string {
  return text
    .replace(/\s*\[(?:\d+(?:\s*,\s*\d+)*)\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatFileSize(bytes?: number): string | undefined {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SourcePassage {
  id: string;
  index: number;
  text: string;
}

function buildPassages(sourceId: string, content: string, maxPassages = 32): SourcePassage[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const rawBlocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter((b) => b.length > 0);

  const merged: string[] = [];
  for (const block of rawBlocks) {
    if (block.length > 720) {
      const sentences = block.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [block];
      let buf = '';
      for (const sentence of sentences) {
        const s = sentence.trim();
        if (!s) continue;
        if (buf.length + s.length + 1 > 560 && buf.length > 140) {
          merged.push(buf.trim());
          buf = s;
        } else {
          buf = buf ? `${buf} ${s}` : s;
        }
      }
      if (buf.trim()) merged.push(buf.trim());
    } else if (
      merged.length > 0 &&
      block.length < 110 &&
      merged[merged.length - 1].length < 420
    ) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${block}`;
    } else {
      merged.push(block);
    }
  }

  return merged.slice(0, maxPassages).map((text, idx) => ({
    id: `${sourceId}-p${idx + 1}`,
    index: idx + 1,
    text,
  }));
}

interface IncomingHighlight {
  id?: string;
  text: string;
  passageIndex?: number;
  createdAt?: string;
}

interface IncomingArticle {
  id: string;
  title: string;
  source: string;
  sourceType?: string;
  category: string;
  url?: string;
  summary: string;
  keyFacts: string[];
  highlights?: IncomingHighlight[];
  content: string;
  passages?: SourcePassage[];
  estimatedReadMinutes: number;
}

interface ResolvedCitation {
  marker: number;
  sourceId: string;
  sourceTitle: string;
  passageIndex: number;
  excerpt: string;
}

interface RawCitation {
  marker?: unknown;
  sourceIndex?: unknown;
  passageIndex?: unknown;
  excerpt?: unknown;
}

function buildIndexedSourcesPrompt(articles: IncomingArticle[]): string {
  return articles
    .map((a, idx) => {
      const sNum = idx + 1;
      const passages =
        Array.isArray(a.passages) && a.passages.length > 0
          ? a.passages
          : buildPassages(a.id, a.content || a.summary);
      const passageLines = passages
        .slice(0, 16)
        .map((p) => `[S${sNum}-P${p.index}] ${p.text}`)
        .join('\n');

      const validHighlights = (Array.isArray(a.highlights) ? a.highlights : [])
        .map((h) => {
          const text = String(h?.text || '').trim().slice(0, 600);
          if (text.length < 2) return null;
          let pIdx = Number(h?.passageIndex) || 0;
          if (pIdx < 1 || pIdx > passages.length) {
            const matched = passages.find((p) =>
              p.text.toLowerCase().includes(text.toLowerCase())
            );
            pIdx = matched ? matched.index : 1;
          }
          return `- [S${sNum}-P${pIdx}] "${text}"`;
        })
        .filter((line): line is string => Boolean(line))
        .slice(0, 20);

      const highlightsBlock =
        validHighlights.length > 0
          ? `\nUSER-HIGHLIGHTED PASSAGES (Prioritize & cite in briefing):\n${validHighlights.join('\n')}`
          : '';

      return `SOURCE ${sNum}:
Title: ${a.title}
Origin: ${a.source} (${a.sourceType || 'article'} · ${a.category})
Summary: ${a.summary}${highlightsBlock}
Passages:
${passageLines}`;
    })
    .join('\n\n---\n\n');
}

function resolveCitations(
  rawList: unknown,
  articles: IncomingArticle[]
): ResolvedCitation[] {
  if (!Array.isArray(rawList) || articles.length === 0) return [];
  const seenMarkers = new Set<number>();
  const resolved: ResolvedCitation[] = [];

  for (const item of rawList as RawCitation[]) {
    const marker = Number(item?.marker);
    const sourceIndex = Number(item?.sourceIndex);
    const rawPassageIndex = Number(item?.passageIndex);
    if (!Number.isInteger(marker) || marker < 1 || seenMarkers.has(marker)) {
      continue;
    }
    const artIdx =
      Number.isInteger(sourceIndex) && sourceIndex >= 1 && sourceIndex <= articles.length
        ? sourceIndex - 1
        : 0;
    const art = articles[artIdx];
    const passages =
      Array.isArray(art.passages) && art.passages.length > 0
        ? art.passages
        : buildPassages(art.id, art.content || art.summary);
    const safePassageIdx =
      Number.isInteger(rawPassageIndex) &&
      rawPassageIndex >= 1 &&
      rawPassageIndex <= Math.max(1, passages.length)
        ? rawPassageIndex
        : 1;
    const matchedPassage = passages[safePassageIdx - 1];
    const excerpt =
      String(item?.excerpt || '').trim() ||
      (matchedPassage ? matchedPassage.text.slice(0, 180) : art.summary.slice(0, 180));

    seenMarkers.add(marker);
    resolved.push({
      marker,
      sourceId: art.id,
      sourceTitle: art.title,
      passageIndex: safePassageIdx,
      excerpt,
    });
  }

  return resolved.sort((a, b) => a.marker - b.marker);
}

function normalizeTags(rawTags: unknown, fallbackCategory?: string): string[] {
  const items = Array.isArray(rawTags) ? rawTags : [];
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const item of items) {
    const raw = String(item || '')
      .replace(/^#+/, '')
      .replace(/[^\w\s&/-]/g, '')
      .trim();
    if (!raw || raw.length > 22) continue;
    // Normalize casing while keeping common acronyms like AI, UK, US, EV, EU intact
    const formatted = raw
      .split(/\s+/)
      .slice(0, 2)
      .map((w) =>
        /^(AI|UK|US|EU|EV|GDP|IPO|ESG|CEO|R&D)$/i.test(w)
          ? w.toUpperCase()
          : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      )
      .join(' ');
    const key = formatted.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      cleaned.push(formatted);
    }
    if (cleaned.length >= 3) break;
  }

  if (cleaned.length === 0 && fallbackCategory) {
    const fb = fallbackCategory.trim().slice(0, 20);
    if (fb) cleaned.push(fb);
  }
  return cleaned;
}

interface BriefingPreferences {
  durationMinutes: 3 | 5 | 10;
  format: 'solo' | 'podcast';
  tone: 'executive' | 'conversational' | 'analytical' | 'upbeat';
  voiceTone?: 'professional' | 'casual' | 'energetic' | 'soothing';
  voiceName: string;
  coHostVoiceName: string;
  listenerFocus: string;
  personalizedIntroduction?: string;
}

interface ScriptLine {
  speaker: string;
  text: string;
}

const app = express();
app.use(express.json({ limit: '64mb' }));

// Temporary cloud-hosted shared briefing storage (persisted in OS temp dir with TTL cleanup)
const SHARE_ROOT_DIR = path.join(os.tmpdir(), 'dispatch-shared-briefings');
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;
const ALLOWED_SHARE_TTL_HOURS = new Set([24, 72, 168]);

interface StoredShareSegment {
  id: string;
  title: string;
  category: string;
  sourceTitles: string[];
  keyPoint: string;
  estimatedSeconds: number;
  audioDurationSeconds?: number;
  lines: ScriptLine[];
  coHostVoiceName?: string;
  hasAudio: boolean;
  audioUrl?: string;
}

interface StoredShareManifest {
  shareId: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: number;
  editionTitle: string;
  editionSubtitle: string;
  briefingCreatedAt: string;
  takeaways: string[];
  preferences: BriefingPreferences & {
    dynamicPanel?: boolean;
    segmentCoHostVoices?: Record<string, string>;
  };
  articleTitles: string[];
  segments: StoredShareSegment[];
  hasAudio: boolean;
  recordedChapters: number;
  totalDurationSeconds: number;
  downloadUrl?: string;
  creatorUid?: string;
  creatorEmail?: string;
  manageToken?: string;
}

function safeTimingEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function stripInternalShareSecrets<
  T extends { creatorUid?: string; creatorEmail?: string; manageToken?: string },
>(manifest: T): Omit<T, 'creatorUid' | 'creatorEmail' | 'manageToken'> {
  const {
    creatorUid: _uid,
    creatorEmail: _email,
    manageToken: _token,
    ...publicManifest
  } = manifest;
  return publicManifest;
}

async function canManageShare(
  req: AuthRequest,
  manifest: { creatorUid?: string; manageToken?: string }
): Promise<boolean> {
  const headerVal = req.headers['x-share-manage-token'];
  const providedManageToken =
    typeof headerVal === 'string' ? headerVal.trim() : '';
  if (providedManageToken && safeTimingEqual(providedManageToken, manifest.manageToken)) {
    return true;
  }

  if (!req.user?.uid) {
    return false;
  }

  if (isVerifiedPrincipalToken(req.user)) {
    return true;
  }

  if (manifest.creatorUid && req.user.uid === manifest.creatorUid) {
    return true;
  }

  try {
    const dbUser = await getOrCreateUser(
      req.user.uid,
      req.user.email || `${req.user.uid}@dispatch.local`,
      typeof req.user.name === 'string' ? req.user.name : '',
      typeof req.user.picture === 'string' ? req.user.picture : '',
      Boolean(req.user.email_verified)
    );
    return dbUser.role === 'owner' || dbUser.role === 'admin';
  } catch {
    return false;
  }
}

function parseServerWav(bytes: Buffer): {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  pcmData: Buffer;
} | null {
  if (bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let sampleRate = 24000;
  let numChannels = 1;
  let bitsPerSample = 16;
  let pcmData: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;

    if (chunkId === 'fmt ' && dataStart + 16 <= bytes.length) {
      numChannels = bytes.readUInt16LE(dataStart + 2);
      sampleRate = bytes.readUInt32LE(dataStart + 4);
      bitsPerSample = bytes.readUInt16LE(dataStart + 14);
    } else if (chunkId === 'data') {
      const end = Math.min(bytes.length, dataStart + chunkSize);
      pcmData = bytes.subarray(dataStart, end);
      break;
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  if (!pcmData) return null;
  return { sampleRate, numChannels, bitsPerSample, pcmData };
}

function stitchServerWavBuffers(buffers: Buffer[]): Buffer | null {
  const parsed = buffers
    .map((b) => parseServerWav(b))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));
  if (parsed.length === 0) return null;

  const { sampleRate, numChannels, bitsPerSample } = parsed[0];
  const bytesPerSample = bitsPerSample / 8;
  const pauseBytes = Math.floor(sampleRate * 0.35) * numChannels * bytesPerSample;

  let totalPcmBytes = 0;
  parsed.forEach((clip, idx) => {
    totalPcmBytes += clip.pcmData.length;
    if (idx < parsed.length - 1) totalPcmBytes += pauseBytes;
  });

  const out = Buffer.alloc(44 + totalPcmBytes);
  out.write('RIFF', 0, 4, 'ascii');
  out.writeUInt32LE(36 + totalPcmBytes, 4);
  out.write('WAVE', 8, 4, 'ascii');
  out.write('fmt ', 12, 4, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(numChannels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  out.writeUInt16LE(numChannels * bytesPerSample, 32);
  out.writeUInt16LE(bitsPerSample, 34);
  out.write('data', 36, 4, 'ascii');
  out.writeUInt32LE(totalPcmBytes, 40);

  let writeOffset = 44;
  parsed.forEach((clip, idx) => {
    clip.pcmData.copy(out, writeOffset);
    writeOffset += clip.pcmData.length;
    if (idx < parsed.length - 1) {
      writeOffset += pauseBytes;
    }
  });
  return out;
}

async function cleanupExpiredShares(): Promise<number> {
  let purged = 0;
  try {
    await fs.mkdir(SHARE_ROOT_DIR, { recursive: true });
    const entries = await fs.readdir(SHARE_ROOT_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(SHARE_ROOT_DIR, entry.name);
      try {
        const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
        const manifest = JSON.parse(raw) as { expiresAt?: string };
        if (manifest.expiresAt && now > new Date(manifest.expiresAt).getTime()) {
          await fs.rm(dir, { recursive: true, force: true });
          purged += 1;
        }
      } catch {
        // Ignore malformed or in-flight share directories
      }
    }
  } catch {
    // Non-fatal background cleanup
  }
  return purged;
}

async function readValidShareManifest(shareId: string): Promise<
  | { status: 'ok'; manifest: StoredShareManifest; dir: string }
  | { status: 'not_found' }
  | { status: 'expired' }
> {
  if (!SHARE_ID_PATTERN.test(shareId)) {
    return { status: 'not_found' };
  }
  const dir = path.join(SHARE_ROOT_DIR, shareId);
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as StoredShareManifest;
    if (Date.now() > new Date(manifest.expiresAt).getTime()) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return { status: 'expired' };
    }
    return { status: 'ok', manifest, dir };
  } catch {
    return { status: 'not_found' };
  }
}

// Health checks (Cloud Run startup & liveness probes)
app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

// 1A. Upload & ingest a user document (PDF, DOCX, TXT, Markdown) — local text extraction first, never fails on Gemini rate limits
app.post(['/api/sources/upload', '/api/ingest-document'], async (req, res) => {
  try {
    const { fileName, mimeType, base64Data, textContent, fileSizeBytes } = req.body as {
      fileName?: string;
      mimeType?: string;
      base64Data?: string;
      textContent?: string;
      fileSizeBytes?: number;
    };

    const cleanName = (fileName || 'Uploaded Document').trim();
    const ext = path.extname(cleanName).toLowerCase();
    const lowerMime = (mimeType || '').toLowerCase();

    const isPdf = ext === '.pdf' || lowerMime === 'application/pdf';
    const isDocx =
      ext === '.docx' ||
      lowerMime ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isMd = ext === '.md' || ext === '.markdown' || lowerMime === 'text/markdown';
    const isTxt = ext === '.txt' || lowerMime === 'text/plain';

    if (!isPdf && !isDocx && !isMd && !isTxt) {
      res.status(400).json({
        error: 'Unsupported document format. Please upload a PDF, DOCX, TXT, or Markdown file.',
      });
      return;
    }

    if (fileSizeBytes && fileSizeBytes > 16 * 1024 * 1024) {
      res.status(413).json({
        error: 'Document exceeds the 15 MB upload limit. Please choose a smaller file.',
      });
      return;
    }

    const cleanBase64 =
      typeof base64Data === 'string' && base64Data.includes(',')
        ? base64Data.split(',').pop() || ''
        : base64Data || '';

    const tempId = `doc-${Date.now()}`;
    const sizeLabel = formatFileSize(fileSizeBytes);
    const sourceType: 'pdf' | 'docx' | 'markdown' | 'txt' = isPdf
      ? 'pdf'
      : isDocx
        ? 'docx'
        : isMd
          ? 'markdown'
          : 'txt';

    let extractedText = '';

    // Step 1: Extract text locally on the server (unpdf for PDF, mammoth for DOCX, Buffer for TXT/MD)
    if (isPdf) {
      if (!cleanBase64) {
        res.status(400).json({ error: 'PDF file data is missing.' });
        return;
      }

      let pdfBuffer: Buffer;
      try {
        pdfBuffer = Buffer.from(cleanBase64, 'base64');
      } catch {
        res.status(400).json({ error: 'Invalid PDF file encoding.' });
        return;
      }

      try {
        const pdfResult = await extractText(new Uint8Array(pdfBuffer), { mergePages: false });
        const rawPages = Array.isArray(pdfResult.text)
          ? pdfResult.text
          : [String(pdfResult.text || '')];
        extractedText = rawPages
          .map((page) =>
            String(page || '')
              .replace(/\r\n/g, '\n')
              .replace(/[ \t]+/g, ' ')
              .replace(/\n{3,}/g, '\n\n')
              .trim()
          )
          .filter(Boolean)
          .join('\n\n');
      } catch {
        extractedText = '';
      }

      // Only fall back to Gemini vision if extracted PDF text is empty (scanned PDF)
      if (!extractedText) {
        try {
          const ai = getGeminiClient();
          const pdfResponse = await withTextModelFallback((model) =>
            ai.models.generateContent({
              model,
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'application/pdf',
                        data: cleanBase64,
                      },
                    },
                    {
                      text: `Analyze this scanned PDF document ("${cleanName}") and build a Notebook-style Source Guide plus a faithful, well-structured full-text digest broken into clear paragraphs separated by blank lines so individual passages can be cited accurately.`,
                    },
                  ],
                },
              ],
              config: {
                systemInstruction:
                  'You are a meticulous research librarian. Extract the document title (or clean the filename), a 1-2 word topic category, 2 to 3 concise context-relevant tags (like "Tech", "Economy", "Politics", "Energy", "Policy", "Finance", "AI", "Climate", "Health", "Science"), a crisp 2-sentence Source Guide overview, 3 to 5 concrete key facts/findings, estimated reading time in minutes, and thorough factual document text organized into clean multi-sentence paragraphs separated by double newlines (\\n\\n).',
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    category: { type: Type.STRING },
                    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                    summary: { type: Type.STRING },
                    keyFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
                    content: { type: Type.STRING },
                    estimatedReadMinutes: { type: Type.INTEGER },
                  },
                  required: ['title', 'category', 'tags', 'summary', 'keyFacts', 'content'],
                },
              },
            })
          );

          const parsedPdf = JSON.parse((pdfResponse.text ?? '{}').trim()) as Record<
            string,
            unknown
          >;
          const visionContent = String(parsedPdf.content || '').trim();
          if (visionContent) {
            const wordCount = visionContent.split(/\s+/).filter(Boolean).length;
            const passages = buildPassages(tempId, visionContent);
            const category = String(parsedPdf.category || 'Document');

            res.json({
              article: {
                title: String(parsedPdf.title || cleanName.replace(/\.pdf$/i, '')),
                source: cleanName,
                sourceType: 'pdf',
                fileSizeLabel: sizeLabel,
                category,
                tags: normalizeTags(parsedPdf.tags, category),
                summary: String(parsedPdf.summary || visionContent.slice(0, 220)),
                keyFacts: Array.isArray(parsedPdf.keyFacts)
                  ? parsedPdf.keyFacts.map(String).slice(0, 5)
                  : [],
                content: visionContent.slice(0, 28000),
                passages,
                estimatedReadMinutes:
                  Number(parsedPdf.estimatedReadMinutes) ||
                  Math.max(1, Math.round(wordCount / 220)),
              },
            });
            return;
          }
        } catch {
          // If Gemini vision is rate-limited on a scanned PDF, continue with local document fallback below
        }

        extractedText = `Uploaded PDF document: ${cleanName}. This PDF contains scanned or image-based pages queued in your notebook sources.`;
      }
    } else if (isDocx) {
      if (!cleanBase64) {
        res.status(400).json({ error: 'Word document data is missing.' });
        return;
      }
      try {
        const buffer = Buffer.from(cleanBase64, 'base64');
        const result = await mammoth.extractRawText({ buffer });
        extractedText = (result.value || '').trim();
      } catch {
        res.status(422).json({
          error: 'Could not read that .docx file. Make sure it is a valid Word (.docx) document.',
        });
        return;
      }
    } else {
      extractedText = (
        textContent ||
        (cleanBase64 ? Buffer.from(cleanBase64, 'base64').toString('utf-8') : '')
      ).trim();
    }

    if (!extractedText) {
      res.status(422).json({
        error: 'The uploaded document appears to be empty.',
      });
      return;
    }

    // Step 2: Build immediate local fallback metadata & passages so uploads never fail on API limits
    const clippedText = extractedText.slice(0, 28000);
    const wordCount = clippedText.split(/\s+/).filter(Boolean).length;
    const computedReadMinutes = Math.max(1, Math.round(wordCount / 220));
    const passages = buildPassages(tempId, clippedText);

    const mdHeadingMatch = isMd ? clippedText.match(/^#\s+([^\r\n]{2,140})/) : null;
    const cleanedBaseTitle =
      (mdHeadingMatch ? mdHeadingMatch[1].trim() : '') ||
      cleanName
        .replace(/\.(pdf|docx|txt|md|markdown)$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim() ||
      'Uploaded Document';

    const firstParagraph = (
      passages[0]?.text ||
      clippedText.split(/\n{2,}/)[0] ||
      clippedText
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 260);

    const fallbackKeyFacts = passages
      .slice(0, 4)
      .map((p) => p.text.replace(/\s+/g, ' ').trim().slice(0, 220))
      .filter(Boolean);

    let resolvedTitle = cleanedBaseTitle;
    let resolvedCategory = 'Document';
    let resolvedTags = normalizeTags([], resolvedCategory);
    let resolvedSummary = firstParagraph;
    let resolvedKeyFacts = fallbackKeyFacts;
    let resolvedReadMinutes = computedReadMinutes;

    // Step 3: Optional Gemini Source Guide enrichment — wrapped in try/catch so 429/errors never fail uploads
    try {
      const ai = getGeminiClient();
      const guideRes = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Create a Notebook-style Source Guide for the uploaded document "${cleanName}":\n\n${clippedText.slice(0, 22000)}`,
          config: {
            systemInstruction:
              'You are a fast research editor. Extract a clean document title, a 1-2 word topic category, 2 to 3 concise context-relevant tags (like "Tech", "Economy", "Politics", "Energy", "Policy", "AI", "Climate", "Finance", "Science"), a crisp 2-sentence Source Guide overview, 3 to 5 key facts/takeaways with specific details, and estimated reading minutes.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                category: { type: Type.STRING },
                tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                summary: { type: Type.STRING },
                keyFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
                estimatedReadMinutes: { type: Type.INTEGER },
              },
              required: ['title', 'category', 'tags', 'summary', 'keyFacts'],
            },
          },
        })
      );

      const parsed = JSON.parse((guideRes.text ?? '{}').trim()) as Record<string, unknown>;
      if (typeof parsed.title === 'string' && parsed.title.trim()) {
        resolvedTitle = parsed.title.trim();
      }
      if (typeof parsed.category === 'string' && parsed.category.trim()) {
        resolvedCategory = parsed.category.trim();
      }
      resolvedTags = normalizeTags(parsed.tags, resolvedCategory);
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
        resolvedSummary = parsed.summary.trim();
      }
      if (Array.isArray(parsed.keyFacts) && parsed.keyFacts.length > 0) {
        resolvedKeyFacts = parsed.keyFacts.map(String).filter(Boolean).slice(0, 5);
      }
      if (Number(parsed.estimatedReadMinutes) > 0) {
        resolvedReadMinutes = Number(parsed.estimatedReadMinutes);
      }
    } catch {
      // Keep local fallback title, first-paragraph summary, and extracted passages
    }

    res.json({
      article: {
        title: resolvedTitle,
        source: cleanName,
        sourceType,
        fileSizeLabel: sizeLabel,
        category: resolvedCategory,
        tags: resolvedTags,
        summary: resolvedSummary,
        keyFacts: resolvedKeyFacts,
        content: clippedText,
        passages,
        estimatedReadMinutes: resolvedReadMinutes,
      },
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

// 1B. Ingest a news article from URL or pasted text
app.post('/api/articles/ingest', async (req, res) => {
  try {
    const { url, rawText } = req.body as { url?: string; rawText?: string };
    const trimmedUrl = (url ?? '').trim();
    const trimmedText = (rawText ?? '').trim();

    if (!trimmedUrl && !trimmedText) {
      res.status(400).json({ error: 'Please provide an article URL or paste article text.' });
      return;
    }

    const tempId = `art-${Date.now()}`;

    // Case A: URL provided — use Gemini urlContext with graceful fallback to server fetch
    if (trimmedUrl && !trimmedText) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(trimmedUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error('Invalid protocol');
        }
      } catch {
        res.status(400).json({ error: 'Please enter a valid http:// or https:// article URL.' });
        return;
      }

      let extracted: {
        title: string;
        source: string;
        category: string;
        tags: string[];
        summary: string;
        keyFacts: string[];
        content: string;
        estimatedReadMinutes: number;
      } | null = null;

      try {
        const ai = getGeminiClient();
        const urlResponse = await withTextModelFallback((model) =>
          ai.models.generateContent({
            model,
            contents: `Read the news article at ${parsedUrl.toString()} and extract its core editorial content. Return ONLY a raw JSON object (no markdown commentary) with these exact keys:
{
  "title": "Exact or cleaned headline",
  "source": "Publication or domain name",
  "category": "Single concise topic like Technology, Economy, Climate, Policy, Science, Business, Culture, or World",
  "tags": ["2 to 3 crisp 1-2 word tags like Tech, Economy, Politics, AI, Energy, Markets"],
  "summary": "2 crisp editorial sentences summarizing the article",
  "keyFacts": ["Fact 1 with concrete numbers/names", "Fact 2", "Fact 3"],
  "content": "A thorough, factual 300-600 word digest of the article's reporting, quotes, data, and context split into clean paragraphs separated by double newlines",
  "estimatedReadMinutes": 4
}`,
            config: {
              tools: [{ urlContext: {} }],
            },
          })
        );

        const rawJson = extractJsonBlock(urlResponse.text ?? '');
        const candidate = JSON.parse(rawJson);
        if (candidate && candidate.title && candidate.content) {
          const category = String(candidate.category || 'World');
          extracted = {
            title: String(candidate.title),
            source: String(candidate.source || parsedUrl.hostname.replace(/^www\./, '')),
            category,
            tags: normalizeTags(candidate.tags, category),
            summary: String(candidate.summary || ''),
            keyFacts: Array.isArray(candidate.keyFacts)
              ? candidate.keyFacts.map(String).slice(0, 4)
              : [],
            content: String(candidate.content),
            estimatedReadMinutes: Math.max(1, Number(candidate.estimatedReadMinutes) || 4),
          };
        }
      } catch {
        // Fall through to direct fetch
      }

      if (!extracted) {
        let pageText = '';
        let scrapedTitle = '';
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 9000);
          const pageRes = await fetch(parsedUrl.toString(), {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (compatible; DispatchBriefingBot/1.0; +https://dispatch.local)',
              Accept: 'text/html,application/xhtml+xml,text/plain',
            },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!pageRes.ok) {
            throw new Error(`Site returned HTTP ${pageRes.status}`);
          }
          const html = await pageRes.text();
          const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          scrapedTitle = titleMatch ? stripHtmlToText(titleMatch[1]).slice(0, 180) : '';
          pageText = stripHtmlToText(html).slice(0, 18000);
        } catch {
          res.status(422).json({
            error:
              'Could not access that URL directly (it may be behind a paywall or blocking automated readers). Paste the text or upload a PDF/DOCX instead.',
          });
          return;
        }

        if (pageText.length < 120) {
          res.status(422).json({
            error:
              'That page did not return readable article text (it may require sign-in). Try pasting the text directly.',
          });
          return;
        }

        try {
          const ai = getGeminiClient();
          const fastRes = await withTextModelFallback((model) =>
            ai.models.generateContent({
              model,
              contents: `Extract structured editorial metadata, 2 to 3 concise topic tags (like Tech, Economy, Politics, Energy, Science), and clean article reporting from this scraped webpage from ${parsedUrl.hostname}:\n\n${pageText}`,
              config: {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    source: { type: Type.STRING },
                    category: { type: Type.STRING },
                    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                    summary: { type: Type.STRING },
                    keyFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
                    content: { type: Type.STRING },
                    estimatedReadMinutes: { type: Type.INTEGER },
                  },
                  required: [
                    'title',
                    'source',
                    'category',
                    'tags',
                    'summary',
                    'keyFacts',
                    'content',
                  ],
                },
              },
            })
          );

          const parsed = JSON.parse((fastRes.text ?? '{}').trim());
          const category = String(parsed.category || 'News');
          extracted = {
            title: String(parsed.title || scrapedTitle || parsedUrl.hostname),
            source: String(parsed.source || parsedUrl.hostname.replace(/^www\./, '')),
            category,
            tags: normalizeTags(parsed.tags, category),
            summary: String(parsed.summary || pageText.slice(0, 240)),
            keyFacts: Array.isArray(parsed.keyFacts)
              ? parsed.keyFacts.map(String).slice(0, 4)
              : [],
            content: String(parsed.content || pageText.slice(0, 8000)),
            estimatedReadMinutes: Math.max(1, Number(parsed.estimatedReadMinutes) || 4),
          };
        } catch {
          const cleanSource = parsedUrl.hostname.replace(/^www\./, '');
          const localPassages = buildPassages(tempId, pageText.slice(0, 12000));
          const wordCount = pageText.split(/\s+/).filter(Boolean).length;
          extracted = {
            title: scrapedTitle || cleanSource,
            source: cleanSource,
            category: 'News',
            tags: normalizeTags([], 'News'),
            summary: (localPassages[0]?.text || pageText).slice(0, 240),
            keyFacts: localPassages.slice(0, 3).map((p) => p.text.slice(0, 200)),
            content: pageText.slice(0, 12000),
            estimatedReadMinutes: Math.max(1, Math.round(wordCount / 220)),
          };
        }
      }

      const passages = buildPassages(tempId, extracted.content);

      res.json({
        article: {
          ...extracted,
          sourceType: 'article',
          passages,
          url: parsedUrl.toString(),
        },
      });
      return;
    }

    // Case B: Raw pasted text — fast extraction with gemini-3.5-flash-lite -> gemini-3.1-flash-lite + local fallback
    const content = trimmedText.slice(0, 24000);
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const computedMinutes = Math.max(1, Math.round(wordCount / 220));
    const passages = buildPassages(tempId, content);
    const firstParagraph = (passages[0]?.text || content.split(/\n{2,}/)[0] || content)
      .replace(/\s+/g, ' ')
      .trim();

    let title = firstParagraph.slice(0, 72) || 'Untitled Source';
    let source = 'Personal Note';
    let category = 'Briefing';
    let tags = normalizeTags([], category);
    let summary = firstParagraph.slice(0, 240);
    let keyFacts = passages.slice(0, 3).map((p) => p.text.slice(0, 200));
    let estimatedReadMinutes = computedMinutes;

    try {
      const ai = getGeminiClient();
      const fastResponse = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Analyze this pasted source text and return structured editorial metadata:\n\n${content}`,
          config: {
            systemInstruction:
              'You are a fast copy editor. Extract a clean headline, source/publication name (use "Personal Note" if none is mentioned), a 1-2 word topic category, 2 to 3 concise context-relevant tags (like "Tech", "Economy", "Politics", "Energy", "Policy", "AI", "Climate", "Finance", "Science"), a crisp 2-sentence editorial summary, 3 concrete key facts, and estimated reading time in minutes.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                source: { type: Type.STRING },
                category: { type: Type.STRING },
                tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                summary: { type: Type.STRING },
                keyFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
                estimatedReadMinutes: { type: Type.INTEGER },
              },
              required: ['title', 'source', 'category', 'tags', 'summary', 'keyFacts'],
            },
          },
        })
      );

      const parsed = JSON.parse((fastResponse.text ?? '{}').trim()) as Record<string, unknown>;
      if (typeof parsed.title === 'string' && parsed.title.trim()) title = parsed.title.trim();
      if (typeof parsed.source === 'string' && parsed.source.trim()) source = parsed.source.trim();
      if (typeof parsed.category === 'string' && parsed.category.trim()) {
        category = parsed.category.trim();
      }
      tags = normalizeTags(parsed.tags, category);
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
        summary = parsed.summary.trim();
      }
      if (Array.isArray(parsed.keyFacts) && parsed.keyFacts.length > 0) {
        keyFacts = parsed.keyFacts.map(String).slice(0, 4);
      }
      if (Number(parsed.estimatedReadMinutes) > 0) {
        estimatedReadMinutes = Number(parsed.estimatedReadMinutes);
      }
    } catch {
      // Keep local passages and first-paragraph metadata if Gemini is rate-limited
    }

    res.json({
      article: {
        title,
        source,
        sourceType: 'txt',
        category,
        tags,
        url: trimmedUrl || undefined,
        summary,
        keyFacts,
        content,
        passages,
        estimatedReadMinutes,
      },
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

// 1C. Automatically generate context-relevant tags for one or more sources
app.post('/api/sources/tag', async (req, res) => {
  try {
    const { sources } = req.body as {
      sources?: Array<{
        id: string;
        title: string;
        summary?: string;
        content?: string;
        category?: string;
      }>;
    };

    if (!Array.isArray(sources) || sources.length === 0) {
      res.status(400).json({ error: 'Provide at least one source to tag.' });
      return;
    }

    const batch = sources.slice(0, 20);
    const sourceDigest = batch
      .map(
        (s, idx) =>
          `[${idx + 1}] ID: ${s.id}\nTitle: ${s.title}\nCategory: ${s.category || 'General'}\nExcerpt: ${(s.summary || s.content || '').slice(0, 480)}`
      )
      .join('\n\n');

    const tagsById: Record<string, string[]> = {};
    const fallbackById = new Map(batch.map((s) => [s.id, s.category]));

    try {
      const ai = getGeminiClient();
      const response = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Assign 2 to 3 crisp, context-relevant newsroom tags to each source below.\n\n${sourceDigest}`,
          config: {
            systemInstruction:
              'You are a newsroom taxonomy editor. For each source, return 2 to 3 concise 1-2 word tags such as "Tech", "Economy", "Politics", "Climate", "Energy", "AI", "Policy", "Markets", "Transit", "Health", "Science", "Europe", "World", or "Finance". Prefer standardized short labels so related articles share tags cleanly.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                items: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: ['id', 'tags'],
                  },
                },
              },
              required: ['items'],
            },
          },
        })
      );

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        items?: Array<{ id?: string; tags?: unknown }>;
      };

      if (Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (!item?.id) continue;
          tagsById[item.id] = normalizeTags(item.tags, fallbackById.get(item.id));
        }
      }
    } catch {
      // Fall back to category-derived tags if Gemini is rate-limited
    }

    for (const s of batch) {
      if (!tagsById[s.id] || tagsById[s.id].length === 0) {
        tagsById[s.id] = normalizeTags([], s.category || 'News');
      }
    }

    res.json({ tagsById });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

// 2. Generate a personalized commute audio briefing script with clickable citations
app.post('/api/briefings/generate', async (req, res) => {
  try {
    const { articles, preferences, personalizedIntroduction } = req.body as {
      articles: IncomingArticle[];
      preferences: BriefingPreferences;
      personalizedIntroduction?: string;
    };

    if (!Array.isArray(articles) || articles.length === 0) {
      res.status(400).json({ error: 'Select at least one source to build your briefing.' });
      return;
    }

    const ai = getGeminiClient();
    const targetWords =
      preferences.durationMinutes === 3
        ? 420
        : preferences.durationMinutes === 5
          ? 700
          : 1280;

    const toneDescriptions: Record<string, string> = {
      executive:
        'Crisp, authoritative, high-signal executive radio briefing (like The Economist Morning Briefing). Zero fluff, sharp numbers, immediate implications.',
      conversational:
        'Warm, intelligent, natural spoken cadence (like NPR Up First or The Daily). Engaging transitions and clear everyday phrasing.',
      analytical:
        'Deep, thoughtful journalistic analysis connecting second-order economic, technical, and policy consequences across sources.',
      upbeat:
        'Energetic, bright morning commute broadcast with brisk pacing, vivid analogies, and an engaging start-the-day momentum.',
    };

    const voiceToneDescriptions: Record<string, string> = {
      professional:
        'VOCAL DELIVERY CADENCE (Professional): Write clean, composed broadcast sentences tailored for poised, authoritative studio articulation.',
      casual:
        'VOCAL DELIVERY CADENCE (Casual): Write relaxed, approachable, everyday spoken phrasing that feels like catching up with a well-informed friend.',
      energetic:
        'VOCAL DELIVERY CADENCE (Energetic): Write brisk, dynamic, forward-moving lines with lively rhythm and crisp punchy transitions.',
      soothing:
        'VOCAL DELIVERY CADENCE (Soothing): Write calm, unhurried, gently paced phrasing with smooth transitions suited for a peaceful wind-down listen.',
    };

    const selectedVoiceTone = preferences.voiceTone || 'professional';

    const formatInstructions =
      preferences.format === 'podcast'
        ? `FORMAT: Two-Host Commute Podcast featuring exactly two speakers: "Alex" (lead anchor, structured and curious) and "Sam" (sharp senior analyst, brings nuance and context).
- Every line in each segment's "lines" array MUST have speaker set to either "Alex" or "Sam".
- Create lively, natural alternating turns (4 to 8 turns per segment) that sound genuinely spoken aloud — never robotic essay paragraphs.
- Occasionally (at most 1-2 times per segment) use subtle natural cues supported by Gemini TTS such as |yeah|, |mhm|, or <breath> where a co-host naturally reacts, keeping it tasteful and newsroom-authentic.`
        : `FORMAT: Solo Radio Anchor featuring a single speaker named "Anchor".
- Every line in each segment's "lines" array MUST have speaker set to "Anchor".
- Split each segment into 2 to 4 clean spoken paragraphs (one per entry in "lines") with natural broadcast cadence, smooth story-to-story transitions, and clear spoken punctuation.`;

    const sourcesContext = buildIndexedSourcesPrompt(articles);

    const focusBlock = preferences.listenerFocus.trim()
      ? `LISTENER PERSONALIZATION DIRECTIVE: "${preferences.listenerFocus.trim()}". Prioritize angles, explanations, and takeaways that directly serve this listener focus.`
      : 'LISTENER PERSONALIZATION DIRECTIVE: Deliver balanced, commuter-friendly clarity with memorable takeaways.';

    const customIntroduction = (
      typeof personalizedIntroduction === 'string' && personalizedIntroduction.trim()
        ? personalizedIntroduction
        : preferences.personalizedIntroduction || ''
    ).trim();

    const introBlock = customIntroduction
      ? `PERSONALIZED INTRODUCTION DIRECTIVE: The listener provided a custom opening introduction: "${customIntroduction}".
- The VERY FIRST line of Segment 1 ("lines"[0]) MUST be spoken by ${preferences.format === 'podcast' ? '"Alex"' : '"Anchor"'} and MUST open verbatim with this personalized introduction before transitioning naturally into the briefing's first story. Do not repeat a separate generic greeting after it.`
      : '';

    const citationSchemaItem = {
      type: Type.OBJECT,
      properties: {
        marker: { type: Type.INTEGER },
        sourceIndex: { type: Type.INTEGER },
        passageIndex: { type: Type.INTEGER },
        excerpt: { type: Type.STRING },
      },
      required: ['marker', 'sourceIndex', 'passageIndex', 'excerpt'],
    };

    const response = await withTextModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: `Create a personalized ${preferences.durationMinutes}-minute commute audio briefing (~${targetWords} total spoken words across all segments) grounded in these ${articles.length} sources.\n\n${sourcesContext}`,
        config: {
          systemInstruction: `You are the Executive Producer of Dispatch, a premier personalized commute audio newsroom and research notebook.
${toneDescriptions[preferences.tone] || toneDescriptions.executive}
${voiceToneDescriptions[selectedVoiceTone] || voiceToneDescriptions.professional}
${formatInstructions}
${focusBlock}${introBlock ? `\n${introBlock}` : ''}

STRUCTURAL & CITATION RULES:
1. Create a compelling Edition Title (5-9 words) and a 1-sentence Edition Subtitle.
2. Create 1 segment per major source (keeping each segment roughly 120-260 words for smooth audio synthesis).
3. Include 3 to 5 crisp, high-signal "takeaways". Cite supporting passages inline at the end of key takeaway claims using bracketed numbers like [1], [2], and provide the matching entries in "takeawayCitations" (where sourceIndex is the 1-based SOURCE number and passageIndex is the 1-based P number from [S#-P#]).
4. Inside each segment's spoken "lines", embed 2 to 4 subtle inline citation markers like [1], [2] right after major factual claims, and populate that segment's "citations" array (starting markers at 1 per segment) mapping each marker to the exact sourceIndex, passageIndex, and a brief verbatim excerpt from that passage. (Our TTS engine automatically strips [1] markers when recording voice audio, so listeners get both clean audio and clickable transcript citations.)
5. Strictly ground all facts, figures, names, and claims in the provided sources—never invent statistics or events not present in the sources.
6. Whenever a source includes USER-HIGHLIGHTED PASSAGES, treat those listener-highlighted phrases, quotes, and numbers as top-priority reference signals: explicitly weave their core insights into the corresponding segment's spoken script and executive takeaways, and cite their matching [S#-P#] passage markers.`,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              editionTitle: { type: Type.STRING },
              editionSubtitle: { type: Type.STRING },
              takeaways: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              takeawayCitations: {
                type: Type.ARRAY,
                items: citationSchemaItem,
              },
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    category: { type: Type.STRING },
                    sourceTitles: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                    keyPoint: { type: Type.STRING },
                    estimatedSeconds: { type: Type.INTEGER },
                    lines: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          speaker: { type: Type.STRING },
                          text: { type: Type.STRING },
                        },
                        required: ['speaker', 'text'],
                      },
                    },
                    citations: {
                      type: Type.ARRAY,
                      items: citationSchemaItem,
                    },
                  },
                  required: [
                    'title',
                    'category',
                    'sourceTitles',
                    'keyPoint',
                    'estimatedSeconds',
                    'lines',
                    'citations',
                  ],
                },
              },
            },
            required: [
              'editionTitle',
              'editionSubtitle',
              'takeaways',
              'takeawayCitations',
              'segments',
            ],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '{}').trim());
    const segments = Array.isArray(parsed.segments)
      ? parsed.segments.map((seg: Record<string, unknown>, idx: number) => ({
          id: `seg-${Date.now()}-${idx}`,
          title: String(seg.title || `Chapter ${idx + 1}`),
          category: String(seg.category || 'Briefing'),
          sourceTitles: Array.isArray(seg.sourceTitles) ? seg.sourceTitles.map(String) : [],
          keyPoint: String(seg.keyPoint || ''),
          estimatedSeconds: Math.max(20, Number(seg.estimatedSeconds) || 75),
          lines: Array.isArray(seg.lines)
            ? (seg.lines as Array<Record<string, unknown>>).map((l) => ({
                speaker:
                  preferences.format === 'podcast'
                    ? String(l.speaker) === 'Sam'
                      ? 'Sam'
                      : 'Alex'
                    : 'Anchor',
                text: String(l.text || '').trim(),
              }))
            : [],
          citations: resolveCitations(seg.citations, articles),
        }))
      : [];

    // Ensure custom personalized introduction opens the briefing script deterministically
    if (customIntroduction && segments.length > 0) {
      const leadSpeaker = preferences.format === 'podcast' ? 'Alex' : 'Anchor';
      const firstSeg = segments[0];
      const firstLineText = (firstSeg.lines[0]?.text || '').trim().toLowerCase();
      const introProbe = customIntroduction
        .toLowerCase()
        .slice(0, Math.min(48, customIntroduction.length));
      if (!firstLineText.includes(introProbe)) {
        firstSeg.lines = [
          { speaker: leadSpeaker, text: customIntroduction },
          ...firstSeg.lines,
        ];
      }
    }

    res.json({
      briefing: {
        editionTitle: String(parsed.editionTitle || 'Morning Commute Briefing'),
        editionSubtitle: String(parsed.editionSubtitle || 'Your tailored audio digest.'),
        takeaways: Array.isArray(parsed.takeaways) ? parsed.takeaways.map(String) : [],
        takeawayCitations: resolveCitations(parsed.takeawayCitations, articles),
        segments,
      },
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
      res.status(status).json({ error: message });
    }
  });

// 2B. Synthesize a cross-article meta-briefing summary from collected user highlights
app.post('/api/highlights/summarize', async (req, res) => {
  try {
    const { articles, listenerFocus, tone } = req.body as {
      articles?: IncomingArticle[];
      listenerFocus?: string;
      tone?: string;
    };

    const highlightedArticles = (Array.isArray(articles) ? articles : []).filter(
      (a) =>
        Array.isArray(a.highlights) &&
        a.highlights.some((h) => String(h?.text || '').trim().length >= 2)
    );

    if (highlightedArticles.length === 0) {
      res.status(400).json({
        error:
          'Highlight at least one phrase inside an article snippet to generate a meta-briefing summary.',
      });
      return;
    }

    let totalHighlightCount = 0;
    const dossierBlocks = highlightedArticles.map((a, idx) => {
      const sNum = idx + 1;
      const passages =
        Array.isArray(a.passages) && a.passages.length > 0
          ? a.passages
          : buildPassages(a.id, a.content || a.summary);

      const matchedPassageIndices = new Set<number>();
      const highlightLines = (Array.isArray(a.highlights) ? a.highlights : [])
        .map((h) => {
          const text = String(h?.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
          if (text.length < 2) return null;
          let pIdx = Number(h?.passageIndex) || 0;
          if (pIdx < 1 || pIdx > passages.length) {
            const matched = passages.find((p) =>
              p.text.replace(/\s+/g, ' ').toLowerCase().includes(text.toLowerCase())
            );
            pIdx = matched ? matched.index : 1;
          }
          matchedPassageIndices.add(pIdx);
          return `- [S${sNum}-P${pIdx}] "${text}"`;
        })
        .filter((line): line is string => Boolean(line))
        .slice(0, 20);

      totalHighlightCount += highlightLines.length;

      const contextPassages = passages
        .filter((p) => matchedPassageIndices.has(p.index) || p.index <= 2)
        .slice(0, 8)
        .map((p) => `[S${sNum}-P${p.index}] ${p.text}`)
        .join('\n');

      return `SOURCE ${sNum}:
Title: ${a.title}
Origin: ${a.source} (${a.sourceType || 'article'} · ${a.category})
Article Summary: ${a.summary}
COLLECTED USER HIGHLIGHTS:
${highlightLines.join('\n')}
Supporting Passages:
${contextPassages}`;
    });

    const ai = getGeminiClient();
    const focusInstruction =
      typeof listenerFocus === 'string' && listenerFocus.trim()
        ? `LISTENER ANGLE: "${listenerFocus.trim()}". Emphasize connections and implications relevant to this angle.`
        : 'LISTENER ANGLE: Synthesize overarching patterns, tensions, quantitative evidence, and strategic implications across the collected highlights.';
    const toneLabel =
      typeof tone === 'string' && tone.trim() ? tone.trim() : 'executive';

    const citationSchemaItem = {
      type: Type.OBJECT,
      properties: {
        marker: { type: Type.INTEGER },
        sourceIndex: { type: Type.INTEGER },
        passageIndex: { type: Type.INTEGER },
        excerpt: { type: Type.STRING },
      },
      required: ['marker', 'sourceIndex', 'passageIndex', 'excerpt'],
    };

    const response = await withTextModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: `Synthesize a cohesive meta-briefing summary from ${totalHighlightCount} user-collected highlights across ${highlightedArticles.length} ${
          highlightedArticles.length === 1 ? 'source' : 'sources'
        }.\n\n${dossierBlocks.join('\n\n---\n\n')}`,
        config: {
          systemInstruction: `You are the Chief Research Editor of Dispatch. The reader has curated specific highlighted passages across their reading queue and wants a synthesized Meta-Briefing Summary.
TONE: ${toneLabel} — crisp, high-signal newsroom prose with zero filler.
${focusInstruction}

SYNTHESIS & CITATION RULES:
1. Create a sharp editorial "title" (5-10 words) and a 1-sentence "subtitle" capturing the unifying thesis across the highlights.
2. Write "executiveOverview" as 2 concise paragraphs (separated by "\\n\\n", ~120-200 words total) synthesizing how the highlighted passages connect, corroborate, or contrast with one another.
3. Produce 2 to 4 thematic threads in "themes", each with a concise "heading", a 2-3 sentence "synthesis", and "sourceTitles" listing the source titles contributing to that theme.
4. Produce 3 to 5 crisp, actionable "keyTakeaways" grounded directly in the highlighted passages.
5. Embed numbered inline citation markers like [1], [2], [3] (using a single unified numbering sequence across executiveOverview, themes, and keyTakeaways starting at [1]) immediately after claims and figures, and map every marker in "citations" using the 1-based SOURCE number ("sourceIndex"), 1-based P number ("passageIndex") from [S#-P#], and a brief verbatim "excerpt".
6. Never invent facts, numbers, or claims outside the provided highlights and supporting passages.`,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              subtitle: { type: Type.STRING },
              executiveOverview: { type: Type.STRING },
              themes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    heading: { type: Type.STRING },
                    synthesis: { type: Type.STRING },
                    sourceTitles: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                  },
                  required: ['heading', 'synthesis', 'sourceTitles'],
                },
              },
              keyTakeaways: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              citations: {
                type: Type.ARRAY,
                items: citationSchemaItem,
              },
            },
            required: [
              'title',
              'subtitle',
              'executiveOverview',
              'themes',
              'keyTakeaways',
              'citations',
            ],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '{}').trim()) as Record<string, unknown>;
    const themes = Array.isArray(parsed.themes)
      ? (parsed.themes as Array<Record<string, unknown>>)
          .map((t) => ({
            heading: String(t?.heading || '').trim(),
            synthesis: String(t?.synthesis || '').trim(),
            sourceTitles: Array.isArray(t?.sourceTitles)
              ? t.sourceTitles.map(String).filter(Boolean)
              : [],
          }))
          .filter((t) => t.heading && t.synthesis)
      : [];

    const keyTakeaways = Array.isArray(parsed.keyTakeaways)
      ? parsed.keyTakeaways.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    res.json({
      metaSummary: {
        id: `meta_${Date.now().toString(36)}`,
        createdAt: new Date().toISOString(),
        title: String(parsed.title || 'Highlights Meta-Briefing Summary').trim(),
        subtitle: String(
          parsed.subtitle ||
            `Synthesized from ${totalHighlightCount} highlighted passages across ${highlightedArticles.length} sources.`
        ).trim(),
        executiveOverview: String(parsed.executiveOverview || '').trim(),
        themes,
        keyTakeaways,
        citations: resolveCitations(parsed.citations, highlightedArticles),
        sourceCount: highlightedArticles.length,
        highlightCount: totalHighlightCount,
        sourceTitles: highlightedArticles.map((a) => a.title),
      },
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

// 3. Refine a briefing script or single chapter with gemini-4-hydrogen
app.post('/api/briefings/refine', async (req, res) => {
  try {
    const { segments, format, instruction, targetSegmentId } = req.body as {
      segments: Array<{
        id: string;
        title: string;
        category: string;
        sourceTitles: string[];
        keyPoint: string;
        estimatedSeconds: number;
        lines: ScriptLine[];
        citations?: ResolvedCitation[];
      }>;
      format: 'solo' | 'podcast';
      instruction: string;
      targetSegmentId?: string;
    };

    if (!instruction?.trim() || !Array.isArray(segments) || segments.length === 0) {
      res.status(400).json({ error: 'Provide segments and a refinement instruction.' });
      return;
    }

    const ai = getGeminiClient();
    const scopeSegments = targetSegmentId
      ? segments.filter((s) => s.id === targetSegmentId)
      : segments;

    const speakerRule =
      format === 'podcast'
        ? 'Preserve two-speaker podcast dialogue using strictly "Alex" and "Sam" as speaker names.'
        : 'Preserve single-speaker broadcast format using strictly "Anchor" as the speaker name.';

    const response = await withTextModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: `Rewrite the following audio briefing segment(s) according to this editorial note: "${instruction.trim()}"\n\nCurrent segments JSON:\n${JSON.stringify(scopeSegments, null, 2)}`,
        config: {
          systemInstruction: `You are a senior radio script editor refining a commute audio briefing. Keep exact segment IDs, preserve existing inline citation markers like [1], [2] where claims remain, improve spoken rhythm, and follow the user's editorial instruction precisely. ${speakerRule}`,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    title: { type: Type.STRING },
                    category: { type: Type.STRING },
                    sourceTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
                    keyPoint: { type: Type.STRING },
                    estimatedSeconds: { type: Type.INTEGER },
                    lines: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          speaker: { type: Type.STRING },
                          text: { type: Type.STRING },
                        },
                        required: ['speaker', 'text'],
                      },
                    },
                  },
                  required: ['id', 'title', 'category', 'keyPoint', 'estimatedSeconds', 'lines'],
                },
              },
            },
            required: ['segments'],
          },
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '{}').trim());
    const updatedMap = new Map<string, Record<string, unknown>>();
    if (Array.isArray(parsed.segments)) {
      for (const s of parsed.segments) {
        updatedMap.set(String(s.id), s);
      }
    }

    const merged = segments.map((orig) => {
      const u = updatedMap.get(orig.id);
      if (!u) return orig;
      return {
        ...orig,
        title: String(u.title || orig.title),
        keyPoint: String(u.keyPoint || orig.keyPoint),
        estimatedSeconds: Math.max(15, Number(u.estimatedSeconds) || orig.estimatedSeconds),
        lines: Array.isArray(u.lines)
          ? (u.lines as Array<Record<string, unknown>>).map((l) => ({
              speaker:
                format === 'podcast'
                  ? String(l.speaker) === 'Sam'
                    ? 'Sam'
                    : 'Alex'
                  : 'Anchor',
              text: String(l.text || '').trim(),
            }))
          : orig.lines,
      };
    });

    res.json({ segments: merged });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

// 4. Synthesize speech using gemini-3.8-flash-tts (automatically strips [1] citation markers)
app.post('/api/tts/synthesize', async (req, res) => {
  try {
    const {
      format = 'solo',
      lines,
      text,
      voiceName = 'Kore',
      coHostVoiceName = 'Puck',
      tone = 'executive',
      voiceTone,
    } = req.body as {
      format?: 'solo' | 'podcast';
      lines?: ScriptLine[];
      text?: string;
      voiceName?: string;
      coHostVoiceName?: string;
      tone?: string;
      voiceTone?: string;
    };

    const allowedVoices = new Set(['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr']);
    const primaryVoice = allowedVoices.has(voiceName) ? voiceName : 'Kore';
    const secondaryVoice = allowedVoices.has(coHostVoiceName)
      ? coHostVoiceName === primaryVoice
        ? primaryVoice === 'Kore'
          ? 'Puck'
          : 'Kore'
        : coHostVoiceName
      : primaryVoice === 'Kore'
        ? 'Puck'
        : 'Kore';

    const styleByTone: Record<string, { solo: string; alex: string; sam: string }> = {
      executive: {
        solo: 'Authoritative, poised morning radio news anchor with crisp articulation and measured cadence',
        alex: 'Poised, incisive lead news host with clear studio broadcast delivery',
        sam: 'Thoughtful, articulate senior correspondent with calm analytical warmth',
      },
      conversational: {
        solo: 'Warm, engaging daily news podcast narrator speaking clearly to a commuter',
        alex: 'Warm, curious podcast host with natural conversational rhythm',
        sam: 'Insightful, relaxed co-host with expressive clarity and friendly energy',
      },
      analytical: {
        solo: 'Measured, documentary-style financial and policy commentator with steady authority',
        alex: 'Sharp editorial moderator guiding a deep analytical discussion',
        sam: 'Subject-matter expert explaining complex trends with precision and gravitas',
      },
      upbeat: {
        solo: 'Bright, energetic morning commute host with lively pacing and crisp diction',
        alex: 'Upbeat, bright morning briefing host with brisk, welcoming energy',
        sam: 'Enthusiastic, clever co-host bringing lively perspective and momentum',
      },
    };

    const styleByVoiceTone: Record<string, { solo: string; alex: string; sam: string }> = {
      professional: {
        solo: 'Crisp, composed, authoritative broadcast news anchor with clean studio diction and poised cadence',
        alex: 'Polished, professional lead studio anchor with crisp articulation and balanced broadcast pacing',
        sam: 'Composed, authoritative senior correspondent speaking with sharp clarity and steady studio presence',
      },
      casual: {
        solo: 'Relaxed, friendly, approachable podcast narrator speaking naturally like a well-informed friend',
        alex: 'Casual, warm, easygoing podcast host with natural everyday conversational flow',
        sam: 'Laid-back, witty, friendly co-host sharing insights with relaxed conversational warmth',
      },
      energetic: {
        solo: 'Upbeat, lively, dynamic morning broadcast host with bright energy, expressive emphasis, and brisk pace',
        alex: 'Energetic, enthusiastic lead host driving a fast-moving, vibrant morning show with bright vocal spark',
        sam: 'Lively, animated co-host with high energy, quick wit, and engaging dynamic vocal inflection',
      },
      soothing: {
        solo: 'Calm, gentle, unhurried late-evening narrator with soft warm vocal tone, peaceful cadence, and comforting clarity',
        alex: 'Soothing, calm, gentle host with a warm hushed studio voice and unhurried peaceful delivery',
        sam: 'Serene, gentle, reassuring co-host speaking softly with calm warmth and smooth relaxing rhythm',
      },
    };

    const selectedStyle =
      (voiceTone && styleByVoiceTone[voiceTone]) ||
      styleByTone[tone] ||
      styleByVoiceTone.professional;
    const ai = getGeminiClient();

    if (format === 'podcast' && Array.isArray(lines) && lines.length > 0) {
      const cleanedLines = lines
        .map((l) => ({
          speaker: l.speaker === 'Sam' ? 'Sam' : 'Alex',
          text: stripCitationMarkers(l.text || ''),
        }))
        .filter((l) => l.text.length > 0);

      if (cleanedLines.length === 0) {
        res.status(400).json({ error: 'No dialogue lines provided for synthesis.' });
        return;
      }

      const parts = cleanedLines.map((line) => ({
        text: `${line.speaker}: ${line.text}`,
        speechMetadata: {
          speaker: line.speaker,
          style: line.speaker === 'Alex' ? selectedStyle.alex : selectedStyle.sam,
        },
      }));

      const response = await withTtsModelFallback(async (ttsModel) => {
        try {
          return await ai.models.generateContent({
            model: ttsModel,
            contents: [
              {
                role: 'user',
                parts,
              },
            ],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                multiSpeakerVoiceConfig: {
                  speakerVoiceConfigs: [
                    {
                      speaker: 'Alex',
                      voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: primaryVoice },
                      },
                    },
                    {
                      speaker: 'Sam',
                      voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: secondaryVoice },
                      },
                    },
                  ],
                },
              },
            },
          });
        } catch (ttsErr) {
          const msg = ttsErr instanceof Error ? ttsErr.message : String(ttsErr);
          if (ttsModel === 'gemini-3.8-flash-lite-tts' && msg.includes('400')) {
            const combinedDialogue = cleanedLines
              .map((l) => `${l.speaker}: ${l.text}`)
              .join('\n\n');
            return await ai.models.generateContent({
              model: ttsModel,
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: combinedDialogue,
                      speechMetadata: { style: selectedStyle.solo },
                    },
                  ],
                },
              ],
              config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: primaryVoice },
                  },
                },
              },
            });
          }
          throw ttsErr;
        }
      });

      const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inlineData?.data) {
        res.status(502).json({ error: 'Gemini TTS did not return audio data. Please try again.' });
        return;
      }

      res.json({
        audioBase64: inlineData.data,
        mimeType: inlineData.mimeType || 'audio/wav',
      });
      return;
    }

    const fullText = stripCitationMarkers(
      text?.trim() ||
        (Array.isArray(lines)
          ? lines
              .map((l) => l.text.trim())
              .filter(Boolean)
              .join('\n\n')
          : '')
    );

    if (!fullText) {
      res.status(400).json({ error: 'No script text provided for speech synthesis.' });
      return;
    }

    const response = await withTtsModelFallback((ttsModel) =>
      ai.models.generateContent({
        model: ttsModel,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: fullText,
                speechMetadata: {
                  style: selectedStyle.solo,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: primaryVoice },
            },
          },
        },
      })
    );

    const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inlineData?.data) {
      res.status(502).json({ error: 'Gemini TTS did not return audio data. Please try again.' });
      return;
    }

    res.json({
      audioBase64: inlineData.data,
      mimeType: inlineData.mimeType || 'audio/wav',
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

// 5. Multi-turn News & Research Editor Chatbot with clickable Notebook-style citations
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, articles, briefingTitle, briefingTakeaways } = req.body as {
      messages: Array<{ role: 'user' | 'model'; text: string }>;
      articles: IncomingArticle[];
      briefingTitle?: string;
      briefingTakeaways?: string[];
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Message history cannot be empty.' });
      return;
    }

    const latest = messages[messages.length - 1];
    if (!latest || latest.role !== 'user' || !latest.text.trim()) {
      res.status(400).json({ error: 'The latest message must be a non-empty user prompt.' });
      return;
    }

    const ai = getGeminiClient();
    const safeArticles = Array.isArray(articles) ? articles : [];

    const sourcesContext =
      safeArticles.length > 0
        ? buildIndexedSourcesPrompt(safeArticles)
        : 'No sources are currently selected.';

    const briefingContext = briefingTitle
      ? `\nCURRENT AUDIO BRIEFING: "${briefingTitle}"\nTakeaways: ${(briefingTakeaways || []).join(' | ')}`
      : '';

    const systemInstruction = `You are the Senior Managing Editor at Dispatch, a Notebook-style audio research studio.
Help the listener unpack, cross-reference, fact-check, and discuss their selected documents and news articles.
- Ground every claim in the numbered passages below ([S1-P1], [S2-P3], etc.).
- Embed inline bracketed citation numbers like [1], [2] immediately after claims backed by a source passage, and list each cited passage in the "citations" array (marker starting at 1, sourceIndex matching SOURCE #, passageIndex matching P#, and a short verbatim excerpt).
- If the user asks something beyond the provided sources, state clearly what is outside the current sources.
- Keep replies crisp, clear, and pleasant both to scan and to listen to aloud.

ACTIVE SOURCES:
${sourcesContext}${briefingContext}`;

    const history = messages.slice(0, -1).map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    }));

    const response = await withTextModelFallback(async (model) => {
      const chat = ai.chats.create({
        model,
        history,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              reply: { type: Type.STRING },
              citations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    marker: { type: Type.INTEGER },
                    sourceIndex: { type: Type.INTEGER },
                    passageIndex: { type: Type.INTEGER },
                    excerpt: { type: Type.STRING },
                  },
                  required: ['marker', 'sourceIndex', 'passageIndex', 'excerpt'],
                },
              },
            },
            required: ['reply', 'citations'],
          },
        },
      });

      return chat.sendMessage({
        message: latest.text.trim(),
      });
    });

    const rawText = (response.text ?? '').trim();
    try {
      const parsed = JSON.parse(rawText);
      const reply = String(parsed.reply || rawText);
      const citations = resolveCitations(parsed.citations, safeArticles);
      res.json({ reply, citations });
    } catch {
      res.json({
        reply: rawText || 'I could not generate a response for that question.',
        citations: [],
      });
    }
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

// 6. Temporary cloud-hosted public sharing for audio briefings
app.post('/api/shares', optionalAuth, async (req: AuthRequest, res) => {
  try {
    const { briefing, ttlHours = 72 } = req.body as {
      briefing?: {
        editionTitle?: string;
        editionSubtitle?: string;
        createdAt?: string;
        takeaways?: string[];
        preferences?: BriefingPreferences & {
          dynamicPanel?: boolean;
          segmentCoHostVoices?: Record<string, string>;
        };
        articleTitles?: string[];
        segments?: Array<{
          id?: string;
          title?: string;
          category?: string;
          sourceTitles?: string[];
          keyPoint?: string;
          estimatedSeconds?: number;
          audioDurationSeconds?: number;
          lines?: ScriptLine[];
          coHostVoiceName?: string;
          audioBase64?: string;
        }>;
      };
      ttlHours?: number;
    };

    if (!briefing || !Array.isArray(briefing.segments) || briefing.segments.length === 0) {
      res.status(400).json({ error: 'Provide a valid briefing with at least one chapter to share.' });
      return;
    }

    const safeTtlHours = ALLOWED_SHARE_TTL_HOURS.has(Number(ttlHours)) ? Number(ttlHours) : 72;
    const shareId = crypto.randomBytes(6).toString('base64url');
    const shareDir = path.join(SHARE_ROOT_DIR, shareId);
    await fs.mkdir(shareDir, { recursive: true });

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + safeTtlHours * 3600 * 1000).toISOString();

    let recordedChapters = 0;
    let totalDurationSeconds = 0;
    const storedSegments: StoredShareSegment[] = [];

    for (let i = 0; i < briefing.segments.length; i++) {
      const seg = briefing.segments[i];
      let hasAudio = false;

      if (typeof seg.audioBase64 === 'string' && seg.audioBase64.length > 64) {
        try {
          const wavBuf = Buffer.from(seg.audioBase64, 'base64');
          if (wavBuf.length >= 44) {
            await fs.writeFile(path.join(shareDir, `seg-${i}.wav`), wavBuf);
            hasAudio = true;
            recordedChapters += 1;
          }
        } catch {
          hasAudio = false;
        }
      }

      const segDur = Math.max(
        10,
        Math.round(seg.audioDurationSeconds || seg.estimatedSeconds || 60)
      );
      totalDurationSeconds += segDur;

      storedSegments.push({
        id: String(seg.id || `seg-${i + 1}`),
        title: String(seg.title || `Chapter ${i + 1}`),
        category: String(seg.category || 'News'),
        sourceTitles: Array.isArray(seg.sourceTitles) ? seg.sourceTitles.map(String) : [],
        keyPoint: String(seg.keyPoint || ''),
        estimatedSeconds: Math.max(10, Math.round(seg.estimatedSeconds || 60)),
        audioDurationSeconds: seg.audioDurationSeconds
          ? Math.round(seg.audioDurationSeconds)
          : undefined,
        lines: Array.isArray(seg.lines)
          ? seg.lines.map((l) => ({
              speaker: String(l?.speaker || 'Anchor'),
              text: stripCitationMarkers(String(l?.text || '')),
            }))
          : [],
        coHostVoiceName: seg.coHostVoiceName ? String(seg.coHostVoiceName) : undefined,
        hasAudio,
        audioUrl: hasAudio ? `/api/shares/${shareId}/audio/${i}` : undefined,
      });
    }

    const hasAudio = recordedChapters > 0;
    const manageToken = crypto.randomBytes(18).toString('base64url');
    const manifest: StoredShareManifest = {
      shareId,
      createdAt,
      expiresAt,
      ttlHours: safeTtlHours,
      editionTitle: String(briefing.editionTitle || 'Shared Audio Briefing'),
      editionSubtitle: String(briefing.editionSubtitle || ''),
      briefingCreatedAt: String(briefing.createdAt || createdAt),
      takeaways: Array.isArray(briefing.takeaways)
        ? briefing.takeaways.map((t) => stripCitationMarkers(String(t)))
        : [],
      preferences: briefing.preferences || {
        durationMinutes: 5,
        format: 'podcast',
        tone: 'executive',
        voiceTone: 'professional',
        voiceName: 'Kore',
        coHostVoiceName: 'Puck',
        listenerFocus: '',
      },
      articleTitles: Array.isArray(briefing.articleTitles)
        ? briefing.articleTitles.map(String)
        : [],
      segments: storedSegments,
      hasAudio,
      recordedChapters,
      totalDurationSeconds,
      downloadUrl: hasAudio ? `/api/shares/${shareId}/download` : undefined,
      creatorUid: req.user?.uid,
      creatorEmail: req.user?.email,
      manageToken,
    };

    await fs.writeFile(
      path.join(shareDir, 'manifest.json'),
      JSON.stringify(manifest),
      'utf8'
    );

    // Opportunistic expired-link cleanup in background
    cleanupExpiredShares().catch(() => {});

    if (req.user?.uid) {
      const tokenMeta = extractTokenAuthMetadata(req.user);
      getOrCreateUser(
        req.user.uid,
        req.user.email || `${req.user.uid}@dispatch.local`,
        typeof req.user.name === 'string' ? req.user.name : '',
        typeof req.user.picture === 'string' ? req.user.picture : '',
        tokenMeta.emailVerified,
        {
          authProvider: tokenMeta.authProvider,
          tokenAuthTimeSec: tokenMeta.tokenAuthTimeSec,
          clientContext: describeClientContext(req),
        }
      )
        .then((u) =>
          recordUserActivityLog({
            userId: u.id,
            actorEmail: u.email,
            actorName: u.displayName,
            actorRole: u.role,
            category: 'share',
            action: 'share.created',
            summary: `Created public Audio Briefing link /share/${shareId} ("${manifest.editionTitle}")`,
            resourceType: 'briefing_share',
            resourceId: shareId,
            authStatus: tokenMeta.emailVerified ? 'verified' : 'unverified',
            clientContext: describeClientContext(req),
            metadata: {
              operation: 'create_share',
              shareKind: 'briefing',
              shareId,
              title: manifest.editionTitle,
              ttlHours: safeTtlHours,
              expiresAt,
              hasAudio,
              recordedChapters,
            },
          })
        )
        .catch(() => {});
    }

    res.status(201).json({
      shareId,
      sharePath: `/share/${shareId}`,
      createdAt,
      expiresAt,
      ttlHours: safeTtlHours,
      hasAudio,
      recordedChapters,
      totalChapters: storedSegments.length,
      totalDurationSeconds,
      manageToken,
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

app.get('/api/shares/:shareId', async (req, res) => {
  const result = await readValidShareManifest(req.params.shareId);
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'This shared briefing link was not found or has been revoked.' });
    return;
  }
  if (result.status === 'expired') {
    res.status(410).json({
      error: 'This temporary briefing link has expired.',
      expired: true,
    });
    return;
  }
  res.json({ share: stripInternalShareSecrets(result.manifest) });
});

app.get('/api/shares/:shareId/audio/:segmentIndex', async (req, res) => {
  const result = await readValidShareManifest(req.params.shareId);
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'Shared briefing not found.' });
    return;
  }
  if (result.status === 'expired') {
    res.status(410).json({ error: 'Shared briefing link has expired.' });
    return;
  }

  const idx = Number(req.params.segmentIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= result.manifest.segments.length) {
    res.status(404).json({ error: 'Audio chapter not found.' });
    return;
  }

  const wavPath = path.join(result.dir, `seg-${idx}.wav`);
  try {
    const stat = await fs.stat(wavPath);
    const totalSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        const start = Math.min(Number(match[1]), totalSize - 1);
        const end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;
        const chunkSize = end - start + 1;
        const handle = await fs.open(wavPath, 'r');
        const slice = Buffer.alloc(chunkSize);
        await handle.read(slice, 0, chunkSize, start);
        await handle.close();

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'audio/wav',
          'Cache-Control': 'private, max-age=3600',
        });
        res.end(slice);
        return;
      }
    }

    const fullBuf = await fs.readFile(wavPath);
    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': fullBuf.length,
      'Content-Type': 'audio/wav',
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(fullBuf);
  } catch {
    res.status(404).json({ error: 'Audio recording not found for this chapter.' });
  }
});

app.get('/api/shares/:shareId/download', async (req, res) => {
  const result = await readValidShareManifest(req.params.shareId);
  if (result.status !== 'ok') {
    res.status(result.status === 'expired' ? 410 : 404).json({
      error:
        result.status === 'expired'
          ? 'This temporary briefing link has expired.'
          : 'Shared briefing not found.',
    });
    return;
  }

  const buffers: Buffer[] = [];
  for (let i = 0; i < result.manifest.segments.length; i++) {
    if (!result.manifest.segments[i].hasAudio) continue;
    try {
      const buf = await fs.readFile(path.join(result.dir, `seg-${i}.wav`));
      buffers.push(buf);
    } catch {
      // Skip missing chapter audio
    }
  }

  const stitched = stitchServerWavBuffers(buffers);
  if (!stitched) {
    res.status(404).json({ error: 'No recorded audio available to download for this episode.' });
    return;
  }

  const safeSlug = result.manifest.editionTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', stitched.length);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="dispatch-${safeSlug || 'briefing'}.wav"`
  );
  res.end(stitched);
});

app.delete('/api/shares/:shareId', optionalAuth, async (req: AuthRequest, res) => {
  const { shareId } = req.params;
  if (!SHARE_ID_PATTERN.test(shareId)) {
    res.status(400).json({ error: 'Invalid share identifier.' });
    return;
  }
  const existing = await readValidShareManifest(shareId);
  if (existing.status !== 'ok') {
    res.json({ revoked: true });
    return;
  }
  const allowed = await canManageShare(req, existing.manifest);
  if (!allowed) {
    res.status(403).json({
      error:
        'Forbidden: Only the creator of this link or a Studio Owner/Admin can revoke it.',
    });
    return;
  }
  await fs.rm(existing.dir, { recursive: true, force: true }).catch(() => {});
  if (req.user?.email) {
    void recordUserActivityLog({
      actorEmail: req.user.email,
      actorName: typeof req.user.name === 'string' ? req.user.name : '',
      actorRole: isVerifiedPrincipalToken(req.user) ? 'owner' : 'member',
      category: 'share',
      action: 'share.revoked',
      summary: `Revoked Audio Briefing share link /share/${shareId}`,
      resourceType: 'briefing_share',
      resourceId: shareId,
      authStatus: req.user.email_verified ? 'verified' : 'unverified',
      clientContext: describeClientContext(req),
      metadata: {
        operation: 'revoke_share',
        shareKind: 'briefing',
        shareId,
        title: existing.manifest.editionTitle,
      },
    });
  }
  res.json({ revoked: true });
});

// 7. Site Mockup Workbench: Collect real HTML/CSS brand color signals & Gemini brand extraction
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_SWATCH_ROLES = new Set(['primary', 'accent', 'surface', 'neutral']);

interface RawSiteColorSignals {
  themeColor: string | null;
  cssVariables: string[];
  rankedHexColors: string[];
  stylesheetsFetched: number;
}

interface SanitizedBrandSwatch {
  hex: string;
  name: string;
  role: 'primary' | 'accent' | 'surface' | 'neutral';
  usageNote: string;
}

function expandHexColor(raw: string): string | null {
  const clean = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `#${clean.toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return `#${clean
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase()}`;
  }
  return null;
}

function rgbStringToHex(rStr: string, gStr: string, bStr: string): string | null {
  const r = Number(rStr);
  const g = Number(gStr);
  const b = Number(bStr);
  if (
    !Number.isFinite(r) ||
    !Number.isFinite(g) ||
    !Number.isFinite(b) ||
    r < 0 ||
    r > 255 ||
    g < 0 ||
    g > 255 ||
    b < 0 ||
    b > 255
  ) {
    return null;
  }
  const toByte = (v: number) => Math.round(v).toString(16).padStart(2, '0').toUpperCase();
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function extractColorTokensFromCss(cssText: string, counts: Map<string, number>, cssVars: string[]) {
  // Capture named CSS custom properties that reference colors (e.g. --brand-primary: #1E3A5F)
  const varRe = /(--[a-zA-Z0-9_-]{2,40})\s*:\s*(#[0-9a-fA-F]{3,6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}[^)]*\))/gi;
  let vm: RegExpExecArray | null;
  while ((vm = varRe.exec(cssText)) !== null && cssVars.length < 24) {
    const entry = `${vm[1]}: ${vm[2].trim()}`;
    if (!cssVars.includes(entry)) {
      cssVars.push(entry);
    }
  }

  const hexMatches = cssText.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [];
  for (const raw of hexMatches) {
    const hex = expandHexColor(raw);
    if (!hex) continue;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }

  const rgbRe = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\s*\)/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rgbRe.exec(cssText)) !== null) {
    const alpha = rm[4] !== undefined ? Number(rm[4]) : 1;
    if (alpha < 0.25) continue;
    const hex = rgbStringToHex(rm[1], rm[2], rm[3]);
    if (!hex) continue;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
}

function isFlatNeutralGray(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max > 246 && min > 240) return true; // pure white
  if (max < 10) return true; // pure black
  if (max - min < 10 && max > 85 && min < 195) return true; // mid gray
  return false;
}

async function collectSiteColorSignals(parsedUrl: URL, html: string): Promise<RawSiteColorSignals> {
  const counts = new Map<string, number>();
  const cssVars: string[] = [];

  const themeMatch =
    html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,6})["']/i) ||
    html.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,6})["'][^>]+name=["']theme-color["']/i) ||
    html.match(/<meta[^>]+name=["']msapplication-TileColor["'][^>]+content=["'](#[0-9a-fA-F]{3,6})["']/i);
  const themeColor = themeMatch?.[1] ? expandHexColor(themeMatch[1]) : null;
  if (themeColor) {
    counts.set(themeColor, (counts.get(themeColor) || 0) + 8);
  }

  // Inline <style> blocks and inline style attributes
  const styleBlocks = html.match(/<style[\s\S]*?<\/style>/gi) || [];
  const inlineStyles = html.match(/style=["'][^"']+["']/gi) || [];
  extractColorTokensFromCss(
    `${styleBlocks.join('\n')}\n${inlineStyles.join('\n')}`,
    counts,
    cssVars
  );

  // Discover up to 2 external CSS stylesheets (skip font CDNs)
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  const cssUrls: string[] = [];
  for (const tag of linkTags) {
    if (!/rel=["'][^"']*stylesheet[^"']*["']/i.test(tag)) continue;
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch?.[1]) continue;
    const href = hrefMatch[1].trim();
    if (/fonts\.googleapis|fontawesome|cdnjs\.cloudflare\.com\/ajax\/libs\/font/i.test(href)) {
      continue;
    }
    try {
      const resolved = new URL(href, parsedUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        const str = resolved.toString();
        if (!cssUrls.includes(str)) cssUrls.push(str);
      }
    } catch {
      // Ignore malformed href
    }
    if (cssUrls.length >= 2) break;
  }

  let stylesheetsFetched = 0;
  if (cssUrls.length > 0) {
    const cssResults = await Promise.allSettled(
      cssUrls.map(async (cssUrl) => {
        const resp = await fetch(cssUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Accept: 'text/css,*/*;q=0.1',
          },
          signal: AbortSignal.timeout(3500),
        });
        if (!resp.ok) return '';
        const text = await resp.text();
        return text.slice(0, 80000);
      })
    );

    for (const r of cssResults) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        stylesheetsFetched += 1;
        extractColorTokensFromCss(r.value, counts, cssVars);
      }
    }
  }

  const rankedAll = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);

  const vividFirst = rankedAll.filter((h) => !isFlatNeutralGray(h));
  const subtleNeutrals = rankedAll.filter((h) => isFlatNeutralGray(h));
  const rankedHexColors = [...vividFirst.slice(0, 12), ...subtleNeutrals.slice(0, 4)];

  if (themeColor && !rankedHexColors.includes(themeColor)) {
    rankedHexColors.unshift(themeColor);
  }

  return {
    themeColor,
    cssVariables: cssVars.slice(0, 18),
    rankedHexColors: rankedHexColors.slice(0, 14),
    stylesheetsFetched,
  };
}

function sanitizeHexColor(val: unknown, fallback: string): string {
  const s = String(val || '').trim();
  const expanded = expandHexColor(s);
  return expanded && HEX_COLOR_RE.test(expanded) ? expanded : fallback;
}

function sanitizeBrandSwatches(
  rawSwatches: unknown,
  fallbackPrimary: string,
  fallbackAccent: string,
  fallbackHexes: string[]
): SanitizedBrandSwatch[] {
  const seen = new Set<string>();
  const result: SanitizedBrandSwatch[] = [];

  if (Array.isArray(rawSwatches)) {
    for (const item of rawSwatches) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const hex = expandHexColor(String(obj.hex || ''));
      if (!hex || seen.has(hex)) continue;
      seen.add(hex);
      const rawRole = String(obj.role || '').toLowerCase().trim();
      const role = ALLOWED_SWATCH_ROLES.has(rawRole)
        ? (rawRole as SanitizedBrandSwatch['role'])
        : result.length === 0
          ? 'primary'
          : result.length === 1
            ? 'accent'
            : 'surface';
      result.push({
        hex,
        name: String(obj.name || `Brand Tone ${result.length + 1}`).trim().slice(0, 36),
        role,
        usageNote: String(obj.usageNote || 'Detected brand colour').trim().slice(0, 110),
      });
      if (result.length >= 6) break;
    }
  }

  // Ensure suggested primary & accent are always represented if model returned fewer
  const guarantees: SanitizedBrandSwatch[] = [
    {
      hex: fallbackPrimary,
      name: 'Brand Primary',
      role: 'primary',
      usageNote: 'Main brand header, hero surface, and anchor sections',
    },
    {
      hex: fallbackAccent,
      name: 'Brand Accent',
      role: 'accent',
      usageNote: 'Call-to-action buttons, highlights, and active links',
    },
  ];
  for (const g of guarantees) {
    if (!seen.has(g.hex) && result.length < 6) {
      seen.add(g.hex);
      result.unshift(g);
    }
  }

  for (const hex of fallbackHexes) {
    if (result.length >= 6) break;
    if (!seen.has(hex)) {
      seen.add(hex);
      result.push({
        hex,
        name: `Site Swatch ${result.length + 1}`,
        role: 'surface',
        usageNote: 'Sampled from website stylesheets',
      });
    }
  }

  return result.slice(0, 6);
}

app.post('/api/mockup/extract-colors', async (req, res) => {
  try {
    const { url } = req.body as { url?: string };
    let normalizedUrl = (url || '').trim();
    if (!normalizedUrl) {
      res.status(400).json({ error: 'Enter a website URL to extract its brand colours.' });
      return;
    }
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Invalid protocol');
      }
    } catch {
      res.status(400).json({ error: 'Enter a valid http or https website URL (e.g. hiscompany.co.uk).' });
      return;
    }

    let pageTitle = '';
    let pageExcerpt = '';
    let signals: RawSiteColorSignals = {
      themeColor: null,
      cssVariables: [],
      rankedHexColors: [],
      stylesheetsFetched: 0,
    };
    let fetchSucceeded = false;

    try {
      const resp = await fetch(parsedUrl.toString(), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(8500),
      });
      if (resp.ok) {
        const html = await resp.text();
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        pageTitle = titleMatch ? stripHtmlToText(titleMatch[1]).slice(0, 140) : '';
        pageExcerpt = stripHtmlToText(html).slice(0, 2600);
        signals = await collectSiteColorSignals(parsedUrl, html);
        fetchSucceeded = true;
      }
    } catch {
      // Fallback to Google Search grounding below if site blocks server fetches
    }

    const ai = getGeminiClient();
    const swatchSchema = {
      type: Type.OBJECT,
      properties: {
        brandName: { type: Type.STRING },
        suggestedPrimary: { type: Type.STRING },
        suggestedAccent: { type: Type.STRING },
        suggestedCanvasMode: { type: Type.STRING },
        swatches: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              hex: { type: Type.STRING },
              name: { type: Type.STRING },
              role: { type: Type.STRING },
              usageNote: { type: Type.STRING },
            },
            required: ['hex', 'name', 'role', 'usageNote'],
          },
        },
      },
      required: ['brandName', 'suggestedPrimary', 'suggestedAccent', 'suggestedCanvasMode', 'swatches'],
    };

    let parsed: Record<string, unknown>;
    let usedFallback = false;

    if (fetchSucceeded && (signals.rankedHexColors.length > 0 || pageExcerpt.length > 100)) {
      const prompt = [
        `TARGET WEBSITE URL: ${parsedUrl.toString()}`,
        pageTitle ? `PAGE TITLE: ${pageTitle}` : '',
        signals.themeColor ? `META THEME-COLOR: ${signals.themeColor}` : '',
        signals.cssVariables.length > 0
          ? `CSS CUSTOM PROPERTIES FOUND:\n${signals.cssVariables.join('\n')}`
          : '',
        signals.rankedHexColors.length > 0
          ? `TOP DETECTED HEX COLOURS (FREQUENCY RANKED): ${signals.rankedHexColors.join(', ')}`
          : '',
        pageExcerpt ? `PAGE CONTEXT EXCERPT:\n${pageExcerpt}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const response = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Inspect the extracted stylesheet colour tokens and page context below and curate a 5 to 6 colour Brand Swatch Library representing this website's dominant brand identity.\n\n${prompt}`,
          config: {
            systemInstruction:
              'You are a senior brand designer extracting a website’s real visual colour system. Prefer actual detected brand hex codes from the supplied CSS variables, theme-color, and stylesheet tokens over invented ones—filtering out boilerplate utility greys. Return 5 or 6 distinct 6-digit #RRGGBB swatches with concise, evocative colour names (2–3 words, e.g. "Deep Slate Navy", "Signal Amber"), role strictly one of "primary", "accent", "surface", or "neutral", and a crisp 6–12 word usageNote. Pick suggestedPrimary (strong anchor colour), suggestedAccent (high-contrast CTA colour), and suggestedCanvasMode ("light" or "dark").',
            responseMimeType: 'application/json',
            responseSchema: swatchSchema,
          },
        })
      );

      parsed = JSON.parse((response.text ?? '{}').trim());
    } else {
      usedFallback = true;
      const searchResp = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Look up the real brand and website at ${parsedUrl.toString()} and return ONLY a single valid JSON object (no markdown outside JSON) with keys: brandName (string), suggestedPrimary (6-digit #RRGGBB), suggestedAccent (6-digit #RRGGBB), suggestedCanvasMode ("light" or "dark"), and swatches (array of 5 to 6 objects each with hex #RRGGBB, name, role one of "primary"|"accent"|"surface"|"neutral", and short usageNote). Use the business's authentic brand colours and industry palette.`,
          config: {
            tools: [{ googleSearch: {} }],
          },
        })
      );
      parsed = JSON.parse(extractJsonBlock(searchResp.text ?? '{}'));
    }

    const suggestedPrimary = sanitizeHexColor(
      parsed.suggestedPrimary,
      signals.themeColor || signals.rankedHexColors[0] || '#1E3A5F'
    );
    const suggestedAccent = sanitizeHexColor(
      parsed.suggestedAccent,
      signals.rankedHexColors.find((h) => h !== suggestedPrimary) || '#D97706'
    );
    const suggestedCanvasMode = parsed.suggestedCanvasMode === 'dark' ? 'dark' : 'light';
    const swatches = sanitizeBrandSwatches(
      parsed.swatches,
      suggestedPrimary,
      suggestedAccent,
      signals.rankedHexColors
    );

    res.json({
      sourceUrl: parsedUrl.toString(),
      brandName: String(parsed.brandName || pageTitle || parsedUrl.hostname).trim(),
      swatches,
      suggestedPrimary,
      suggestedAccent,
      suggestedCanvasMode,
      usedFallback,
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

function extractSiteFontSignals(html: string): string[] {
  const found = new Set<string>();

  // 1. Detect Google Fonts stylesheet links already referenced on the website
  const gfRegex = /fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = gfRegex.exec(html)) !== null) {
    const query = match[1].replace(/&amp;/g, '&');
    const famRegex = /family=([^&:|;]+)/gi;
    let famMatch: RegExpExecArray | null;
    while ((famMatch = famRegex.exec(query)) !== null) {
      const cleaned = decodeURIComponent(famMatch[1].replace(/\+/g, ' '))
        .split(':')[0]
        .trim();
      if (cleaned && cleaned.length <= 42) {
        found.add(cleaned);
      }
    }
  }

  // 2. Detect explicit font-family declarations in inline style blocks
  const styleBlockRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  const genericKeywords = new Set([
    'sans-serif',
    'serif',
    'monospace',
    'system-ui',
    '-apple-system',
    'blinkmacsystemfont',
    'segoe ui',
    'helvetica',
    'helvetica neue',
    'arial',
    'times new roman',
    'georgia',
    'inherit',
    'initial',
    'ui-sans-serif',
    'ui-serif',
    'ui-monospace',
    'apple color emoji',
    'segoe ui emoji',
  ]);

  while ((match = styleBlockRegex.exec(html)) !== null) {
    const css = match[1];
    const ffRegex = /font-family\s*:\s*([^;}{]+)/gi;
    let ffMatch: RegExpExecArray | null;
    while ((ffMatch = ffRegex.exec(css)) !== null) {
      const firstFamily = ffMatch[1]
        .split(',')[0]
        .replace(/['"!]|important/gi, '')
        .trim();
      if (
        firstFamily &&
        firstFamily.length >= 3 &&
        firstFamily.length <= 42 &&
        !firstFamily.startsWith('var(') &&
        !genericKeywords.has(firstFamily.toLowerCase())
      ) {
        found.add(firstFamily);
      }
    }
  }

  return Array.from(found).slice(0, 8);
}

app.post('/api/mockup/suggest-fonts', async (req, res) => {
  try {
    const { url, brandName, industry } = req.body as {
      url?: string;
      brandName?: string;
      industry?: string;
    };

    let normalizedUrl = (url || '').trim();
    if (!normalizedUrl) {
      res.status(400).json({ error: 'Enter a website URL to suggest Google Font pairings.' });
      return;
    }
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Invalid protocol');
      }
    } catch {
      res.status(400).json({ error: 'Enter a valid http or https website URL (e.g. hiscompany.co.uk).' });
      return;
    }

    let pageTitle = '';
    let pageExcerpt = '';
    let detectedSiteFonts: string[] = [];
    let fetchSucceeded = false;

    try {
      const resp = await fetch(parsedUrl.toString(), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(8500),
      });
      if (resp.ok) {
        const html = await resp.text();
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        pageTitle = titleMatch ? stripHtmlToText(titleMatch[1]).slice(0, 140) : '';
        pageExcerpt = stripHtmlToText(html).slice(0, 2200);
        detectedSiteFonts = extractSiteFontSignals(html);
        fetchSucceeded = true;
      }
    } catch {
      // Fallback to Google Search grounding below if the site blocks server fetch
    }

    const ai = getGeminiClient();
    const fontPairingSchema = {
      type: Type.OBJECT,
      properties: {
        brandName: { type: Type.STRING },
        pairings: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              headingFont: { type: Type.STRING },
              bodyFont: { type: Type.STRING },
              monoFont: { type: Type.STRING },
              headingCategory: { type: Type.STRING },
              bodyCategory: { type: Type.STRING },
              rationale: { type: Type.STRING },
              mood: { type: Type.STRING },
              sourceNote: { type: Type.STRING },
            },
            required: [
              'name',
              'headingFont',
              'bodyFont',
              'monoFont',
              'headingCategory',
              'bodyCategory',
              'rationale',
              'mood',
            ],
          },
        },
      },
      required: ['brandName', 'pairings'],
    };

    const allowedCatalogNote =
      'Use ONLY real, widely available Google Fonts from fonts.google.com (such as Space Grotesk, Plus Jakarta Sans, Outfit, Barlow, Sora, Syne, Archivo, Montserrat, Manrope, Bricolage Grotesque, Fraunces, Playfair Display, Newsreader, Lora, Source Serif 4, Libre Baskerville, Oswald, Inter, DM Sans, Work Sans, Source Sans 3, IBM Plex Sans, Figtree, Rubik, Merriweather, Bitter, Epilogue, Instrument Serif, Instrument Sans, and mono fonts like IBM Plex Mono, JetBrains Mono, Space Mono, Fira Code).';

    let parsed: Record<string, unknown>;
    let usedFallback = false;

    if (fetchSucceeded && (detectedSiteFonts.length > 0 || pageExcerpt.length > 80)) {
      const contextBlock = [
        `TARGET WEBSITE URL: ${parsedUrl.toString()}`,
        pageTitle ? `PAGE TITLE: ${pageTitle}` : '',
        brandName ? `CURRENT MOCKUP BRAND: ${brandName}` : '',
        industry ? `CURRENT MOCKUP INDUSTRY: ${industry}` : '',
        detectedSiteFonts.length > 0
          ? `DETECTED FONT FAMILIES IN SITE HTML/CSS: ${detectedSiteFonts.join(', ')}`
          : 'DETECTED FONT FAMILIES: None explicitly linked in HTML head.',
        pageExcerpt ? `PAGE CONTENT EXCERPT:\n${pageExcerpt}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const response = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Recommend 4 distinct, production-grade Google Font pairings tailored to this website and business identity.\n\n${contextBlock}`,
          config: {
            systemInstruction: `You are a senior typographer and brand designer. ${allowedCatalogNote} Return exactly 4 distinct pairings with varied character (e.g., faithful/upgraded site match, clean modern, editorial/heritage, bold trade/display). If the website already uses a valid Google Font, include an upgraded pairing honoring it as the first option. For each pairing return: name (2–3 words), headingFont (exact Google Fonts family name), bodyFont (exact Google Fonts family name), monoFont (exact Google Fonts mono family name), headingCategory ("sans-serif" | "serif" | "display"), bodyCategory ("sans-serif" | "serif"), mood ("industrial" | "editorial" | "modern"), rationale (crisp 10–18 word explanation why it suits this business), and sourceNote (short 2–4 word origin label like "Matches site font" or "Modern upgrade").`,
            responseMimeType: 'application/json',
            responseSchema: fontPairingSchema,
          },
        })
      );

      parsed = JSON.parse((response.text ?? '{}').trim());
    } else {
      usedFallback = true;
      const searchResp = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Look up the real business website at ${parsedUrl.toString()}${
            brandName ? ` (${brandName})` : ''
          } and return ONLY a single valid JSON object (no markdown outside JSON) with keys: brandName (string) and pairings (array of 4 objects each with: name, headingFont, bodyFont, monoFont, headingCategory one of "sans-serif"|"serif"|"display", bodyCategory one of "sans-serif"|"serif", mood one of "industrial"|"editorial"|"modern", rationale, sourceNote). ${allowedCatalogNote}`,
          config: {
            tools: [{ googleSearch: {} }],
          },
        })
      );
      parsed = JSON.parse(extractJsonBlock(searchResp.text ?? '{}'));
    }

    const rawPairings = Array.isArray(parsed.pairings) ? parsed.pairings : [];
    const sanitizeFont = (val: unknown, fallback: string) => {
      const cleaned = String(val || '')
        .replace(/['"<>]/g, '')
        .trim()
        .slice(0, 42);
      return cleaned || fallback;
    };

    const sanitizedPairings = rawPairings
      .slice(0, 5)
      .map((item, idx) => {
        const obj = (item || {}) as Record<string, unknown>;
        const rawHeadingCat = String(obj.headingCategory || '').toLowerCase();
        const headingCategory: 'sans-serif' | 'serif' | 'display' =
          rawHeadingCat === 'serif'
            ? 'serif'
            : rawHeadingCat === 'display'
              ? 'display'
              : 'sans-serif';
        const rawBodyCat = String(obj.bodyCategory || '').toLowerCase();
        const bodyCategory: 'sans-serif' | 'serif' =
          rawBodyCat === 'serif' ? 'serif' : 'sans-serif';
        const rawMood = String(obj.mood || '').toLowerCase();
        const mood: 'industrial' | 'editorial' | 'modern' =
          rawMood === 'editorial'
            ? 'editorial'
            : rawMood === 'modern'
              ? 'modern'
              : 'industrial';

        return {
          id: `url-font-${idx + 1}-${Date.now()}`,
          name: String(obj.name || `Suggested Pairing ${idx + 1}`).trim().slice(0, 36),
          headingFont: sanitizeFont(obj.headingFont, 'Space Grotesk'),
          bodyFont: sanitizeFont(obj.bodyFont, 'Inter'),
          monoFont: sanitizeFont(obj.monoFont, 'IBM Plex Mono'),
          headingCategory,
          bodyCategory,
          mood,
          rationale: String(
            obj.rationale || 'Balanced display authority and clear body readability.'
          )
            .trim()
            .slice(0, 140),
          sourceNote: String(obj.sourceNote || 'URL suggestion').trim().slice(0, 32),
        };
      });

    if (sanitizedPairings.length === 0) {
      res.status(502).json({
        error: 'Gemini returned no font pairings for that URL. Try again or check the URL.',
      });
      return;
    }

    res.json({
      sourceUrl: parsedUrl.toString(),
      brandName: String(parsed.brandName || pageTitle || brandName || parsedUrl.hostname).trim(),
      detectedSiteFonts,
      pairings: sanitizedPairings,
      usedFallback,
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

app.post('/api/mockup/analyze', async (req, res) => {
  try {
    const { url, rawNotes } = req.body as { url?: string; rawNotes?: string };
    let normalizedUrl = (url || '').trim();
    const cleanedNotes = (rawNotes || '').trim();

    if (!normalizedUrl && !cleanedNotes) {
      res.status(400).json({ error: 'Provide a website URL or pasted business notes to build a mockup.' });
      return;
    }

    if (normalizedUrl && !/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    let fetchedText = '';
    let pageTitle = '';
    let extractedColors: string[] = [];
    let cssVariables: string[] = [];
    let usedFallback = false;

    if (normalizedUrl) {
      try {
        const parsedUrl = new URL(normalizedUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new Error('Only http and https URLs are supported.');
        }

        const resp = await fetch(parsedUrl.toString(), {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(10000),
        });

        if (resp.ok) {
          const html = await resp.text();
          const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          pageTitle = titleMatch ? stripHtmlToText(titleMatch[1]) : '';
          const signals = await collectSiteColorSignals(parsedUrl, html);
          extractedColors = signals.rankedHexColors.slice(0, 8);
          cssVariables = signals.cssVariables;
          fetchedText = stripHtmlToText(html).slice(0, 14000);
        }
      } catch {
        // Fallback below if site blocks server fetch
      }
    }

    const ai = getGeminiClient();

    const mockupSchema = {
      type: Type.OBJECT,
      properties: {
        brand: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            industry: { type: Type.STRING },
            serviceArea: { type: Type.STRING },
            phone: { type: Type.STRING },
            email: { type: Type.STRING },
            hours: { type: Type.STRING },
            address: { type: Type.STRING },
            primaryHex: { type: Type.STRING },
            accentHex: { type: Type.STRING },
            canvasMode: { type: Type.STRING },
            fontMood: { type: Type.STRING },
          },
          required: ['name', 'industry', 'primaryHex', 'accentHex', 'canvasMode', 'fontMood'],
        },
        brandSwatches: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              hex: { type: Type.STRING },
              name: { type: Type.STRING },
              role: { type: Type.STRING },
              usageNote: { type: Type.STRING },
            },
            required: ['hex', 'name', 'role', 'usageNote'],
          },
        },
        hero: {
          type: Type.OBJECT,
          properties: {
            kicker: { type: Type.STRING },
            headline: { type: Type.STRING },
            subheadline: { type: Type.STRING },
            primaryCta: { type: Type.STRING },
            secondaryCta: { type: Type.STRING },
            trustHighlights: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['kicker', 'headline', 'subheadline', 'primaryCta', 'trustHighlights'],
        },
        services: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              deliverable: { type: Type.STRING },
            },
            required: ['title', 'description', 'deliverable'],
          },
        },
        projects: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              location: { type: Type.STRING },
              metric: { type: Type.STRING },
              summary: { type: Type.STRING },
            },
            required: ['title', 'location', 'metric', 'summary'],
          },
        },
        about: {
          type: Type.OBJECT,
          properties: {
            heading: { type: Type.STRING },
            story: { type: Type.STRING },
            credentials: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['heading', 'story', 'credentials'],
        },
        quoteForm: {
          type: Type.OBJECT,
          properties: {
            heading: { type: Type.STRING },
            subtext: { type: Type.STRING },
            submitLabel: { type: Type.STRING },
          },
          required: ['heading', 'subtext', 'submitLabel'],
        },
      },
      required: ['brand', 'brandSwatches', 'hero', 'services', 'projects', 'about', 'quoteForm'],
    };

    let parsed: Record<string, unknown>;

    if (fetchedText.length >= 160 || cleanedNotes.length > 0) {
      const prompt = [
        normalizedUrl ? `TARGET WEBSITE URL: ${normalizedUrl}` : '',
        pageTitle ? `PAGE TITLE: ${pageTitle}` : '',
        cssVariables.length > 0 ? `CSS VARIABLES:\n${cssVariables.join('\n')}` : '',
        extractedColors.length > 0
          ? `HEX COLOURS DETECTED IN SITE STYLES: ${extractedColors.join(', ')}`
          : '',
        fetchedText ? `EXTRACTED LIVE PAGE CONTENT:\n${fetchedText}` : '',
        cleanedNotes ? `USER NOTES / PASTED COPY:\n${cleanedNotes}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const response = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Analyze the business information below and produce a clean, modern, conversion-focused website redesign mockup tailored to their exact industry and brand colours.\n\n${prompt}`,
          config: {
            systemInstruction:
              'You are a senior web designer and copywriter creating a sharp, authentic redesign mockup for a real local or trade/commercial business. Extract real company name, phone, email, address, service area, and genuine services from the supplied content—never invent fake phone numbers or fake review quotes. Choose a strong primaryHex (6-digit #RRGGBB, leaning on detected brand colours when appropriate) and high-contrast accentHex (#RRGGBB). Also return 5 to 6 curated brandSwatches ({ hex, name, role: "primary"|"accent"|"surface"|"neutral", usageNote }). Set canvasMode to "light" or "dark" based on what best fits the industry, and fontMood to "industrial", "modern", or "editorial". Write crisp, plain-English copy with zero generic SaaS buzzwords ("elevate", "supercharge", "empower"). Provide 3 to 4 concrete services, 2 to 3 realistic project examples grounded in their work, and 3 authentic credentials.',
            responseMimeType: 'application/json',
            responseSchema: mockupSchema,
          },
        })
      );

      parsed = JSON.parse((response.text ?? '{}').trim());
    } else {
      // Site blocked direct fetch (e.g. Cloudflare) — try Google Search grounding to gather real info
      usedFallback = true;
      const searchResp = await withTextModelFallback((model) =>
        ai.models.generateContent({
          model,
          contents: `Look up the real business website at ${normalizedUrl} and return ONLY a single valid JSON object (no markdown outside JSON) with keys: brand ({ name, industry, serviceArea, phone, email, hours, address, primaryHex, accentHex, canvasMode, fontMood }), brandSwatches ([{ hex, name, role, usageNote }]), hero ({ kicker, headline, subheadline, primaryCta, secondaryCta, trustHighlights }), services ([{ title, description, deliverable }]), projects ([{ title, location, metric, summary }]), about ({ heading, story, credentials }), quoteForm ({ heading, subtext, submitLabel }). Use authentic details for this business and a tailored 6-digit hex palette.`,
          config: {
            tools: [{ googleSearch: {} }],
          },
        })
      );
      parsed = JSON.parse(extractJsonBlock(searchResp.text ?? '{}'));
    }

    const rawBrand = (parsed.brand || {}) as Record<string, unknown>;
    const rawHero = (parsed.hero || {}) as Record<string, unknown>;
    const rawAbout = (parsed.about || {}) as Record<string, unknown>;
    const rawQuote = (parsed.quoteForm || {}) as Record<string, unknown>;
    const rawServices = Array.isArray(parsed.services) ? parsed.services : [];
    const rawProjects = Array.isArray(parsed.projects) ? parsed.projects : [];

    const canvasMode = rawBrand.canvasMode === 'dark' ? 'dark' : 'light';
    const fontMood =
      rawBrand.fontMood === 'editorial' || rawBrand.fontMood === 'modern'
        ? rawBrand.fontMood
        : 'industrial';
    const primaryHex = sanitizeHexColor(rawBrand.primaryHex, extractedColors[0] || '#1E3A5F');
    const accentHex = sanitizeHexColor(rawBrand.accentHex, extractedColors[1] || '#D97706');
    const brandSwatches = sanitizeBrandSwatches(
      parsed.brandSwatches,
      primaryHex,
      accentHex,
      extractedColors
    );

    const project = {
      sourceUrl: normalizedUrl,
      lastImportedAt: new Date().toISOString(),
      brand: {
        name: String(rawBrand.name || pageTitle || 'Client Business').trim(),
        industry: String(rawBrand.industry || 'Local Services').trim(),
        serviceArea: String(rawBrand.serviceArea || '').trim(),
        phone: String(rawBrand.phone || '').trim(),
        email: String(rawBrand.email || '').trim(),
        hours: String(rawBrand.hours || 'Mon–Fri 08:00–17:30').trim(),
        address: String(rawBrand.address || '').trim(),
        palette: {
          primary: primaryHex,
          accent: accentHex,
          canvasMode,
        },
        fontMood,
      },
      brandSwatches,
      hero: {
        kicker: String(rawHero.kicker || rawBrand.industry || 'Specialist Services').trim(),
        headline: String(
          rawHero.headline || 'Reliable workmanship delivered on schedule.'
        ).trim(),
        subheadline: String(rawHero.subheadline || '').trim(),
        primaryCta: String(rawHero.primaryCta || 'Request a Quote').trim(),
        secondaryCta: String(rawHero.secondaryCta || 'View Services').trim(),
        trustHighlights: Array.isArray(rawHero.trustHighlights)
          ? rawHero.trustHighlights.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 4)
          : [],
      },
      services: rawServices.slice(0, 6).map((s: Record<string, unknown>, idx: number) => ({
        id: `srv-${Date.now()}-${idx}`,
        title: String(s?.title || `Service ${idx + 1}`).trim(),
        description: String(s?.description || '').trim(),
        deliverable: String(s?.deliverable || '').trim(),
      })),
      projects: rawProjects.slice(0, 4).map((p: Record<string, unknown>, idx: number) => ({
        id: `prj-${Date.now()}-${idx}`,
        title: String(p?.title || `Completed Project ${idx + 1}`).trim(),
        location: String(p?.location || rawBrand.serviceArea || 'Local Area').trim(),
        metric: String(p?.metric || '').trim(),
        summary: String(p?.summary || '').trim(),
      })),
      about: {
        heading: String(rawAbout.heading || 'Built on straightforward service.').trim(),
        story: String(rawAbout.story || '').trim(),
        credentials: Array.isArray(rawAbout.credentials)
          ? rawAbout.credentials.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 5)
          : [],
      },
      quoteForm: {
        heading: String(rawQuote.heading || 'Request a straightforward quote').trim(),
        subtext: String(
          rawQuote.subtext || 'Tell us about your project and we will get back to you promptly.'
        ).trim(),
        submitLabel: String(rawQuote.submitLabel || 'Send Enquiry').trim(),
      },
      sectionVisibility: {
        services: true,
        projects: true,
        about: true,
        quote: true,
      },
    };

    res.json({
      project,
      extractedColors,
      brandSwatches,
      usedFallback,
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

app.post('/api/mockup/rewrite', async (req, res) => {
  try {
    const { section, project, instruction } = req.body as {
      section?: 'hero' | 'services' | 'projects' | 'about';
      project?: Record<string, unknown>;
      instruction?: string;
    };

    if (
      !section ||
      !['hero', 'services', 'projects', 'about'].includes(section) ||
      !project ||
      !instruction?.trim()
    ) {
      res.status(400).json({ error: 'Provide a valid section, project, and polish instruction.' });
      return;
    }

    const ai = getGeminiClient();
    const currentData = project[section];
    const brandSummary = JSON.stringify(project.brand || {});

    const schemaBySection: Record<string, Record<string, unknown>> = {
      hero: {
        type: Type.OBJECT,
        properties: {
          kicker: { type: Type.STRING },
          headline: { type: Type.STRING },
          subheadline: { type: Type.STRING },
          primaryCta: { type: Type.STRING },
          secondaryCta: { type: Type.STRING },
          trustHighlights: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['kicker', 'headline', 'subheadline', 'primaryCta', 'secondaryCta', 'trustHighlights'],
      },
      services: {
        type: Type.OBJECT,
        properties: {
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                deliverable: { type: Type.STRING },
              },
              required: ['id', 'title', 'description', 'deliverable'],
            },
          },
        },
        required: ['items'],
      },
      projects: {
        type: Type.OBJECT,
        properties: {
          items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                title: { type: Type.STRING },
                location: { type: Type.STRING },
                metric: { type: Type.STRING },
                summary: { type: Type.STRING },
              },
              required: ['id', 'title', 'location', 'metric', 'summary'],
            },
          },
        },
        required: ['items'],
      },
      about: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING },
          story: { type: Type.STRING },
          credentials: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['heading', 'story', 'credentials'],
      },
    };

    const response = await withTextModelFallback((model) =>
      ai.models.generateContent({
        model,
        contents: `BUSINESS CONTEXT: ${brandSummary}\n\nCURRENT "${section.toUpperCase()}" SECTION:\n${JSON.stringify(currentData, null, 2)}\n\nREVISION INSTRUCTION: "${instruction.trim()}"`,
        config: {
          systemInstruction:
            'You are a sharp, plain-English commercial copywriter. Revise ONLY the supplied website section according to the user instruction while keeping real company facts intact. Avoid buzzwords ("supercharge", "elevate", "empower"). Keep existing item IDs intact.',
          responseMimeType: 'application/json',
          responseSchema: schemaBySection[section],
        },
      })
    );

    const parsed = JSON.parse((response.text ?? '{}').trim());
    const patch =
      section === 'services' || section === 'projects'
        ? { [section]: parsed.items }
        : { [section]: parsed };

    res.json({ section, patch });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

// 8. Shareable Site Mockup Preview Links (ephemeral TTL disk store)
const MOCKUP_SHARE_ROOT_DIR = path.join(os.tmpdir(), 'dispatch-mockup-shares');
const MOCKUP_SHARE_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

interface StoredMockupShareManifest {
  shareId: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: number;
  note: string;
  project: Record<string, unknown>;
  creatorUid?: string;
  creatorEmail?: string;
  manageToken?: string;
}

async function cleanupExpiredMockupShares(): Promise<number> {
  let purged = 0;
  try {
    await fs.mkdir(MOCKUP_SHARE_ROOT_DIR, { recursive: true });
    const entries = await fs.readdir(MOCKUP_SHARE_ROOT_DIR);
    const now = Date.now();
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.endsWith('.json')) return;
        const filePath = path.join(MOCKUP_SHARE_ROOT_DIR, entry);
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const parsed = JSON.parse(raw) as StoredMockupShareManifest;
          if (!parsed.expiresAt || new Date(parsed.expiresAt).getTime() <= now) {
            await fs.rm(filePath, { force: true });
            purged += 1;
          }
        } catch {
          await fs.rm(filePath, { force: true }).catch(() => {});
          purged += 1;
        }
      })
    );
  } catch {
    // Non-fatal background cleanup
  }
  return purged;
}

async function readValidMockupShare(shareId: string): Promise<
  | { status: 'ok'; manifest: StoredMockupShareManifest }
  | { status: 'not_found' }
  | { status: 'expired' }
> {
  if (!MOCKUP_SHARE_ID_RE.test(shareId)) {
    return { status: 'not_found' };
  }
  const filePath = path.join(MOCKUP_SHARE_ROOT_DIR, `${shareId}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const manifest = JSON.parse(raw) as StoredMockupShareManifest;
    if (new Date(manifest.expiresAt).getTime() <= Date.now()) {
      await fs.rm(filePath, { force: true }).catch(() => {});
      return { status: 'expired' };
    }
    return { status: 'ok', manifest };
  } catch {
    return { status: 'not_found' };
  }
}

app.post('/api/mockup-shares', optionalAuth, async (req: AuthRequest, res) => {
  try {
    const { project, ttlHours = 72, note = '' } = req.body as {
      project?: Record<string, unknown>;
      ttlHours?: number;
      note?: string;
    };

    if (!project || typeof project !== 'object' || !project.brand) {
      res.status(400).json({ error: 'Valid site mockup project data is required to create a preview link.' });
      return;
    }

    const serializedSize = Buffer.byteLength(JSON.stringify(project), 'utf8');
    if (serializedSize > 8 * 1024 * 1024) {
      res.status(413).json({
        error: 'Mockup payload is too large to share. Try removing or replacing oversized photos.',
      });
      return;
    }

    const safeTtlHours = ALLOWED_SHARE_TTL_HOURS.has(Number(ttlHours)) ? Number(ttlHours) : 72;
    const shareId = crypto.randomBytes(6).toString('base64url');
    const manageToken = crypto.randomBytes(18).toString('base64url');
    await fs.mkdir(MOCKUP_SHARE_ROOT_DIR, { recursive: true });

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + safeTtlHours * 3600 * 1000).toISOString();

    const manifest: StoredMockupShareManifest = {
      shareId,
      createdAt,
      expiresAt,
      ttlHours: safeTtlHours,
      note: String(note || '').trim().slice(0, 280),
      project,
      creatorUid: req.user?.uid,
      creatorEmail: req.user?.email,
      manageToken,
    };

    await fs.writeFile(
      path.join(MOCKUP_SHARE_ROOT_DIR, `${shareId}.json`),
      JSON.stringify(manifest),
      'utf8'
    );

    cleanupExpiredMockupShares().catch(() => {});

    if (req.user?.uid) {
      const tokenMeta = extractTokenAuthMetadata(req.user);
      const brandObj = (project.brand || {}) as Record<string, unknown>;
      const brandLabel = String(brandObj.name || 'Site Mockup').slice(0, 80);
      getOrCreateUser(
        req.user.uid,
        req.user.email || `${req.user.uid}@dispatch.local`,
        typeof req.user.name === 'string' ? req.user.name : '',
        typeof req.user.picture === 'string' ? req.user.picture : '',
        tokenMeta.emailVerified,
        {
          authProvider: tokenMeta.authProvider,
          tokenAuthTimeSec: tokenMeta.tokenAuthTimeSec,
          clientContext: describeClientContext(req),
        }
      )
        .then((u) =>
          recordUserActivityLog({
            userId: u.id,
            actorEmail: u.email,
            actorName: u.displayName,
            actorRole: u.role,
            category: 'share',
            action: 'share.created',
            summary: `Published Site Mockup preview link /mockup/${shareId} ("${brandLabel}")`,
            resourceType: 'mockup_share',
            resourceId: shareId,
            authStatus: tokenMeta.emailVerified ? 'verified' : 'unverified',
            clientContext: describeClientContext(req),
            metadata: {
              operation: 'create_share',
              shareKind: 'mockup',
              shareId,
              title: brandLabel,
              ttlHours: safeTtlHours,
              expiresAt,
            },
          })
        )
        .catch(() => {});
    }

    res.status(201).json({
      shareId,
      sharePath: `/mockup/${shareId}`,
      createdAt,
      expiresAt,
      ttlHours: safeTtlHours,
      manageToken,
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

app.get('/api/mockup-shares/:shareId', async (req, res) => {
  const result = await readValidMockupShare(req.params.shareId);
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'This site mockup preview link was not found or has been revoked.' });
    return;
  }
  if (result.status === 'expired') {
    res.status(410).json({ error: 'This site mockup preview link has expired.', expired: true });
    return;
  }
  res.json({ share: stripInternalShareSecrets(result.manifest) });
});

app.put('/api/mockup-shares/:shareId', optionalAuth, async (req: AuthRequest, res) => {
  try {
    const { shareId } = req.params;
    const existing = await readValidMockupShare(shareId);
    if (existing.status === 'not_found') {
      res.status(404).json({ error: 'This share link was not found or has been revoked. Create a new link instead.' });
      return;
    }
    if (existing.status === 'expired') {
      res.status(410).json({ error: 'This share link has expired. Create a new link instead.', expired: true });
      return;
    }

    const allowed = await canManageShare(req, existing.manifest);
    if (!allowed) {
      res.status(403).json({
        error:
          'Forbidden: Only the creator of this link or a Studio Owner/Admin can sync updates to it.',
      });
      return;
    }

    const { project, ttlHours, note } = req.body as {
      project?: Record<string, unknown>;
      ttlHours?: number;
      note?: string;
    };

    if (!project || typeof project !== 'object' || !project.brand) {
      res.status(400).json({ error: 'Valid site mockup project data is required to update this preview link.' });
      return;
    }

    const serializedSize = Buffer.byteLength(JSON.stringify(project), 'utf8');
    if (serializedSize > 8 * 1024 * 1024) {
      res.status(413).json({
        error: 'Mockup payload is too large to share. Try removing or replacing oversized photos.',
      });
      return;
    }

    const safeTtlHours = ALLOWED_SHARE_TTL_HOURS.has(Number(ttlHours))
      ? Number(ttlHours)
      : existing.manifest.ttlHours;
    const updatedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + safeTtlHours * 3600 * 1000).toISOString();

    const updatedManifest: StoredMockupShareManifest = {
      ...existing.manifest,
      ttlHours: safeTtlHours,
      expiresAt,
      note: note !== undefined ? String(note).trim().slice(0, 280) : existing.manifest.note,
      project,
    };

    await fs.writeFile(
      path.join(MOCKUP_SHARE_ROOT_DIR, `${shareId}.json`),
      JSON.stringify(updatedManifest),
      'utf8'
    );

    res.json({
      shareId,
      sharePath: `/mockup/${shareId}`,
      createdAt: updatedManifest.createdAt,
      updatedAt,
      expiresAt,
      ttlHours: safeTtlHours,
    });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

app.delete('/api/mockup-shares/:shareId', optionalAuth, async (req: AuthRequest, res) => {
  const { shareId } = req.params;
  if (!MOCKUP_SHARE_ID_RE.test(shareId)) {
    res.status(400).json({ error: 'Invalid mockup share ID.' });
    return;
  }
  const existing = await readValidMockupShare(shareId);
  if (existing.status !== 'ok') {
    res.json({ revoked: true });
    return;
  }
  const allowed = await canManageShare(req, existing.manifest);
  if (!allowed) {
    res.status(403).json({
      error:
        'Forbidden: Only the creator of this link or a Studio Owner/Admin can revoke it.',
    });
    return;
  }
  const filePath = path.join(MOCKUP_SHARE_ROOT_DIR, `${shareId}.json`);
  try {
    await fs.rm(filePath, { force: true });
    if (req.user?.email) {
      void recordUserActivityLog({
        actorEmail: req.user.email,
        actorName: typeof req.user.name === 'string' ? req.user.name : '',
        actorRole: isVerifiedPrincipalToken(req.user) ? 'owner' : 'member',
        category: 'share',
        action: 'share.revoked',
        summary: `Revoked Site Mockup preview link /mockup/${shareId}`,
        resourceType: 'mockup_share',
        resourceId: shareId,
        authStatus: req.user.email_verified ? 'verified' : 'unverified',
        clientContext: describeClientContext(req),
        metadata: {
          operation: 'revoke_share',
          shareKind: 'mockup',
          shareId,
        },
      });
    }
    res.json({ revoked: true });
  } catch (err) {
    const { status, message } = formatApiError(err);
    res.status(status).json({ error: message });
  }
});

const shareGovernance: ShareGovernanceController = {
  async listActiveSharesAndFootprint() {
    const shares: AuditedShareLink[] = [];
    let briefingShareCount = 0;
    let mockupShareCount = 0;
    let expiredPendingCount = 0;
    let totalShareBytes = 0;
    const now = Date.now();

    // 1. Scan Briefing Shares
    try {
      await fs.mkdir(SHARE_ROOT_DIR, { recursive: true });
      const entries = await fs.readdir(SHARE_ROOT_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !SHARE_ID_PATTERN.test(entry.name)) continue;
        const dir = path.join(SHARE_ROOT_DIR, entry.name);
        try {
          const manifestPath = path.join(dir, 'manifest.json');
          const raw = await fs.readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(raw) as StoredShareManifest;
          const isExpired =
            !manifest.expiresAt || new Date(manifest.expiresAt).getTime() <= now;
          if (isExpired) {
            expiredPendingCount += 1;
            continue;
          }

          let dirBytes = Buffer.byteLength(raw, 'utf8');
          const subFiles = await fs.readdir(dir);
          for (const sub of subFiles) {
            if (sub === 'manifest.json') continue;
            try {
              const st = await fs.stat(path.join(dir, sub));
              dirBytes += st.size;
            } catch {
              // Ignore
            }
          }

          briefingShareCount += 1;
          totalShareBytes += dirBytes;
          shares.push({
            shareId: manifest.shareId,
            kind: 'briefing',
            sharePath: `/share/${manifest.shareId}`,
            title: manifest.editionTitle || 'Shared Audio Briefing',
            subtitle: manifest.editionSubtitle || `${manifest.segments?.length ?? 0} chapters`,
            creatorEmail: manifest.creatorEmail || 'Guest / Unauthenticated',
            createdAt: manifest.createdAt,
            expiresAt: manifest.expiresAt,
            ttlHours: manifest.ttlHours,
            itemCount: Array.isArray(manifest.segments) ? manifest.segments.length : 0,
            hasAudio: Boolean(manifest.hasAudio),
            sizeBytes: dirBytes,
          });
        } catch {
          // Skip unreadable share folder
        }
      }
    } catch {
      // Ignore if root does not exist
    }

    // 2. Scan Mockup Shares
    try {
      await fs.mkdir(MOCKUP_SHARE_ROOT_DIR, { recursive: true });
      const files = await fs.readdir(MOCKUP_SHARE_ROOT_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const shareId = file.slice(0, -5);
        if (!MOCKUP_SHARE_ID_RE.test(shareId)) continue;
        const filePath = path.join(MOCKUP_SHARE_ROOT_DIR, file);
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const manifest = JSON.parse(raw) as StoredMockupShareManifest;
          const isExpired =
            !manifest.expiresAt || new Date(manifest.expiresAt).getTime() <= now;
          if (isExpired) {
            expiredPendingCount += 1;
            continue;
          }

          const byteSize = Buffer.byteLength(raw, 'utf8');
          const brandObj = (manifest.project?.brand || {}) as Record<string, unknown>;
          const servicesArr = Array.isArray(manifest.project?.services)
            ? manifest.project.services
            : [];
          const projectsArr = Array.isArray(manifest.project?.projects)
            ? manifest.project.projects
            : [];

          mockupShareCount += 1;
          totalShareBytes += byteSize;
          shares.push({
            shareId: manifest.shareId,
            kind: 'mockup',
            sharePath: `/mockup/${manifest.shareId}`,
            title: String(brandObj.name || 'Shared Site Mockup'),
            subtitle:
              manifest.note ||
              String(brandObj.industry || `${servicesArr.length} services`),
            creatorEmail: manifest.creatorEmail || 'Guest / Unauthenticated',
            createdAt: manifest.createdAt,
            expiresAt: manifest.expiresAt,
            ttlHours: manifest.ttlHours,
            itemCount: servicesArr.length + projectsArr.length,
            hasAudio: false,
            sizeBytes: byteSize,
          });
        } catch {
          // Skip unreadable file
        }
      }
    } catch {
      // Ignore if root does not exist
    }

    shares.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return {
      shares,
      storage: {
        activeShareCount: shares.length,
        briefingShareCount,
        mockupShareCount,
        expiredPendingCount,
        totalShareBytes,
      },
    };
  },

  async extendShare(kind, shareId, addHours) {
    const safeHours = ALLOWED_SHARE_TTL_HOURS.has(addHours) ? addHours : 72;
    if (kind === 'briefing') {
      const found = await readValidShareManifest(shareId);
      if (found.status !== 'ok') {
        throw new Error('Briefing share link was not found or already expired.');
      }
      const baseMs = Math.max(Date.now(), new Date(found.manifest.expiresAt).getTime());
      const nextExpiresAt = new Date(baseMs + safeHours * 3600 * 1000).toISOString();
      const updated: StoredShareManifest = {
        ...found.manifest,
        expiresAt: nextExpiresAt,
        ttlHours: safeHours,
      };
      await fs.writeFile(
        path.join(found.dir, 'manifest.json'),
        JSON.stringify(updated),
        'utf8'
      );
      return nextExpiresAt;
    }

    const found = await readValidMockupShare(shareId);
    if (found.status !== 'ok') {
      throw new Error('Mockup share link was not found or already expired.');
    }
    const baseMs = Math.max(Date.now(), new Date(found.manifest.expiresAt).getTime());
    const nextExpiresAt = new Date(baseMs + safeHours * 3600 * 1000).toISOString();
    const updated: StoredMockupShareManifest = {
      ...found.manifest,
      expiresAt: nextExpiresAt,
      ttlHours: safeHours,
    };
    await fs.writeFile(
      path.join(MOCKUP_SHARE_ROOT_DIR, `${shareId}.json`),
      JSON.stringify(updated),
      'utf8'
    );
    return nextExpiresAt;
  },

  async revokeShareAsAdmin(kind, shareId) {
    if (kind === 'briefing') {
      if (!SHARE_ID_PATTERN.test(shareId)) {
        throw new Error('Invalid briefing share ID.');
      }
      await fs
        .rm(path.join(SHARE_ROOT_DIR, shareId), { recursive: true, force: true })
        .catch(() => {});
      return;
    }
    if (!MOCKUP_SHARE_ID_RE.test(shareId)) {
      throw new Error('Invalid mockup share ID.');
    }
    await fs
      .rm(path.join(MOCKUP_SHARE_ROOT_DIR, `${shareId}.json`), { force: true })
      .catch(() => {});
  },

  async purgeExpiredShares() {
    const [purgedBriefings, purgedMockups] = await Promise.all([
      cleanupExpiredShares(),
      cleanupExpiredMockupShares(),
    ]);
    return { purgedCount: purgedBriefings + purgedMockups };
  },

  async listRawShareSnapshots() {
    const snapshots: RawServerShareSnapshot[] = [];
    const now = Date.now();
    const resolvedBriefingRoot = path.resolve(SHARE_ROOT_DIR);
    const resolvedMockupRoot = path.resolve(MOCKUP_SHARE_ROOT_DIR);

    try {
      await fs.mkdir(resolvedBriefingRoot, { recursive: true });
      const entries = await fs.readdir(resolvedBriefingRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !SHARE_ID_PATTERN.test(entry.name)) continue;
        const dir = path.resolve(resolvedBriefingRoot, entry.name);
        if (!dir.startsWith(resolvedBriefingRoot + path.sep)) continue;
        try {
          const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
          const manifest = JSON.parse(raw) as StoredShareManifest;
          if (!manifest.expiresAt || new Date(manifest.expiresAt).getTime() <= now) {
            continue;
          }
          const publicManifest = stripInternalShareSecrets(manifest);
          snapshots.push({
            shareId: manifest.shareId,
            kind: 'briefing',
            sharePath: `/share/${manifest.shareId}`,
            creatorUid: manifest.creatorUid,
            createdAt: manifest.createdAt,
            expiresAt: manifest.expiresAt,
            ttlHours: manifest.ttlHours,
            briefingManifest: publicManifest as unknown as Record<string, unknown>,
          });
        } catch {
          // Skip unreadable share manifest
        }
      }
    } catch {
      // Ignore missing briefing share root
    }

    try {
      await fs.mkdir(resolvedMockupRoot, { recursive: true });
      const files = await fs.readdir(resolvedMockupRoot);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const shareId = file.slice(0, -5);
        if (!MOCKUP_SHARE_ID_RE.test(shareId)) continue;
        const filePath = path.resolve(resolvedMockupRoot, file);
        if (!filePath.startsWith(resolvedMockupRoot + path.sep)) continue;
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const manifest = JSON.parse(raw) as StoredMockupShareManifest;
          if (!manifest.expiresAt || new Date(manifest.expiresAt).getTime() <= now) {
            continue;
          }
          snapshots.push({
            shareId: manifest.shareId,
            kind: 'mockup',
            sharePath: `/mockup/${manifest.shareId}`,
            creatorUid: manifest.creatorUid,
            createdAt: manifest.createdAt,
            expiresAt: manifest.expiresAt,
            ttlHours: manifest.ttlHours,
            note: manifest.note,
            mockupProject: manifest.project,
          });
        } catch {
          // Skip unreadable mockup manifest
        }
      }
    } catch {
      // Ignore missing mockup share root
    }

    return snapshots;
  },

  async scrubAndRelinkShare(kind, oldShareId, fallbackPayload) {
    if (!SHARE_ID_PATTERN.test(oldShareId)) {
      throw new Error('Invalid share identifier supplied for Scrub & Re-Link.');
    }

    // Mint fresh cryptographic capability ID guaranteed distinct from oldShareId
    let newShareId = crypto.randomBytes(6).toString('base64url');
    while (newShareId === oldShareId || !SHARE_ID_PATTERN.test(newShareId)) {
      newShareId = crypto.randomBytes(6).toString('base64url');
    }
    const freshManageToken = crypto.randomBytes(18).toString('base64url');
    const nowIso = new Date().toISOString();

    if (kind === 'briefing') {
      const resolvedRoot = path.resolve(SHARE_ROOT_DIR);
      await fs.mkdir(resolvedRoot, { recursive: true });
      const oldDir = path.resolve(resolvedRoot, oldShareId);
      const newDir = path.resolve(resolvedRoot, newShareId);
      if (
        !oldDir.startsWith(resolvedRoot + path.sep) ||
        !newDir.startsWith(resolvedRoot + path.sep)
      ) {
        throw new Error('Share directory path confinement check failed.');
      }

      const existing = await readValidShareManifest(oldShareId);
      const hadServerManifest = existing.status === 'ok';
      const fallbackBriefing = (fallbackPayload?.briefingManifest || {}) as Partial<StoredShareManifest>;
      const sourceManifest: Partial<StoredShareManifest> = hadServerManifest
        ? existing.manifest
        : fallbackBriefing;

      const requestedTtl = Number(fallbackPayload?.ttlHours || sourceManifest.ttlHours || 72);
      const safeTtlHours = ALLOWED_SHARE_TTL_HOURS.has(requestedTtl) ? requestedTtl : 72;
      const expiresAt = new Date(Date.now() + safeTtlHours * 3600 * 1000).toISOString();

      await fs.mkdir(newDir, { recursive: true });

      const rawSegments = Array.isArray(sourceManifest.segments)
        ? sourceManifest.segments
        : [];
      let recordedChapters = 0;
      const scrubbedSegments: StoredShareSegment[] = [];

      for (let i = 0; i < rawSegments.length; i++) {
        const seg = scrubShareValueDeep(rawSegments[i]);
        let segHasAudio = false;
        if (hadServerManifest) {
          const oldWav = path.resolve(oldDir, `seg-${i}.wav`);
          const newWav = path.resolve(newDir, `seg-${i}.wav`);
          if (
            oldWav.startsWith(oldDir + path.sep) &&
            newWav.startsWith(newDir + path.sep)
          ) {
            try {
              await fs.copyFile(oldWav, newWav);
              segHasAudio = true;
              recordedChapters += 1;
            } catch {
              segHasAudio = false;
            }
          }
        }
        scrubbedSegments.push({
          ...seg,
          id: String(seg.id || `seg-${i + 1}`),
          title: scrubProseString(String(seg.title || `Chapter ${i + 1}`), 'title'),
          category: scrubProseString(String(seg.category || 'News'), 'category'),
          sourceTitles: Array.isArray(seg.sourceTitles)
            ? seg.sourceTitles.map((t) => scrubProseString(String(t), 'sourceTitles'))
            : [],
          keyPoint: scrubProseString(String(seg.keyPoint || ''), 'keyPoint'),
          estimatedSeconds: Math.max(10, Math.round(Number(seg.estimatedSeconds) || 60)),
          lines: Array.isArray(seg.lines)
            ? seg.lines.map((l) => ({
                speaker: scrubProseString(String(l?.speaker || 'Anchor'), 'speaker'),
                text: scrubProseString(String(l?.text || ''), 'text'),
              }))
            : [],
          hasAudio: segHasAudio,
          audioUrl: segHasAudio ? `/api/shares/${newShareId}/audio/${i}` : undefined,
        });
      }

      const scrubbedPrefs = scrubShareValueDeep(
        sourceManifest.preferences || {
          durationMinutes: 5 as const,
          format: 'podcast' as const,
          tone: 'executive' as const,
          voiceTone: 'professional' as const,
          voiceName: 'Kore',
          coHostVoiceName: 'Puck',
          listenerFocus: '',
        }
      );
      scrubbedPrefs.listenerFocus = '';

      const hasAudio = recordedChapters > 0;
      const scrubbedTitle =
        scrubProseString(String(sourceManifest.editionTitle || ''), 'editionTitle').trim() ||
        'Sanitized Audio Briefing';

      const newManifest: StoredShareManifest = {
        shareId: newShareId,
        createdAt: nowIso,
        expiresAt,
        ttlHours: safeTtlHours,
        editionTitle: scrubbedTitle,
        editionSubtitle: scrubProseString(
          String(sourceManifest.editionSubtitle || ''),
          'editionSubtitle'
        ),
        briefingCreatedAt: String(sourceManifest.briefingCreatedAt || nowIso),
        takeaways: Array.isArray(sourceManifest.takeaways)
          ? sourceManifest.takeaways.map((t) => scrubProseString(String(t), 'takeaways'))
          : [],
        preferences: scrubbedPrefs,
        articleTitles: Array.isArray(sourceManifest.articleTitles)
          ? sourceManifest.articleTitles.map((t) =>
              scrubProseString(String(t), 'articleTitles')
            )
          : [],
        segments: scrubbedSegments,
        hasAudio,
        recordedChapters,
        totalDurationSeconds: Number(sourceManifest.totalDurationSeconds) || 0,
        downloadUrl: hasAudio ? `/api/shares/${newShareId}/download` : undefined,
        creatorUid:
          (hadServerManifest ? existing.manifest.creatorUid : undefined) ||
          fallbackPayload?.creatorUid,
        manageToken: freshManageToken,
      };

      await fs.writeFile(
        path.join(newDir, 'manifest.json'),
        JSON.stringify(newManifest),
        'utf8'
      );
      await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});

      return {
        oldShareId,
        newShareId,
        newSharePath: `/share/${newShareId}`,
        kind: 'briefing',
        createdAt: nowIso,
        expiresAt,
        ttlHours: safeTtlHours,
        hadServerManifest,
      };
    }

    // Site Mockup scrub & re-link
    const resolvedMockupRoot = path.resolve(MOCKUP_SHARE_ROOT_DIR);
    await fs.mkdir(resolvedMockupRoot, { recursive: true });
    const oldFilePath = path.resolve(resolvedMockupRoot, `${oldShareId}.json`);
    const newFilePath = path.resolve(resolvedMockupRoot, `${newShareId}.json`);
    if (
      !oldFilePath.startsWith(resolvedMockupRoot + path.sep) ||
      !newFilePath.startsWith(resolvedMockupRoot + path.sep)
    ) {
      throw new Error('Mockup share path confinement check failed.');
    }

    const existingMockup = await readValidMockupShare(oldShareId);
    const hadServerManifest = existingMockup.status === 'ok';
    const rawProjectSource = hadServerManifest
      ? existingMockup.manifest.project
      : fallbackPayload?.mockupProject;

    if (!rawProjectSource || typeof rawProjectSource !== 'object') {
      throw new Error('Could not locate mockup payload to scrub and re-link.');
    }

    const requestedTtl = Number(
      fallbackPayload?.ttlHours ||
        (hadServerManifest ? existingMockup.manifest.ttlHours : 72)
    );
    const safeTtlHours = ALLOWED_SHARE_TTL_HOURS.has(requestedTtl) ? requestedTtl : 72;
    const expiresAt = new Date(Date.now() + safeTtlHours * 3600 * 1000).toISOString();

    const scrubbedProject = scrubShareValueDeep(
      rawProjectSource as Record<string, unknown>
    );
    scrubbedProject.siteNotes = '';
    if (scrubbedProject.brand && typeof scrubbedProject.brand === 'object') {
      const brandObj = scrubbedProject.brand as Record<string, unknown>;
      brandObj.email = '';
      brandObj.phone = '';
      brandObj.address = '';
    }

    const rawNote = hadServerManifest
      ? existingMockup.manifest.note
      : String(fallbackPayload?.note || '');
    const scrubbedNote = scrubProseString(rawNote, 'note').trim().slice(0, 280);

    const nextMockupManifest: StoredMockupShareManifest = {
      shareId: newShareId,
      createdAt: nowIso,
      expiresAt,
      ttlHours: safeTtlHours,
      note: scrubbedNote,
      project: scrubbedProject,
      creatorUid:
        (hadServerManifest ? existingMockup.manifest.creatorUid : undefined) ||
        fallbackPayload?.creatorUid,
      manageToken: freshManageToken,
    };

    await fs.writeFile(newFilePath, JSON.stringify(nextMockupManifest), 'utf8');
    await fs.rm(oldFilePath, { force: true }).catch(() => {});

    return {
      oldShareId,
      newShareId,
      newSharePath: `/mockup/${newShareId}`,
      kind: 'mockup',
      createdAt: nowIso,
      expiresAt,
      ttlHours: safeTtlHours,
      hadServerManifest,
    };
  },
};

registerSuiteRoutes(app, getGeminiClient, formatApiError, shareGovernance);
registerRssRoutes(app, {
  stitchServerWavBuffers,
  safeTimingEqual,
  formatApiError,
});

async function startServer() {
  const httpServer = http.createServer(app);
  attachLiveVoiceServer(httpServer, getGeminiClient);

  httpServer.on('error', (err) => {
    console.error(`HTTP server failed on port ${PORT}:`, err);
    process.exit(1);
  });

  if (isProd) {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });

    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`Dispatch server listening on http://0.0.0.0:${PORT} (production)`);
      setImmediate(() => {
        cleanupExpiredShares().catch(() => {});
        cleanupExpiredMockupShares().catch(() => {});
      });
    });
    return;
  }

  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Dispatch server listening on http://0.0.0.0:${PORT} (development)`);
    setImmediate(() => {
      cleanupExpiredShares().catch(() => {});
      cleanupExpiredMockupShares().catch(() => {});
    });
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
