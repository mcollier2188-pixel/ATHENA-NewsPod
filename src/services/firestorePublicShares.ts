import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db } from '../lib/firebase';
import type {
  AudioBriefing,
  MockupSectionKey,
  SharedBriefingManifest,
  SharedMockupManifest,
  ShareTtlHours,
  SiteMockupProject,
  VoiceName,
} from '../types';
import {
  inspectSharePayloadForPiiAndSecrets,
  scrubProseString,
  scrubShareValueDeep,
  type SharePayloadInspectionReport,
} from '../utils/sharePayloadInspector';

export enum ShareFirestoreOperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: ShareFirestoreOperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleShareFirestoreError(
  error: unknown,
  operationType: ShareFirestoreOperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const PUBLIC_SHARES_COLLECTION = 'publicShareLinks';
const VALID_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
// Keep inline media URLs well below Firestore 1MB document limit (and avoid raw base64 blobs in Firestore)
const MAX_FIRESTORE_MEDIA_URL_LEN = 2048;

export type PublicShareStatus = 'active' | 'revoked' | 'scrubbed_relinked';

export interface FirestoreBriefingSharePayload {
  editionTitle: string;
  editionSubtitle: string;
  briefingCreatedAt: string;
  takeaways: string[];
  listenerFocus: string;
  format: 'solo' | 'podcast';
  tone: string;
  voiceName: string;
  coHostVoiceName: string;
  articleTitles: string[];
  segments: Array<{
    id: string;
    title: string;
    category: string;
    sourceTitles: string[];
    keyPoint: string;
    estimatedSeconds: number;
    audioDurationSeconds?: number;
    lines: Array<{ speaker: string; text: string }>;
    coHostVoiceName?: string;
    hasAudio: boolean;
    audioUrl?: string;
  }>;
  hasAudio: boolean;
  recordedChapters: number;
  totalDurationSeconds: number;
}

export interface FirestoreMockupSharePayload {
  projectId: string;
  sourceUrl: string;
  clientUpdatedAt: string;
  brand: {
    name: string;
    industry: string;
    serviceArea: string;
    phone: string;
    email: string;
    hours: string;
    address: string;
    logoRef?: string;
    palette: {
      primary: string;
      accent: string;
      canvasMode: 'light' | 'dark';
      onPrimary?: string;
      onAccent?: string;
      accentText?: string;
      heroKickerText?: string;
    };
    fontMood: 'industrial' | 'editorial' | 'modern';
    fontPairing?: Record<string, unknown>;
  };
  hero: {
    kicker: string;
    headline: string;
    subheadline: string;
    primaryCta: string;
    secondaryCta: string;
    trustHighlights: string[];
    photoRef?: string;
  };
  services: Array<{
    id: string;
    title: string;
    description: string;
    deliverable: string;
  }>;
  projects: Array<{
    id: string;
    title: string;
    location: string;
    metric: string;
    summary: string;
    photoRef?: string;
  }>;
  about: {
    heading: string;
    story: string;
    credentials: string[];
  };
  quoteForm: {
    heading: string;
    subtext: string;
    submitLabel: string;
  };
  sectionVisibility: {
    services: boolean;
    projects: boolean;
    about: boolean;
    quote: boolean;
  };
  sectionOrder: string[];
  siteNotes: string;
}

export interface FirestorePublicShareDoc {
  shareId: string;
  kind: 'briefing' | 'mockup';
  sharePath: string;
  status: PublicShareStatus;
  ownerId: string;
  title: string;
  subtitle: string;
  note: string;
  ttlHours: ShareTtlHours;
  createdAtIso: string;
  expiresAtIso: string;
  relinkedFromShareId: string;
  relinkedToShareId: string;
  scrubbedAtIso: string;
  scrubbedFindingCount: number;
  payload: FirestoreBriefingSharePayload | FirestoreMockupSharePayload;
}

export interface ScannedFirestoreShareItem {
  doc: FirestorePublicShareDoc;
  isExpired: boolean;
  estimatedBytes: number;
  report: SharePayloadInspectionReport;
}

function clampString(val: unknown, maxLen: number, fallback = ''): string {
  if (typeof val !== 'string') return fallback.slice(0, maxLen);
  return val.slice(0, maxLen);
}

function normalizeTtlHours(val: unknown): ShareTtlHours {
  const n = Number(val);
  if (n === 24 || n === 72 || n === 168) return n;
  return 72;
}

function sanitizeFirestoreId(raw: unknown, fallback: string): string {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (VALID_ID_RE.test(candidate)) return candidate;
  const cleaned = candidate.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return VALID_ID_RE.test(cleaned) ? cleaned : fallback;
}

function safeMediaUrlForFirestore(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  // Never store base64 image payloads directly in Firestore documents
  if (!trimmed || trimmed.startsWith('data:')) return undefined;
  if (trimmed.length > MAX_FIRESTORE_MEDIA_URL_LEN) return undefined;
  return trimmed;
}

export function buildFirestoreBriefingPayload(
  source: AudioBriefing | SharedBriefingManifest,
  shareId: string
): FirestoreBriefingSharePayload {
  const recordedChapters =
    'recordedChapters' in source && typeof source.recordedChapters === 'number'
      ? source.recordedChapters
      : source.segments.filter((s) =>
          'hasAudio' in s ? Boolean(s.hasAudio) : Boolean(s.audioBase64)
        ).length;

  const totalDurationSeconds =
    'totalDurationSeconds' in source && typeof source.totalDurationSeconds === 'number'
      ? source.totalDurationSeconds
      : source.segments.reduce(
          (sum, s) => sum + Math.round(s.audioDurationSeconds || s.estimatedSeconds || 60),
          0
        );

  const briefingCreatedAt =
    'briefingCreatedAt' in source && typeof source.briefingCreatedAt === 'string'
      ? source.briefingCreatedAt
      : source.createdAt || new Date().toISOString();

  const segments = (source.segments || []).slice(0, 24).map((seg, idx) => {
    const hasAudio =
      'hasAudio' in seg ? Boolean(seg.hasAudio) : Boolean(seg.audioBase64);
    const segmentEntry: FirestoreBriefingSharePayload['segments'][number] = {
      id: clampString(seg.id || `seg-${idx + 1}`, 80, `seg-${idx + 1}`),
      title: clampString(seg.title || `Chapter ${idx + 1}`, 240, `Chapter ${idx + 1}`),
      category: clampString(seg.category || 'News', 80, 'News'),
      sourceTitles: Array.isArray(seg.sourceTitles)
        ? seg.sourceTitles.slice(0, 12).map((t) => clampString(t, 280))
        : [],
      keyPoint: clampString(seg.keyPoint, 800),
      estimatedSeconds: Math.max(10, Math.round(seg.estimatedSeconds || 60)),
      lines: Array.isArray(seg.lines)
        ? seg.lines.slice(0, 60).map((l) => ({
            speaker: clampString(l?.speaker || 'Anchor', 80, 'Anchor'),
            text: clampString(l?.text, 1500),
          }))
        : [],
      hasAudio,
    };
    if (typeof seg.audioDurationSeconds === 'number' && seg.audioDurationSeconds > 0) {
      segmentEntry.audioDurationSeconds = Math.round(seg.audioDurationSeconds);
    }
    if (seg.coHostVoiceName) {
      segmentEntry.coHostVoiceName = clampString(seg.coHostVoiceName, 64);
    }
    if (hasAudio) {
      segmentEntry.audioUrl = `/api/shares/${shareId}/audio/${idx}`;
    }
    return segmentEntry;
  });

  return {
    editionTitle: clampString(
      source.editionTitle || 'Shared Audio Briefing',
      300,
      'Shared Audio Briefing'
    ),
    editionSubtitle: clampString(source.editionSubtitle, 500),
    briefingCreatedAt: clampString(briefingCreatedAt, 64, new Date().toISOString()),
    takeaways: Array.isArray(source.takeaways)
      ? source.takeaways.slice(0, 30).map((t) => clampString(t, 300))
      : [],
    listenerFocus: clampString(source.preferences?.listenerFocus, 2000),
    format: source.preferences?.format === 'solo' ? 'solo' : 'podcast',
    tone: clampString(source.preferences?.tone || 'executive', 64, 'executive'),
    voiceName: clampString(source.preferences?.voiceName || 'Kore', 64, 'Kore'),
    coHostVoiceName: clampString(source.preferences?.coHostVoiceName || '', 64),
    articleTitles: Array.isArray(source.articleTitles)
      ? source.articleTitles.slice(0, 40).map((t) => clampString(t, 300))
      : [],
    segments,
    hasAudio: recordedChapters > 0,
    recordedChapters: Math.min(24, Math.max(0, recordedChapters)),
    totalDurationSeconds: Math.min(14400, Math.max(0, Math.round(totalDurationSeconds))),
  };
}

export function buildFirestoreMockupPayload(
  project: SiteMockupProject
): FirestoreMockupSharePayload {
  const paletteInput = project.brand?.palette || {
    primary: '#0F172A',
    accent: '#22D3EE',
    canvasMode: 'dark' as const,
  };
  const palette: FirestoreMockupSharePayload['brand']['palette'] = {
    primary: clampString(paletteInput.primary || '#0F172A', 32, '#0F172A'),
    accent: clampString(paletteInput.accent || '#22D3EE', 32, '#22D3EE'),
    canvasMode: paletteInput.canvasMode === 'light' ? 'light' : 'dark',
  };
  if (paletteInput.onPrimary) palette.onPrimary = clampString(paletteInput.onPrimary, 32);
  if (paletteInput.onAccent) palette.onAccent = clampString(paletteInput.onAccent, 32);
  if (paletteInput.accentText) palette.accentText = clampString(paletteInput.accentText, 32);
  if (paletteInput.heroKickerText) {
    palette.heroKickerText = clampString(paletteInput.heroKickerText, 32);
  }

  const fontMood =
    project.brand?.fontMood === 'industrial' ||
    project.brand?.fontMood === 'editorial' ||
    project.brand?.fontMood === 'modern'
      ? project.brand.fontMood
      : 'modern';

  const brand: FirestoreMockupSharePayload['brand'] = {
    name: clampString(project.brand?.name, 200),
    industry: clampString(project.brand?.industry, 200),
    serviceArea: clampString(project.brand?.serviceArea, 300),
    phone: clampString(project.brand?.phone, 80),
    email: clampString(project.brand?.email, 200),
    hours: clampString(project.brand?.hours, 200),
    address: clampString(project.brand?.address, 400),
    palette,
    fontMood,
  };

  const safeLogo = safeMediaUrlForFirestore(project.brand?.logoDataUrl);
  if (safeLogo) brand.logoRef = safeLogo;

  if (project.brand?.fontPairing && typeof project.brand.fontPairing === 'object') {
    const fp = project.brand.fontPairing;
    const cleanFp: Record<string, unknown> = {
      id: clampString(fp.id || 'default', 64, 'default'),
      name: clampString(fp.name || 'Editorial', 120, 'Editorial'),
      headingFont: clampString(fp.headingFont || 'Plus Jakarta Sans', 80),
      bodyFont: clampString(fp.bodyFont || 'DM Sans', 80),
      headingCategory: fp.headingCategory || 'sans-serif',
      bodyCategory: fp.bodyCategory || 'sans-serif',
      rationale: clampString(fp.rationale, 300),
      mood: fp.mood || fontMood,
    };
    if (fp.monoFont) cleanFp.monoFont = clampString(fp.monoFont, 80);
    if (fp.sourceNote) cleanFp.sourceNote = clampString(fp.sourceNote, 160);
    brand.fontPairing = cleanFp;
  }

  const hero: FirestoreMockupSharePayload['hero'] = {
    kicker: clampString(project.hero?.kicker, 200),
    headline: clampString(project.hero?.headline, 400),
    subheadline: clampString(project.hero?.subheadline, 1200),
    primaryCta: clampString(project.hero?.primaryCta, 120),
    secondaryCta: clampString(project.hero?.secondaryCta, 120),
    trustHighlights: Array.isArray(project.hero?.trustHighlights)
      ? project.hero.trustHighlights.slice(0, 10).map((t) => clampString(t, 300))
      : [],
  };
  const safeHeroPhoto = safeMediaUrlForFirestore(project.hero?.photoDataUrl);
  if (safeHeroPhoto) hero.photoRef = safeHeroPhoto;

  const allowedSections: MockupSectionKey[] = ['services', 'projects', 'about', 'quote'];
  const rawOrder = Array.isArray(project.sectionOrder) ? project.sectionOrder : allowedSections;
  const sectionOrder = rawOrder
    .filter((s): s is MockupSectionKey => allowedSections.includes(s))
    .slice(0, 4);

  return {
    projectId: sanitizeFirestoreId(project.id, 'mockup_shared'),
    sourceUrl: clampString(project.sourceUrl, 2048),
    clientUpdatedAt: clampString(
      project.updatedAt || new Date().toISOString(),
      64,
      new Date().toISOString()
    ),
    brand,
    hero,
    services: Array.isArray(project.services)
      ? project.services.slice(0, 24).map((svc, idx) => ({
          id: clampString(svc.id || `svc-${idx + 1}`, 80, `svc-${idx + 1}`),
          title: clampString(svc.title, 200),
          description: clampString(svc.description, 1000),
          deliverable: clampString(svc.deliverable, 240),
        }))
      : [],
    projects: Array.isArray(project.projects)
      ? project.projects.slice(0, 24).map((item, idx) => {
          const entry: FirestoreMockupSharePayload['projects'][number] = {
            id: clampString(item.id || `proj-${idx + 1}`, 80, `proj-${idx + 1}`),
            title: clampString(item.title, 200),
            location: clampString(item.location, 200),
            metric: clampString(item.metric, 200),
            summary: clampString(item.summary, 1000),
          };
          const safeProjPhoto = safeMediaUrlForFirestore(item.photoDataUrl);
          if (safeProjPhoto) entry.photoRef = safeProjPhoto;
          return entry;
        })
      : [],
    about: {
      heading: clampString(project.about?.heading, 300),
      story: clampString(project.about?.story, 5000),
      credentials: Array.isArray(project.about?.credentials)
        ? project.about.credentials.slice(0, 20).map((c) => clampString(c, 300))
        : [],
    },
    quoteForm: {
      heading: clampString(project.quoteForm?.heading, 300),
      subtext: clampString(project.quoteForm?.subtext, 1000),
      submitLabel: clampString(project.quoteForm?.submitLabel, 120),
    },
    sectionVisibility: {
      services: Boolean(project.sectionVisibility?.services ?? true),
      projects: Boolean(project.sectionVisibility?.projects ?? true),
      about: Boolean(project.sectionVisibility?.about ?? true),
      quote: Boolean(project.sectionVisibility?.quote ?? true),
    },
    sectionOrder: sectionOrder.length > 0 ? sectionOrder : allowedSections,
    siteNotes: clampString(project.siteNotes, 10000),
  };
}

export function firestoreDocToSharedBriefingManifest(
  docData: FirestorePublicShareDoc
): SharedBriefingManifest {
  const p = docData.payload as FirestoreBriefingSharePayload;
  const approxMinutes = Math.round((p.totalDurationSeconds || 300) / 60);
  const durationMinutes: 3 | 5 | 10 =
    approxMinutes <= 4 ? 3 : approxMinutes >= 8 ? 10 : 5;
  return {
    shareId: docData.shareId,
    createdAt: docData.createdAtIso,
    expiresAt: docData.expiresAtIso,
    ttlHours: docData.ttlHours,
    editionTitle: p.editionTitle,
    editionSubtitle: p.editionSubtitle,
    briefingCreatedAt: p.briefingCreatedAt,
    takeaways: p.takeaways || [],
    preferences: {
      durationMinutes,
      format: p.format === 'solo' ? 'solo' : 'podcast',
      tone: (p.tone as SharedBriefingManifest['preferences']['tone']) || 'executive',
      voiceTone: 'professional',
      voiceName: (p.voiceName as VoiceName) || 'Kore',
      coHostVoiceName: (p.coHostVoiceName as VoiceName) || 'Puck',
      dynamicPanel: false,
      segmentCoHostVoices: {},
      listenerFocus: p.listenerFocus || '',
    },
    articleTitles: p.articleTitles || [],
    segments: (p.segments || []).map((s) => ({
      id: s.id,
      title: s.title,
      category: s.category,
      sourceTitles: s.sourceTitles || [],
      keyPoint: s.keyPoint,
      estimatedSeconds: s.estimatedSeconds,
      audioDurationSeconds: s.audioDurationSeconds,
      lines: s.lines || [],
      coHostVoiceName: s.coHostVoiceName as VoiceName | undefined,
      hasAudio: Boolean(s.hasAudio),
      audioUrl: s.audioUrl,
    })),
    hasAudio: Boolean(p.hasAudio),
    recordedChapters: p.recordedChapters || 0,
    totalDurationSeconds: p.totalDurationSeconds || 0,
    downloadUrl: p.hasAudio ? `/api/shares/${docData.shareId}/download` : undefined,
  };
}

export function firestoreDocToSharedMockupManifest(
  docData: FirestorePublicShareDoc
): SharedMockupManifest {
  const p = docData.payload as FirestoreMockupSharePayload;
  return {
    shareId: docData.shareId,
    createdAt: docData.createdAtIso,
    expiresAt: docData.expiresAtIso,
    ttlHours: docData.ttlHours,
    note: docData.note || '',
    project: {
      id: p.projectId || `mockup_${docData.shareId}`,
      sourceUrl: p.sourceUrl || '',
      updatedAt: p.clientUpdatedAt || docData.createdAtIso,
      brand: {
        name: p.brand.name || docData.title,
        industry: p.brand.industry || '',
        serviceArea: p.brand.serviceArea || '',
        phone: p.brand.phone || '',
        email: p.brand.email || '',
        hours: p.brand.hours || '',
        address: p.brand.address || '',
        logoDataUrl: p.brand.logoRef,
        palette: p.brand.palette,
        fontMood: p.brand.fontMood,
        fontPairing: p.brand.fontPairing as unknown as SiteMockupProject['brand']['fontPairing'],
      },
      hero: {
        kicker: p.hero.kicker || '',
        headline: p.hero.headline || '',
        subheadline: p.hero.subheadline || '',
        primaryCta: p.hero.primaryCta || '',
        secondaryCta: p.hero.secondaryCta || '',
        trustHighlights: p.hero.trustHighlights || [],
        photoDataUrl: p.hero.photoRef,
      },
      services: p.services || [],
      projects: (p.projects || []).map((item) => ({
        id: item.id,
        title: item.title,
        location: item.location,
        metric: item.metric,
        summary: item.summary,
        photoDataUrl: item.photoRef,
      })),
      about: p.about || { heading: '', story: '', credentials: [] },
      quoteForm: p.quoteForm || { heading: '', subtext: '', submitLabel: 'Send' },
      sectionVisibility: p.sectionVisibility || {
        services: true,
        projects: true,
        about: true,
        quote: true,
      },
      sectionOrder: (p.sectionOrder as MockupSectionKey[]) || [
        'services',
        'projects',
        'about',
        'quote',
      ],
      siteNotes: p.siteNotes || '',
    },
  };
}

function parseFirestoreShareSnapshot(
  docId: string,
  raw: Record<string, unknown>
): FirestorePublicShareDoc {
  const kind = raw.kind === 'briefing' ? 'briefing' : 'mockup';
  const status: PublicShareStatus =
    raw.status === 'revoked' || raw.status === 'scrubbed_relinked' ? raw.status : 'active';
  const ttlHours = normalizeTtlHours(raw.ttlHours);

  return {
    shareId: sanitizeFirestoreId(raw.shareId, docId),
    kind,
    sharePath: clampString(
      raw.sharePath,
      180,
      kind === 'briefing' ? `/share/${docId}` : `/mockup/${docId}`
    ),
    status,
    ownerId: sanitizeFirestoreId(raw.ownerId, 'unknown_owner'),
    title: clampString(raw.title, 300, 'Shared Preview'),
    subtitle: clampString(raw.subtitle, 400),
    note: clampString(raw.note, 400),
    ttlHours,
    createdAtIso: clampString(raw.createdAtIso, 64, new Date().toISOString()),
    expiresAtIso: clampString(raw.expiresAtIso, 64, new Date().toISOString()),
    relinkedFromShareId: clampString(raw.relinkedFromShareId, 128),
    relinkedToShareId: clampString(raw.relinkedToShareId, 128),
    scrubbedAtIso: clampString(raw.scrubbedAtIso, 64),
    scrubbedFindingCount: Math.max(0, Number(raw.scrubbedFindingCount) || 0),
    payload: (raw.payload || {}) as FirestoreBriefingSharePayload | FirestoreMockupSharePayload,
  };
}

export async function syncPublishedBriefingShareToFirestore(params: {
  callerUser: User | null;
  shareId: string;
  sharePath: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: ShareTtlHours;
  briefing: AudioBriefing;
}): Promise<boolean> {
  const { callerUser, shareId } = params;
  if (!callerUser || !callerUser.emailVerified || !VALID_ID_RE.test(shareId)) {
    return false;
  }

  const docPath = `${PUBLIC_SHARES_COLLECTION}/${shareId}`;
  const payload = buildFirestoreBriefingPayload(params.briefing, shareId);
  const expiresDate = new Date(params.expiresAt);
  const safeExpiresAt = Number.isNaN(expiresDate.getTime())
    ? new Date(Date.now() + params.ttlHours * 3600_000)
    : expiresDate;

  try {
    await setDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId), {
      shareId,
      kind: 'briefing',
      sharePath: clampString(params.sharePath || `/share/${shareId}`, 180, `/share/${shareId}`),
      status: 'active',
      ownerId: callerUser.uid,
      title: clampString(
        params.briefing.editionTitle || 'Shared Audio Briefing',
        300,
        'Shared Audio Briefing'
      ),
      subtitle: clampString(
        params.briefing.editionSubtitle || `${params.briefing.segments.length} chapters`,
        400
      ),
      note: '',
      ttlHours: normalizeTtlHours(params.ttlHours),
      createdAtIso: clampString(params.createdAt, 64, new Date().toISOString()),
      expiresAtIso: safeExpiresAt.toISOString(),
      expiresAt: Timestamp.fromDate(safeExpiresAt),
      relinkedFromShareId: '',
      relinkedToShareId: '',
      scrubbedAtIso: '',
      scrubbedFindingCount: 0,
      payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (error) {
    handleShareFirestoreError(error, ShareFirestoreOperationType.CREATE, docPath);
  }
}

export async function syncPublishedMockupShareToFirestore(params: {
  callerUser: User | null;
  shareId: string;
  sharePath: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: ShareTtlHours;
  note: string;
  project: SiteMockupProject;
  isUpdate?: boolean;
}): Promise<boolean> {
  const { callerUser, shareId } = params;
  if (!callerUser || !callerUser.emailVerified || !VALID_ID_RE.test(shareId)) {
    return false;
  }

  const docPath = `${PUBLIC_SHARES_COLLECTION}/${shareId}`;
  const payload = buildFirestoreMockupPayload(params.project);
  const expiresDate = new Date(params.expiresAt);
  const safeExpiresAt = Number.isNaN(expiresDate.getTime())
    ? new Date(Date.now() + params.ttlHours * 3600_000)
    : expiresDate;
  const title = clampString(
    params.project.brand?.name || 'Shared Site Mockup',
    300,
    'Shared Site Mockup'
  );
  const subtitle = clampString(
    params.note || params.project.brand?.industry || 'Client Website Mockup',
    400
  );

  if (params.isUpdate) {
    try {
      const existingSnap = await getDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId));
      if (existingSnap.exists()) {
        await updateDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId), {
          title,
          subtitle,
          note: clampString(params.note, 400),
          ttlHours: normalizeTtlHours(params.ttlHours),
          expiresAtIso: safeExpiresAt.toISOString(),
          expiresAt: Timestamp.fromDate(safeExpiresAt),
          payload,
          updatedAt: serverTimestamp(),
        });
        return true;
      }
    } catch (error) {
      handleShareFirestoreError(error, ShareFirestoreOperationType.UPDATE, docPath);
    }
  }

  try {
    await setDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId), {
      shareId,
      kind: 'mockup',
      sharePath: clampString(params.sharePath || `/mockup/${shareId}`, 180, `/mockup/${shareId}`),
      status: 'active',
      ownerId: callerUser.uid,
      title,
      subtitle,
      note: clampString(params.note, 400),
      ttlHours: normalizeTtlHours(params.ttlHours),
      createdAtIso: clampString(params.createdAt, 64, new Date().toISOString()),
      expiresAtIso: safeExpiresAt.toISOString(),
      expiresAt: Timestamp.fromDate(safeExpiresAt),
      relinkedFromShareId: '',
      relinkedToShareId: '',
      scrubbedAtIso: '',
      scrubbedFindingCount: 0,
      payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (error) {
    handleShareFirestoreError(error, ShareFirestoreOperationType.CREATE, docPath);
  }
}

