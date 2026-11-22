import type {
  AudioBriefing,
  BriefingPreferences,
  BriefingSegment,
  BriefingTone,
  CitationRef,
  CreateMockupShareResult,
  CreateShareResult,
  HighlightsMetaSummary,
  MockupCanvasMode,
  MockupColorSwatch,
  NewsArticle,
  ScriptLine,
  SharedBriefingManifest,
  SharedMockupManifest,
  ShareTtlHours,
  SiteMockupProject,
} from '../types';
import type { WavLoudnessMetrics } from '../utils/audioNormalization';

export interface ShareAuthOptions {
  token?: string | null;
  manageToken?: string | null;
}

function buildShareHeaders(authOpts?: ShareAuthOptions): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authOpts?.token) {
    headers.Authorization = `Bearer ${authOpts.token}`;
  }
  if (authOpts?.manageToken) {
    headers['X-Share-Manage-Token'] = authOpts.manageToken;
  }
  return headers;
}

async function postJson<T>(
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof data?.error === 'string'
        ? data.error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

export async function uploadDocumentSource(payload: {
  fileName: string;
  mimeType: string;
  base64Data?: string;
  textContent?: string;
  fileSizeBytes?: number;
}): Promise<Omit<NewsArticle, 'id' | 'selected' | 'addedAt'>> {
  const res = await postJson<{
    article: Omit<NewsArticle, 'id' | 'selected' | 'addedAt'>;
  }>('/api/sources/upload', payload);
  return res.article;
}

export async function ingestArticle(payload: {
  url?: string;
  rawText?: string;
}): Promise<Omit<NewsArticle, 'id' | 'selected' | 'addedAt'>> {
  const res = await postJson<{
    article: Omit<NewsArticle, 'id' | 'selected' | 'addedAt'>;
  }>('/api/articles/ingest', payload);
  return res.article;
}

export async function generateSourceTags(
  sources: Array<{
    id: string;
    title: string;
    summary?: string;
    content?: string;
    category?: string;
  }>
): Promise<Record<string, string[]>> {
  const res = await postJson<{ tagsById: Record<string, string[]> }>(
    '/api/sources/tag',
    { sources }
  );
  return res.tagsById || {};
}

export async function generateBriefingScript(
  articles: NewsArticle[],
  preferences: BriefingPreferences
): Promise<{
  editionTitle: string;
  editionSubtitle: string;
  takeaways: string[];
  takeawayCitations: CitationRef[];
  segments: BriefingSegment[];
}> {
  const customIntro = preferences.personalizedIntroduction?.trim() || '';
  const normalizedPreferences: BriefingPreferences = {
    ...preferences,
    ...(customIntro ? { personalizedIntroduction: customIntro } : {}),
  };

  const res = await postJson<{
    briefing: {
      editionTitle: string;
      editionSubtitle: string;
      takeaways: string[];
      takeawayCitations?: CitationRef[];
      segments: BriefingSegment[];
    };
  }>('/api/briefings/generate', {
    articles,
    preferences: normalizedPreferences,
    ...(customIntro ? { personalizedIntroduction: customIntro } : {}),
  });

  const segments = Array.isArray(res.briefing.segments)
    ? res.briefing.segments.map((seg, idx) => {
        if (idx !== 0 || !customIntro) return seg;
        const existingLines = Array.isArray(seg.lines) ? seg.lines : [];
        const firstLineText = (existingLines[0]?.text || '').trim().toLowerCase();
        const introNeedle = customIntro.toLowerCase().slice(0, Math.min(48, customIntro.length));
        if (firstLineText.includes(introNeedle)) {
          return seg;
        }
        const leadSpeaker = preferences.format === 'podcast' ? 'Alex' : 'Anchor';
        return {
          ...seg,
          lines: [{ speaker: leadSpeaker, text: customIntro }, ...existingLines],
        };
      })
    : [];

  return {
    ...res.briefing,
    segments,
    takeawayCitations: res.briefing.takeawayCitations || [],
  };
}

export async function refineBriefingScript(payload: {
  segments: BriefingSegment[];
  format: 'solo' | 'podcast';
  instruction: string;
  targetSegmentId?: string;
}): Promise<BriefingSegment[]> {
  const res = await postJson<{ segments: BriefingSegment[] }>('/api/briefings/refine', payload);
  return res.segments;
}

export async function generateHighlightsMetaSummary(payload: {
  articles: NewsArticle[];
  listenerFocus?: string;
  tone?: BriefingTone;
}): Promise<HighlightsMetaSummary> {
  const res = await postJson<{ metaSummary: HighlightsMetaSummary }>(
    '/api/highlights/summarize',
    payload
  );
  return res.metaSummary;
}

export async function synthesizeSpeech(payload: {
  format: 'solo' | 'podcast';
  lines?: ScriptLine[];
  text?: string;
  voiceName: string;
  coHostVoiceName?: string;
  tone: string;
  voiceTone?: string;
  normalizeLoudness?: boolean;
  targetLufs?: number;
}): Promise<{
  audioBase64: string;
  mimeType: string;
  loudness?: WavLoudnessMetrics;
}> {
  return postJson<{
    audioBase64: string;
    mimeType: string;
    loudness?: WavLoudnessMetrics;
  }>('/api/tts/synthesize', payload);
}

export async function sendEditorChatMessage(payload: {
  messages: Array<{ role: 'user' | 'model'; text: string }>;
  articles: NewsArticle[];
  briefingTitle?: string;
  briefingTakeaways?: string[];
}): Promise<{ reply: string; citations: CitationRef[] }> {
  const res = await postJson<{ reply: string; citations?: CitationRef[] }>('/api/chat', payload);
  return {
    reply: res.reply,
    citations: res.citations || [],
  };
}

export async function createBriefingShare(
  briefing: AudioBriefing,
  ttlHours: ShareTtlHours = 72,
  authOpts?: ShareAuthOptions
): Promise<CreateShareResult> {
  return postJson<CreateShareResult>(
    '/api/shares',
    { briefing, ttlHours },
    buildShareHeaders(authOpts)
  );
}

export async function fetchSharedBriefing(shareId: string): Promise<{
  share: SharedBriefingManifest;
}> {
  const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      typeof data?.error === 'string'
        ? data.error
        : `Could not load shared briefing (${res.status}).`
    ) as Error & { status?: number; expired?: boolean };
    err.status = res.status;
    err.expired = Boolean(data?.expired);
    throw err;
  }
  return data as { share: SharedBriefingManifest };
}

