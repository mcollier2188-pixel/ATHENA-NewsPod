import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestoreError';
import type {
  ArticleHighlight,
  AudioBriefing,
  BriefingPreferences,
  BriefingSegment,
  BriefingTone,
  BroadcastFormat,
  CitationRef,
  CommuteDuration,
  NewsArticle,
  PlaybackPosition,
  SourceType,
  VoiceName,
  VoiceTone,
  WorkspaceLinkItem,
  WorkspaceLinkKind,
} from '../types';
import { ensureArticlePassages } from '../utils/passages';

const SOURCES_COLLECTION = 'notebookSources';
const BRIEFINGS_COLLECTION = 'briefingArchives';
const LINKS_COLLECTION = 'workspaceLinks';

function sanitizeIdSuffix(raw: string, maxLen: number): string {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'item').slice(0, maxLen);
}

export function buildSourceDocId(ownerId: string, sourceId: string): string {
  return `src_${ownerId}_${sanitizeIdSuffix(sourceId, 56)}`;
}

export function buildBriefingDocId(ownerId: string, briefingId: string): string {
  return `brf_${ownerId}_${sanitizeIdSuffix(briefingId, 56)}`;
}

export function buildWorkspaceLinkDocId(
  ownerId: string,
  kind: WorkspaceLinkKind,
  externalId: string
): string {
  return `lnk_${ownerId}_${kind}_${sanitizeIdSuffix(externalId, 48)}`;
}

function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' ? val.trim() : '';
  const resolved = s || fallback;
  return resolved.slice(0, maxLen);
}

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
  const num = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.max(min, Math.min(max, num));
}

function sanitizeImageUrl(url?: string): string {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.length > 2048) {
    return '';
  }
  return trimmed;
}

function sanitizeSourceType(type?: SourceType): SourceType {
  if (
    type === 'article' ||
    type === 'pdf' ||
    type === 'docx' ||
    type === 'txt' ||
    type === 'markdown'
  ) {
    return type;
  }
  return 'article';
}

function sanitizeCitationMap(c: CitationRef): Record<string, unknown> {
  return {
    marker: clampNumber(c.marker, 1, 999, 1),
    sourceId: clampStr(c.sourceId, 128, 'src'),
    sourceTitle: clampStr(c.sourceTitle, 300, 'Source'),
    passageIndex: clampNumber(c.passageIndex, 1, 9999, 1),
    excerpt: clampStr(c.excerpt, 600, ''),
  };
}

function sanitizeSegmentMap(seg: BriefingSegment): Record<string, unknown> {
  const cleanLines = (Array.isArray(seg.lines) ? seg.lines : [])
    .slice(0, 80)
    .map((line) => ({
      speaker: clampStr(line?.speaker, 64, 'Host'),
      text: clampStr(line?.text, 2500, ''),
    }))
    .filter((l) => l.text.length > 0);

  const mapObj: Record<string, unknown> = {
    id: clampStr(seg.id, 128, 'seg-1'),
    title: clampStr(seg.title, 300, 'Chapter'),
    category: clampStr(seg.category, 120, 'Briefing'),
    sourceTitles: (Array.isArray(seg.sourceTitles) ? seg.sourceTitles : [])
      .map((t) => clampStr(t, 300))
      .filter((t) => t.length > 0)
      .slice(0, 20),
    keyPoint: clampStr(seg.keyPoint, 600, ''),
    estimatedSeconds: clampNumber(seg.estimatedSeconds, 5, 3600, 60),
    lines: cleanLines,
    citations: (Array.isArray(seg.citations) ? seg.citations : [])
      .slice(0, 24)
      .map(sanitizeCitationMap),
  };

  if (seg.coHostVoiceName) {
    mapObj.coHostVoiceName = clampStr(seg.coHostVoiceName, 64);
  }
  if (
    typeof seg.audioDurationSeconds === 'number' &&
    Number.isFinite(seg.audioDurationSeconds) &&
    seg.audioDurationSeconds > 0
  ) {
    mapObj.audioDurationSeconds = clampNumber(seg.audioDurationSeconds, 1, 7200, 60);
  }
  if (typeof seg.audioStale === 'boolean') {
    mapObj.audioStale = seg.audioStale;
  }

  return mapObj;
}