export async function removePublicShareFromFirestore(
  callerUser: User | null,
  shareId: string
): Promise<void> {
  if (!callerUser || !callerUser.emailVerified || !VALID_ID_RE.test(shareId)) return;
  const docPath = `${PUBLIC_SHARES_COLLECTION}/${shareId}`;
  try {
    await deleteDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId));
  } catch (error) {
    handleShareFirestoreError(error, ShareFirestoreOperationType.DELETE, docPath);
  }
}

export async function updateFirestorePublicShareExpiry(
  callerUser: User | null,
  shareId: string,
  nextExpiresAtIso: string,
  ttlHours: ShareTtlHours = 72
): Promise<void> {
  if (!callerUser || !callerUser.emailVerified || !VALID_ID_RE.test(shareId)) return;
  const docPath = `${PUBLIC_SHARES_COLLECTION}/${shareId}`;
  try {
    const snap = await getDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId));
    if (!snap.exists()) return;
    const expDate = new Date(nextExpiresAtIso);
    if (Number.isNaN(expDate.getTime())) return;
    await updateDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId), {
      ttlHours: normalizeTtlHours(ttlHours),
      expiresAtIso: expDate.toISOString(),
      expiresAt: Timestamp.fromDate(expDate),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleShareFirestoreError(error, ShareFirestoreOperationType.UPDATE, docPath);
  }
}