export async function revokeBriefingShare(
  shareId: string,
  authOpts?: ShareAuthOptions
): Promise<void> {
  const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
    headers: buildShareHeaders(authOpts),
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      typeof data?.error === 'string' ? data.error : 'Could not revoke share link.'
    );
  }
}

export async function analyzeWebsiteForMockup(payload: {
  url?: string;
  rawNotes?: string;
}): Promise<{
  project: Omit<SiteMockupProject, 'id' | 'updatedAt' | 'siteNotes'>;
  extractedColors: string[];
  brandSwatches?: MockupColorSwatch[];
  usedFallback?: boolean;
}> {
  return postJson('/api/mockup/analyze', payload);
}

export async function extractWebsiteBrandColors(url: string): Promise<{
  sourceUrl: string;
  brandName?: string;
  swatches: MockupColorSwatch[];
  suggestedPrimary: string;
  suggestedAccent: string;
  suggestedCanvasMode: MockupCanvasMode;
  usedFallback?: boolean;
}> {
  return postJson('/api/mockup/extract-colors', { url });
}

export async function suggestWebsiteFontPairings(payload: {
  url: string;
  brandName?: string;
  industry?: string;
}): Promise<{
  sourceUrl: string;
  brandName?: string;
  detectedSiteFonts: string[];
  pairings: import('../types').MockupFontPairing[];
  usedFallback?: boolean;
}> {
  return postJson('/api/mockup/suggest-fonts', payload);
}

export async function rewriteMockupSection(payload: {
  section: 'hero' | 'services' | 'projects' | 'about';
  project: SiteMockupProject;
  instruction: string;
}): Promise<{
  section: 'hero' | 'services' | 'projects' | 'about';
  patch: Partial<Pick<SiteMockupProject, 'hero' | 'services' | 'projects' | 'about'>>;
}> {
  return postJson('/api/mockup/rewrite', payload);
}

export async function createMockupShare(
  project: SiteMockupProject,
  ttlHours: ShareTtlHours = 72,
  note = '',
  authOpts?: ShareAuthOptions
): Promise<CreateMockupShareResult> {
  return postJson<CreateMockupShareResult>(
    '/api/mockup-shares',
    {
      project,
      ttlHours,
      note,
    },
    buildShareHeaders(authOpts)
  );
}

export async function updateMockupShare(
  shareId: string,
  project: SiteMockupProject,
  ttlHours: ShareTtlHours = 72,
  note = '',
  authOpts?: ShareAuthOptions
): Promise<CreateMockupShareResult & { updatedAt?: string }> {
  const res = await fetch(`/api/mockup-shares/${encodeURIComponent(shareId)}`, {
    method: 'PUT',
    headers: buildShareHeaders(authOpts),
    body: JSON.stringify({ project, ttlHours, note }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data?.error === 'string'
        ? data.error
        : `Could not update shared mockup (${res.status}).`
    );
  }
  return data as CreateMockupShareResult & { updatedAt?: string };
}

export async function fetchSharedMockup(shareId: string): Promise<{
  share: SharedMockupManifest;
}> {
  const res = await fetch(`/api/mockup-shares/${encodeURIComponent(shareId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      typeof data?.error === 'string'
        ? data.error
        : `Could not load shared mockup (${res.status}).`
    ) as Error & { status?: number; expired?: boolean };
    err.status = res.status;
    err.expired = Boolean(data?.expired);
    throw err;
  }
  return data as { share: SharedMockupManifest };
}

export async function revokeMockupShare(
  shareId: string,
  authOpts?: ShareAuthOptions
): Promise<void> {
  const res = await fetch(`/api/mockup-shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
    headers: buildShareHeaders(authOpts),
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      typeof data?.error === 'string' ? data.error : 'Could not revoke mockup preview link.'
    );
  }
}