function sanitizePreferencesMap(prefs: BriefingPreferences) {
  const validDuration: CommuteDuration =
    prefs.durationMinutes === 3 || prefs.durationMinutes === 5 || prefs.durationMinutes === 10
      ? prefs.durationMinutes
      : 5;
  const validFormat: BroadcastFormat = prefs.format === 'solo' ? 'solo' : 'podcast';
  const validTone: BriefingTone =
    prefs.tone === 'executive' ||
    prefs.tone === 'conversational' ||
    prefs.tone === 'analytical' ||
    prefs.tone === 'upbeat'
      ? prefs.tone
      : 'executive';
  const validVoiceTone: VoiceTone =
    prefs.voiceTone === 'professional' ||
    prefs.voiceTone === 'casual' ||
    prefs.voiceTone === 'energetic' ||
    prefs.voiceTone === 'soothing'
      ? prefs.voiceTone
      : 'professional';

  const cleanVoices: Record<string, string> = {};
  const entries = Object.entries(prefs.segmentCoHostVoices || {}).slice(0, 40);
  for (const [k, v] of entries) {
    if (k && typeof v === 'string' && v.trim()) {
      cleanVoices[k.slice(0, 128)] = v.trim().slice(0, 64);
    }
  }

  return {
    durationMinutes: validDuration,
    format: validFormat,
    tone: validTone,
    voiceTone: validVoiceTone,
    voiceName: clampStr(prefs.voiceName, 64, 'Kore'),
    coHostVoiceName: clampStr(prefs.coHostVoiceName, 64, 'Puck'),
    dynamicPanel: Boolean(prefs.dynamicPanel),
    segmentCoHostVoices: cleanVoices,
    listenerFocus: clampStr(prefs.listenerFocus, 2000, ''),
    personalizedIntroduction: clampStr(prefs.personalizedIntroduction, 2000, ''),
  };
}

export interface FirestorePlaybackMap {
  segmentIndex: number;
  currentTime: number;
  duration: number;
  playbackRate: number;
  completed: boolean;
  maxListenedSeconds: number;
  updatedAtIso: string;
}

function sanitizePlaybackMap(pos?: Partial<PlaybackPosition> | FirestorePlaybackMap | null): FirestorePlaybackMap {
  const updatedIso =
    pos && 'updatedAtIso' in pos && typeof pos.updatedAtIso === 'string'
      ? pos.updatedAtIso
      : pos && 'updatedAt' in pos && typeof pos.updatedAt === 'string'
        ? pos.updatedAt
        : '';

  return {
    segmentIndex: Math.round(clampNumber(pos?.segmentIndex, 0, 24, 0)),
    currentTime: clampNumber(pos?.currentTime, 0, 14400, 0),
    duration: clampNumber(pos?.duration, 0, 14400, 0),
    playbackRate: clampNumber(pos?.playbackRate, 0.5, 3, 1),
    completed: Boolean(pos?.completed),
    maxListenedSeconds: Math.round(clampNumber(pos?.maxListenedSeconds, 0, 86400, 0)),
    updatedAtIso: clampStr(updatedIso, 64, ''),
  };
}

function sanitizeHighlightList(
  rawHighlights?: ArticleHighlight[] | unknown
): ArticleHighlight[] {
  if (!Array.isArray(rawHighlights)) return [];
  const seen = new Set<string>();
  const cleaned: ArticleHighlight[] = [];

  for (let i = 0; i < rawHighlights.length; i++) {
    const item = rawHighlights[i] as Partial<ArticleHighlight> | null | undefined;
    if (!item || typeof item !== 'object') continue;
    const text = clampStr(item.text, 600, '');
    if (text.length < 2) continue;
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const safeId = `hl_${sanitizeIdSuffix(item.id || `${i + 1}`, 64)}`;
    const passageIndex = Math.round(
      clampNumber(item.passageIndex, 0, 999, 0)
    );
    const createdAt = clampStr(
      item.createdAt,
      64,
      new Date().toISOString()
    );

    cleaned.push({
      id: safeId,
      text,
      passageIndex,
      createdAt,
    });

    if (cleaned.length >= 20) break;
  }

  return cleaned;
}