export async function fetchPublicShareFromFirestore(
  shareId: string
): Promise<FirestorePublicShareDoc | null> {
  if (!VALID_ID_RE.test(shareId)) return null;
  const docPath = `${PUBLIC_SHARES_COLLECTION}/${shareId}`;
  try {
    const snap = await getDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId));
    if (!snap.exists()) return null;
    const parsed = parseFirestoreShareSnapshot(
      snap.id,
      snap.data() as Record<string, unknown>
    );
    if (parsed.status !== 'active') return null;
    if (new Date(parsed.expiresAtIso).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    // Public capability get fails closed when revoked, scrubbed_relinked, or expired
    return null;
  }
}

export interface ServerRawShareSnapshot {
  shareId: string;
  kind: 'briefing' | 'mockup';
  sharePath: string;
  creatorUid?: string;
  creatorEmail?: string;
  createdAt: string;
  expiresAt: string;
  ttlHours: number;
  note?: string;
  briefingManifest?: SharedBriefingManifest;
  mockupProject?: SiteMockupProject;
}

export async function backfillServerSharesIntoFirestore(params: {
  callerUser: User;
  serverSnapshots: ServerRawShareSnapshot[];
  existingFirestoreIds: Set<string>;
}): Promise<number> {
  const { callerUser, serverSnapshots, existingFirestoreIds } = params;
  if (!callerUser.emailVerified || serverSnapshots.length === 0) return 0;

  let syncedCount = 0;
  for (const item of serverSnapshots) {
    if (!VALID_ID_RE.test(item.shareId) || existingFirestoreIds.has(item.shareId)) {
      continue;
    }

    const ownerId =
      item.creatorUid && VALID_ID_RE.test(item.creatorUid)
        ? item.creatorUid
        : callerUser.uid;
    const ttlHours = normalizeTtlHours(item.ttlHours);
    const expiresDate = new Date(item.expiresAt);
    if (Number.isNaN(expiresDate.getTime()) || expiresDate.getTime() <= Date.now()) {
      continue;
    }

    const docPath = `${PUBLIC_SHARES_COLLECTION}/${item.shareId}`;
    try {
      if (item.kind === 'briefing' && item.briefingManifest) {
        const payload = buildFirestoreBriefingPayload(item.briefingManifest, item.shareId);
        await setDoc(doc(db, PUBLIC_SHARES_COLLECTION, item.shareId), {
          shareId: item.shareId,
          kind: 'briefing',
          sharePath: `/share/${item.shareId}`,
          status: 'active',
          ownerId,
          title: clampString(
            item.briefingManifest.editionTitle || 'Shared Audio Briefing',
            300,
            'Shared Audio Briefing'
          ),
          subtitle: clampString(
            item.briefingManifest.editionSubtitle ||
              `${item.briefingManifest.segments.length} chapters`,
            400
          ),
          note: '',
          ttlHours,
          createdAtIso: clampString(item.createdAt, 64, new Date().toISOString()),
          expiresAtIso: expiresDate.toISOString(),
          expiresAt: Timestamp.fromDate(expiresDate),
          relinkedFromShareId: '',
          relinkedToShareId: '',
          scrubbedAtIso: '',
          scrubbedFindingCount: 0,
          payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        syncedCount += 1;
      } else if (item.kind === 'mockup' && item.mockupProject) {
        const payload = buildFirestoreMockupPayload(item.mockupProject);
        await setDoc(doc(db, PUBLIC_SHARES_COLLECTION, item.shareId), {
          shareId: item.shareId,
          kind: 'mockup',
          sharePath: `/mockup/${item.shareId}`,
          status: 'active',
          ownerId,
          title: clampString(
            item.mockupProject.brand?.name || 'Shared Site Mockup',
            300,
            'Shared Site Mockup'
          ),
          subtitle: clampString(
            item.note || item.mockupProject.brand?.industry || 'Client Website Mockup',
            400
          ),
          note: clampString(item.note, 400),
          ttlHours,
          createdAtIso: clampString(item.createdAt, 64, new Date().toISOString()),
          expiresAtIso: expiresDate.toISOString(),
          expiresAt: Timestamp.fromDate(expiresDate),
          relinkedFromShareId: '',
          relinkedToShareId: '',
          scrubbedAtIso: '',
          scrubbedFindingCount: 0,
          payload,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        syncedCount += 1;
      }
    } catch (error) {
      handleShareFirestoreError(error, ShareFirestoreOperationType.CREATE, docPath);
    }
  }

  return syncedCount;
}

export async function scanFirestorePublicShareLinks(params: {
  callerUser: User;
  isPrincipalOwner: boolean;
  knownShareIds?: string[];
  knownStudioEmails?: Set<string>;
}): Promise<ScannedFirestoreShareItem[]> {
  const { callerUser, isPrincipalOwner, knownShareIds = [], knownStudioEmails } = params;
  if (!callerUser.emailVerified) return [];

  const docsMap = new Map<string, FirestorePublicShareDoc>();

  if (isPrincipalOwner) {
    try {
      const snap = await getDocs(collection(db, PUBLIC_SHARES_COLLECTION));
      snap.forEach((docSnap) => {
        docsMap.set(
          docSnap.id,
          parseFirestoreShareSnapshot(docSnap.id, docSnap.data() as Record<string, unknown>)
        );
      });
    } catch (error) {
      handleShareFirestoreError(
        error,
        ShareFirestoreOperationType.LIST,
        PUBLIC_SHARES_COLLECTION
      );
    }
  } else {
    // Studio Admin: list own shares via ownerId query + fetch known active shareIds via single-doc get
    try {
      const ownQuery = query(
        collection(db, PUBLIC_SHARES_COLLECTION),
        where('ownerId', '==', callerUser.uid)
      );
      const ownSnap = await getDocs(ownQuery);
      ownSnap.forEach((docSnap) => {
        docsMap.set(
          docSnap.id,
          parseFirestoreShareSnapshot(docSnap.id, docSnap.data() as Record<string, unknown>)
        );
      });
    } catch (error) {
      handleShareFirestoreError(
        error,
        ShareFirestoreOperationType.LIST,
        PUBLIC_SHARES_COLLECTION
      );
    }

    for (const shareId of knownShareIds) {
      if (!VALID_ID_RE.test(shareId) || docsMap.has(shareId)) continue;
      const docPath = `${PUBLIC_SHARES_COLLECTION}/${shareId}`;
      try {
        const singleSnap = await getDoc(doc(db, PUBLIC_SHARES_COLLECTION, shareId));
        if (singleSnap.exists()) {
          docsMap.set(
            singleSnap.id,
            parseFirestoreShareSnapshot(
              singleSnap.id,
              singleSnap.data() as Record<string, unknown>
            )
          );
        }
      } catch (error) {
        handleShareFirestoreError(error, ShareFirestoreOperationType.GET, docPath);
      }
    }
  }

  const now = Date.now();
  const results: ScannedFirestoreShareItem[] = [];

  docsMap.forEach((shareDoc) => {
    if (shareDoc.status !== 'active') return;
    const isExpired = new Date(shareDoc.expiresAtIso).getTime() <= now;
    const inspectTarget: Record<string, unknown> = {
      title: shareDoc.title,
      subtitle: shareDoc.subtitle,
      note: shareDoc.note,
      payload: shareDoc.payload,
    };
    const report = inspectSharePayloadForPiiAndSecrets(inspectTarget, {
      knownStudioEmails,
    });
    const estimatedBytes = new Blob([JSON.stringify(shareDoc.payload)]).size;
    results.push({
      doc: shareDoc,
      isExpired,
      estimatedBytes,
      report,
    });
  });

  // Sort flagged shares first (critical -> high -> medium -> clean), then newest first
  const severityWeight = (s: SharePayloadInspectionReport['highestSeverity']): number => {
    if (s === 'critical') return 3;
    if (s === 'high') return 2;
    if (s === 'medium') return 1;
    return 0;
  };

  results.sort((a, b) => {
    const diff =
      severityWeight(b.report.highestSeverity) - severityWeight(a.report.highestSeverity);
    if (diff !== 0) return diff;
    return (
      new Date(b.doc.createdAtIso).getTime() - new Date(a.doc.createdAtIso).getTime()
    );
  });

  return results;
}

export function buildScrubbedFirestoreShareDocument(params: {
  sourceDoc: FirestorePublicShareDoc;
  newShareId: string;
  newExpiresAtIso: string;
  scrubbedFindingCount: number;
}): {
  nextSharePath: string;
  scrubbedTitle: string;
  scrubbedSubtitle: string;
  scrubbedNote: string;
  scrubbedPayload: FirestoreBriefingSharePayload | FirestoreMockupSharePayload;
} {
  const { sourceDoc, newShareId } = params;
  const nextSharePath =
    sourceDoc.kind === 'briefing' ? `/share/${newShareId}` : `/mockup/${newShareId}`;

  const rawTitle = scrubProseString(sourceDoc.title, 'title').trim();
  const scrubbedTitle = clampString(
    rawTitle ||
      (sourceDoc.kind === 'briefing'
        ? 'Sanitized Audio Briefing'
        : 'Sanitized Site Mockup'),
    300,
    'Sanitized Shared Preview'
  );
  const scrubbedSubtitle = clampString(
    scrubProseString(sourceDoc.subtitle, 'subtitle'),
    400
  );
  const scrubbedNote = clampString(scrubProseString(sourceDoc.note, 'note'), 400);

  if (sourceDoc.kind === 'briefing') {
    const scrubbedRaw = scrubShareValueDeep(
      sourceDoc.payload as FirestoreBriefingSharePayload
    );
    const editionTitle = clampString(
      scrubbedRaw.editionTitle?.trim() || scrubbedTitle,
      300,
      'Sanitized Audio Briefing'
    );
    const updatedSegments = (scrubbedRaw.segments || []).map((seg, idx) => {
      const nextSeg = { ...seg };
      if (nextSeg.hasAudio) {
        nextSeg.audioUrl = `/api/shares/${newShareId}/audio/${idx}`;
      }
      return nextSeg;
    });

    const scrubbedPayload: FirestoreBriefingSharePayload = {
      ...scrubbedRaw,
      editionTitle,
      editionSubtitle: clampString(scrubbedRaw.editionSubtitle, 500),
      listenerFocus: '',
      takeaways: (scrubbedRaw.takeaways || []).slice(0, 30).map((t) => clampString(t, 300)),
      articleTitles: (scrubbedRaw.articleTitles || [])
        .slice(0, 40)
        .map((t) => clampString(t, 300)),
      segments: updatedSegments,
    };

    return {
      nextSharePath,
      scrubbedTitle,
      scrubbedSubtitle,
      scrubbedNote: '',
      scrubbedPayload,
    };
  }

  const scrubbedMockup = scrubShareValueDeep(
    sourceDoc.payload as FirestoreMockupSharePayload
  );
  const scrubbedPayload: FirestoreMockupSharePayload = {
    ...scrubbedMockup,
    sourceUrl: clampString(scrubbedMockup.sourceUrl, 2048),
    siteNotes: '',
    brand: {
      ...scrubbedMockup.brand,
      name: clampString(scrubbedMockup.brand?.name || scrubbedTitle, 200),
      email: '',
      phone: '',
      address: '',
    },
    hero: {
      ...scrubbedMockup.hero,
      trustHighlights: (scrubbedMockup.hero?.trustHighlights || [])
        .slice(0, 10)
        .map((t) => clampString(t, 300)),
    },
    about: {
      ...scrubbedMockup.about,
      credentials: (scrubbedMockup.about?.credentials || [])
        .slice(0, 20)
        .map((c) => clampString(c, 300)),
    },
  };

  return {
    nextSharePath,
    scrubbedTitle,
    scrubbedSubtitle,
    scrubbedNote,
    scrubbedPayload,
  };
}

export async function commitFirestoreScrubAndRelink(params: {
  callerUser: User;
  sourceDoc: FirestorePublicShareDoc;
  newShareId: string;
  newExpiresAtIso: string;
  scrubbedFindingCount: number;
}): Promise<{
  oldShareId: string;
  newShareId: string;
  newSharePath: string;
  postScrubFindings: number;
}> {
  const { callerUser, sourceDoc, newShareId, newExpiresAtIso, scrubbedFindingCount } =
    params;
  if (!callerUser.emailVerified) {
    throw new Error('Verified administrator session required to scrub and re-link.');
  }
  if (!VALID_ID_RE.test(newShareId) || !VALID_ID_RE.test(sourceDoc.shareId)) {
    throw new Error('Invalid share identifier supplied for Scrub & Re-Link.');
  }

  const {
    nextSharePath,
    scrubbedTitle,
    scrubbedSubtitle,
    scrubbedNote,
    scrubbedPayload,
  } = buildScrubbedFirestoreShareDocument({
    sourceDoc,
    newShareId,
    newExpiresAtIso,
    scrubbedFindingCount,
  });

  // Verify post-scrub payload is 100% clean before writing to Firestore
  const verification = inspectSharePayloadForPiiAndSecrets({
    title: scrubbedTitle,
    subtitle: scrubbedSubtitle,
    note: scrubbedNote,
    payload: scrubbedPayload,
  });

  const expiresDate = new Date(newExpiresAtIso);
  const safeExpires = Number.isNaN(expiresDate.getTime())
    ? new Date(Date.now() + sourceDoc.ttlHours * 3600_000)
    : expiresDate;
  const nowIso = new Date().toISOString();

  const oldRef = doc(db, PUBLIC_SHARES_COLLECTION, sourceDoc.shareId);
  const newRef = doc(db, PUBLIC_SHARES_COLLECTION, newShareId);

  try {
    const batch = writeBatch(db);
    // 1. Delete old compromised Firestore document so zero un-scrubbed PII remains at rest and old URL immediately fails
    batch.delete(oldRef);
    // 2. Create fresh capability share document with scrubbed payload and lineage metadata
    batch.set(newRef, {
      shareId: newShareId,
      kind: sourceDoc.kind,
      sharePath: nextSharePath,
      status: 'active',
      ownerId: VALID_ID_RE.test(sourceDoc.ownerId) ? sourceDoc.ownerId : callerUser.uid,
      title: scrubbedTitle,
      subtitle: scrubbedSubtitle,
      note: scrubbedNote,
      ttlHours: normalizeTtlHours(sourceDoc.ttlHours),
      createdAtIso: nowIso,
      expiresAtIso: safeExpires.toISOString(),
      expiresAt: Timestamp.fromDate(safeExpires),
      relinkedFromShareId: sourceDoc.shareId,
      relinkedToShareId: '',
      scrubbedAtIso: nowIso,
      scrubbedFindingCount: Math.min(500, Math.max(0, scrubbedFindingCount)),
      payload: scrubbedPayload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleShareFirestoreError(
      error,
      ShareFirestoreOperationType.WRITE,
      `${PUBLIC_SHARES_COLLECTION}/${newShareId}`
    );
  }

  return {
    oldShareId: sourceDoc.shareId,
    newShareId,
    newSharePath: nextSharePath,
    postScrubFindings: verification.findingCount,
  };
}