function buildMutableSourceFields(article: NewsArticle) {
  return {
    title: clampStr(article.title, 300, 'Untitled Source'),
    source: clampStr(article.source, 200, 'Dispatch Notebook'),
    sourceType: sanitizeSourceType(article.sourceType),
    fileSizeLabel: clampStr(article.fileSizeLabel, 64, ''),
    category: clampStr(article.category, 120, 'General'),
    tags: (Array.isArray(article.tags) ? article.tags : [])
      .map((t) => clampStr(t, 80))
      .filter((t) => t.length > 0)
      .slice(0, 12),
    url: clampStr(article.url, 2048, ''),
    summary: clampStr(article.summary, 2000, ''),
    keyFacts: (Array.isArray(article.keyFacts) ? article.keyFacts : [])
      .map((f) => clampStr(f, 300))
      .filter((f) => f.length > 0)
      .slice(0, 12),
    highlights: sanitizeHighlightList(article.highlights),
    content: typeof article.content === 'string' ? article.content.slice(0, 30000) : '',
    estimatedReadMinutes: Math.round(
      clampNumber(article.estimatedReadMinutes, 1, 240, 3)
    ),
    selected: Boolean(article.selected),
    readLater: Boolean(article.readLater),
    shelvedAt: clampStr(article.shelvedAt, 64, ''),
    driveFileId: clampStr(article.driveFileId, 128, ''),
    driveWebViewLink: clampStr(article.driveWebViewLink, 2048, ''),
    driveMimeType: clampStr(article.driveMimeType, 128, ''),
    imageUrl: sanitizeImageUrl(article.imageUrl),
    addedAt: clampStr(article.addedAt, 64, new Date().toISOString()),
  };
}

function parseSourceFromDoc(data: Record<string, unknown>): NewsArticle {
  const highlights = sanitizeHighlightList(data.highlights);
  return ensureArticlePassages({
    id: clampStr(data.sourceId, 128, 'src-unknown'),
    title: clampStr(data.title, 300, 'Untitled Source'),
    source: clampStr(data.source, 200, 'Dispatch Notebook'),
    sourceType: sanitizeSourceType(data.sourceType as SourceType | undefined),
    fileSizeLabel: clampStr(data.fileSizeLabel, 64) || undefined,
    category: clampStr(data.category, 120, 'General'),
    tags: Array.isArray(data.tags)
      ? data.tags.filter((t): t is string => typeof t === 'string')
      : [],
    url: clampStr(data.url, 2048) || undefined,
    summary: clampStr(data.summary, 2000, ''),
    keyFacts: Array.isArray(data.keyFacts)
      ? data.keyFacts.filter((k): k is string => typeof k === 'string')
      : [],
    highlights: highlights.length > 0 ? highlights : undefined,
    content: typeof data.content === 'string' ? data.content : '',
    estimatedReadMinutes: clampNumber(data.estimatedReadMinutes, 1, 240, 3),
    selected: Boolean(data.selected),
    readLater: Boolean(data.readLater),
    shelvedAt: clampStr(data.shelvedAt, 64) || undefined,
    driveFileId: clampStr(data.driveFileId, 128) || undefined,
    driveWebViewLink: clampStr(data.driveWebViewLink, 2048) || undefined,
    driveMimeType: clampStr(data.driveMimeType, 128) || undefined,
    imageUrl: clampStr(data.imageUrl, 2048) || undefined,
    addedAt: clampStr(data.addedAt, 64, new Date().toISOString()),
  });
}

export function subscribeToNotebookSources(
  ownerId: string,
  onNext: (sources: NewsArticle[]) => void,
  onSyncError?: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, SOURCES_COLLECTION), where('ownerId', '==', ownerId));
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs
        .map((d) => parseSourceFromDoc(d.data() as Record<string, unknown>))
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
      onNext(items);
    },
    (err) => {
      if (onSyncError) onSyncError(err);
      handleFirestoreError(err, OperationType.LIST, SOURCES_COLLECTION);
    }
  );
}

export async function upsertNotebookSourceToFirestore(
  ownerId: string,
  article: NewsArticle
): Promise<void> {
  const docId = buildSourceDocId(ownerId, article.id);
  const path = `${SOURCES_COLLECTION}/${docId}`;
  const docRef = doc(db, SOURCES_COLLECTION, docId);
  const mutable = buildMutableSourceFields(article);

  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      await updateDoc(docRef, {
        ...mutable,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(docRef, {
        docId,
        sourceId: clampStr(article.id, 128, 'src-1'),
        ownerId,
        ...mutable,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function batchUpsertNotebookSourcesToFirestore(
  ownerId: string,
  articles: NewsArticle[]
): Promise<void> {
  if (!ownerId || articles.length === 0) return;
  if (articles.length === 1) {
    await upsertNotebookSourceToFirestore(ownerId, articles[0]);
    return;
  }

  // Deduplicate by article ID (last write wins) and commit in chunks <= 200
  const dedupedMap = new Map<string, NewsArticle>();
  for (const art of articles) {
    if (art?.id) dedupedMap.set(art.id, art);
  }
  const uniqueArticles = Array.from(dedupedMap.values());
  const CHUNK_SIZE = 50;

  for (let offset = 0; offset < uniqueArticles.length; offset += CHUNK_SIZE) {
    const slice = uniqueArticles.slice(offset, offset + CHUNK_SIZE);
    const firstDocId = buildSourceDocId(ownerId, slice[0].id);
    const batchPath = `${SOURCES_COLLECTION}/${firstDocId}`;

    try {
      const entries = await Promise.all(
        slice.map(async (article) => {
          const docId = buildSourceDocId(ownerId, article.id);
          const docRef = doc(db, SOURCES_COLLECTION, docId);
          const existing = await getDoc(docRef);
          return { article, docId, docRef, exists: existing.exists() };
        })
      );

      const batch = writeBatch(db);
      for (const { article, docId, docRef, exists } of entries) {
        const mutable = buildMutableSourceFields(article);
        if (exists) {
          batch.update(docRef, {
            ...mutable,
            updatedAt: serverTimestamp(),
          });
        } else {
          batch.set(docRef, {
            docId,
            sourceId: clampStr(article.id, 128, 'src-1'),
            ownerId,
            ...mutable,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, batchPath);
    }
  }
}

export async function updateNotebookSourceHighlightsInFirestore(
  ownerId: string,
  article: NewsArticle
): Promise<void> {
  const docId = buildSourceDocId(ownerId, article.id);
  const path = `${SOURCES_COLLECTION}/${docId}`;
  const docRef = doc(db, SOURCES_COLLECTION, docId);
  const sanitizedHighlights = sanitizeHighlightList(article.highlights);

  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      await updateDoc(docRef, {
        highlights: sanitizedHighlights,
        updatedAt: serverTimestamp(),
      });
    } else {
      const mutable = buildMutableSourceFields({
        ...article,
        highlights: sanitizedHighlights,
      });
      await setDoc(docRef, {
        docId,
        sourceId: clampStr(article.id, 128, 'src-1'),
        ownerId,
        ...mutable,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteNotebookSourceFromFirestore(
  ownerId: string,
  sourceId: string
): Promise<void> {
  const docId = buildSourceDocId(ownerId, sourceId);
  const path = `${SOURCES_COLLECTION}/${docId}`;
  const docRef = doc(db, SOURCES_COLLECTION, docId);
  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      await deleteDoc(docRef);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

function buildMutableBriefingFields(
  briefing: AudioBriefing,
  playback: FirestorePlaybackMap
) {
  return {
    editionTitle: clampStr(briefing.editionTitle, 300, 'Dispatch Briefing'),
    editionSubtitle: clampStr(briefing.editionSubtitle, 500, ''),
    takeaways: (Array.isArray(briefing.takeaways) ? briefing.takeaways : [])
      .map((t) => clampStr(t, 500))
      .filter((t) => t.length > 0)
      .slice(0, 30),
    takeawayCitations: (Array.isArray(briefing.takeawayCitations)
      ? briefing.takeawayCitations
      : []
    )
      .slice(0, 30)
      .map(sanitizeCitationMap),
    preferences: sanitizePreferencesMap(briefing.preferences),
    articleTitles: (Array.isArray(briefing.articleTitles) ? briefing.articleTitles : [])
      .map((t) => clampStr(t, 300))
      .filter((t) => t.length > 0)
      .slice(0, 40),
    segments: (Array.isArray(briefing.segments) ? briefing.segments : [])
      .slice(0, 24)
      .map(sanitizeSegmentMap),
    playback,
    exportedDocId: clampStr(briefing.exportedDocId, 128, ''),
    exportedDocUrl: clampStr(briefing.exportedDocUrl, 2048, ''),
    exportedWavFileId: clampStr(briefing.exportedWavFileId, 128, ''),
    exportedWavUrl: clampStr(briefing.exportedWavUrl, 2048, ''),
    syncedTaskCount: Math.round(clampNumber(briefing.syncedTaskCount, 0, 500, 0)),
  };
}

export interface SyncedBriefingRecord {
  briefing: AudioBriefing;
  playback: PlaybackPosition | null;
}

function parseBriefingFromDoc(data: Record<string, unknown>): SyncedBriefingRecord {
  const briefingId = clampStr(data.briefingId, 128, 'brief-unknown');
  const rawPrefs = (data.preferences as Record<string, unknown>) || {};
  const prefs: BriefingPreferences = {
    durationMinutes:
      rawPrefs.durationMinutes === 3 ||
      rawPrefs.durationMinutes === 5 ||
      rawPrefs.durationMinutes === 10
        ? rawPrefs.durationMinutes
        : 5,
    format: rawPrefs.format === 'solo' ? 'solo' : 'podcast',
    tone:
      rawPrefs.tone === 'executive' ||
      rawPrefs.tone === 'conversational' ||
      rawPrefs.tone === 'analytical' ||
      rawPrefs.tone === 'upbeat'
        ? rawPrefs.tone
        : 'executive',
    voiceTone:
      rawPrefs.voiceTone === 'professional' ||
      rawPrefs.voiceTone === 'casual' ||
      rawPrefs.voiceTone === 'energetic' ||
      rawPrefs.voiceTone === 'soothing'
        ? rawPrefs.voiceTone
        : 'professional',
    voiceName: (clampStr(rawPrefs.voiceName, 64, 'Kore') as VoiceName) || 'Kore',
    coHostVoiceName:
      (clampStr(rawPrefs.coHostVoiceName, 64, 'Puck') as VoiceName) || 'Puck',
    dynamicPanel: Boolean(rawPrefs.dynamicPanel),
    segmentCoHostVoices:
      rawPrefs.segmentCoHostVoices && typeof rawPrefs.segmentCoHostVoices === 'object'
        ? (rawPrefs.segmentCoHostVoices as Record<string, VoiceName>)
        : {},
    listenerFocus: clampStr(rawPrefs.listenerFocus, 2000, ''),
    personalizedIntroduction:
      clampStr(rawPrefs.personalizedIntroduction, 2000, '') || undefined,
  };

  const rawSegments = Array.isArray(data.segments) ? data.segments : [];
  const segments: BriefingSegment[] = rawSegments.map((rawSeg, i) => {
    const s = (rawSeg as Record<string, unknown>) || {};
    const lines = Array.isArray(s.lines)
      ? s.lines.map((ln) => {
          const l = (ln as Record<string, unknown>) || {};
          return {
            speaker: clampStr(l.speaker, 64, 'Host'),
            text: clampStr(l.text, 2500, ''),
          };
        })
      : [];
    return {
      id: clampStr(s.id, 128, `seg-${i + 1}`),
      title: clampStr(s.title, 300, `Chapter ${i + 1}`),
      category: clampStr(s.category, 120, 'Briefing'),
      sourceTitles: Array.isArray(s.sourceTitles)
        ? s.sourceTitles.filter((t): t is string => typeof t === 'string')
        : [],
      keyPoint: clampStr(s.keyPoint, 600, ''),
      estimatedSeconds: clampNumber(s.estimatedSeconds, 5, 3600, 60),
      lines,
      citations: Array.isArray(s.citations) ? (s.citations as CitationRef[]) : undefined,
      coHostVoiceName: s.coHostVoiceName
        ? (clampStr(s.coHostVoiceName, 64) as VoiceName)
        : undefined,
      audioDurationSeconds:
        typeof s.audioDurationSeconds === 'number' ? s.audioDurationSeconds : undefined,
      audioStale: typeof s.audioStale === 'boolean' ? s.audioStale : undefined,
    };
  });

  const briefing: AudioBriefing = {
    id: briefingId,
    createdAt: clampStr(data.briefingCreatedAt, 64, new Date().toISOString()),
    editionTitle: clampStr(data.editionTitle, 300, 'Dispatch Briefing'),
    editionSubtitle: clampStr(data.editionSubtitle, 500, ''),
    takeaways: Array.isArray(data.takeaways)
      ? data.takeaways.filter((t): t is string => typeof t === 'string')
      : [],
    takeawayCitations: Array.isArray(data.takeawayCitations)
      ? (data.takeawayCitations as CitationRef[])
      : undefined,
    preferences: prefs,
    articleTitles: Array.isArray(data.articleTitles)
      ? data.articleTitles.filter((t): t is string => typeof t === 'string')
      : [],
    segments,
    exportedDocId: clampStr(data.exportedDocId, 128) || undefined,
    exportedDocUrl: clampStr(data.exportedDocUrl, 2048) || undefined,
    exportedWavFileId: clampStr(data.exportedWavFileId, 128) || undefined,
    exportedWavUrl: clampStr(data.exportedWavUrl, 2048) || undefined,
    syncedTaskCount:
      typeof data.syncedTaskCount === 'number' && data.syncedTaskCount > 0
        ? data.syncedTaskCount
        : undefined,
  };

  const pb = (data.playback as Record<string, unknown>) || null;
  let playback: PlaybackPosition | null = null;
  if (pb && typeof pb.updatedAtIso === 'string' && pb.updatedAtIso.length > 0) {
    playback = {
      briefingId,
      segmentIndex: clampNumber(pb.segmentIndex, 0, 24, 0),
      currentTime: clampNumber(pb.currentTime, 0, 14400, 0),
      duration: clampNumber(pb.duration, 0, 14400, 0),
      playbackRate: clampNumber(pb.playbackRate, 0.5, 3, 1),
      updatedAt: pb.updatedAtIso,
      completed: Boolean(pb.completed),
      maxListenedSeconds: clampNumber(pb.maxListenedSeconds, 0, 86400, 0),
    };
  }

  return { briefing, playback };
}

export function subscribeToBriefingArchives(
  ownerId: string,
  onNext: (records: SyncedBriefingRecord[]) => void,
  onSyncError?: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, BRIEFINGS_COLLECTION), where('ownerId', '==', ownerId));
  return onSnapshot(
    q,
    (snap) => {
      const records = snap.docs
        .map((d) => parseBriefingFromDoc(d.data() as Record<string, unknown>))
        .sort((a, b) => b.briefing.createdAt.localeCompare(a.briefing.createdAt));
      onNext(records);
    },
    (err) => {
      if (onSyncError) onSyncError(err);
      handleFirestoreError(err, OperationType.LIST, BRIEFINGS_COLLECTION);
    }
  );
}

export async function upsertBriefingArchiveToFirestore(
  ownerId: string,
  briefing: AudioBriefing,
  playback?: PlaybackPosition | null
): Promise<void> {
  const docId = buildBriefingDocId(ownerId, briefing.id);
  const path = `${BRIEFINGS_COLLECTION}/${docId}`;
  const docRef = doc(db, BRIEFINGS_COLLECTION, docId);

  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      const existingPlayback = existing.data()?.playback as FirestorePlaybackMap | undefined;
      const resolvedPlayback = playback
        ? sanitizePlaybackMap(playback)
        : sanitizePlaybackMap(existingPlayback ?? null);
      const mutable = buildMutableBriefingFields(briefing, resolvedPlayback);
      await updateDoc(docRef, {
        ...mutable,
        updatedAt: serverTimestamp(),
      });
    } else {
      const resolvedPlayback = sanitizePlaybackMap(playback ?? null);
      const mutable = buildMutableBriefingFields(briefing, resolvedPlayback);
      await setDoc(docRef, {
        docId,
        briefingId: clampStr(briefing.id, 128, 'brief-1'),
        ownerId,
        briefingCreatedAt: clampStr(briefing.createdAt, 64, new Date().toISOString()),
        ...mutable,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function updateBriefingPlaybackInFirestore(
  ownerId: string,
  briefingId: string,
  playback: PlaybackPosition
): Promise<void> {
  const docId = buildBriefingDocId(ownerId, briefingId);
  const path = `${BRIEFINGS_COLLECTION}/${docId}`;
  const docRef = doc(db, BRIEFINGS_COLLECTION, docId);
  try {
    const existing = await getDoc(docRef);
    if (!existing.exists()) return;
    await updateDoc(docRef, {
      playback: sanitizePlaybackMap(playback),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteBriefingArchiveFromFirestore(
  ownerId: string,
  briefingId: string
): Promise<void> {
  const docId = buildBriefingDocId(ownerId, briefingId);
  const path = `${BRIEFINGS_COLLECTION}/${docId}`;
  const docRef = doc(db, BRIEFINGS_COLLECTION, docId);
  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      await deleteDoc(docRef);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export function subscribeToWorkspaceLinks(
  ownerId: string,
  onNext: (links: WorkspaceLinkItem[]) => void,
  onSyncError?: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, LINKS_COLLECTION), where('ownerId', '==', ownerId));
  return onSnapshot(
    q,
    (snap) => {
      const items: WorkspaceLinkItem[] = snap.docs
        .map((d) => {
          const data = d.data() as Record<string, unknown>;
          return {
            linkId: clampStr(data.linkId, 128, d.id),
            ownerId: clampStr(data.ownerId, 128, ownerId),
            kind: (data.kind as WorkspaceLinkKind) || 'drive_source',
            externalId: clampStr(data.externalId, 200, 'ext'),
            title: clampStr(data.title, 300, 'Workspace Link'),
            url: clampStr(data.url, 2048, ''),
            sourceId: clampStr(data.sourceId, 128) || undefined,
            briefingId: clampStr(data.briefingId, 128) || undefined,
            createdAtIso: clampStr(data.createdAtIso, 64, new Date().toISOString()),
          };
        })
        .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
      onNext(items);
    },
    (err) => {
      if (onSyncError) onSyncError(err);
      handleFirestoreError(err, OperationType.LIST, LINKS_COLLECTION);
    }
  );
}

export async function upsertWorkspaceLinkToFirestore(
  ownerId: string,
  input: {
    kind: WorkspaceLinkKind;
    externalId: string;
    title: string;
    url?: string;
    sourceId?: string;
    briefingId?: string;
  }
): Promise<WorkspaceLinkItem> {
  const linkId = buildWorkspaceLinkDocId(ownerId, input.kind, input.externalId);
  const path = `${LINKS_COLLECTION}/${linkId}`;
  const docRef = doc(db, LINKS_COLLECTION, linkId);
  const nowIso = new Date().toISOString();

  const mutable = {
    title: clampStr(input.title, 300, 'Workspace Item'),
    url: clampStr(input.url, 2048, ''),
    sourceId: clampStr(input.sourceId, 128, ''),
    briefingId: clampStr(input.briefingId, 128, ''),
    createdAtIso: nowIso,
  };

  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      await updateDoc(docRef, {
        ...mutable,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(docRef, {
        linkId,
        ownerId,
        kind: input.kind,
        externalId: clampStr(input.externalId, 200, 'ext'),
        ...mutable,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }

  return {
    linkId,
    ownerId,
    kind: input.kind,
    externalId: clampStr(input.externalId, 200, 'ext'),
    title: mutable.title,
    url: mutable.url,
    sourceId: mutable.sourceId || undefined,
    briefingId: mutable.briefingId || undefined,
    createdAtIso: nowIso,
  };
}

export async function deleteWorkspaceLinkFromFirestore(
  ownerId: string,
  linkId: string
): Promise<void> {
  const path = `${LINKS_COLLECTION}/${linkId}`;
  const docRef = doc(db, LINKS_COLLECTION, linkId);
  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      await deleteDoc(docRef);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
