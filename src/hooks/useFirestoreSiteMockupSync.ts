import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestoreError';
import { useAuth } from '../contexts/AuthContext';
import {
  createStarterMockup,
  normalizeSectionOrder,
} from '../data/defaultMockup';
import type {
  MockupCanvasMode,
  MockupColorSwatch,
  MockupFontMood,
  MockupFontPairing,
  MockupMediaAsset,
  MockupMediaCategory,
  MockupPalette,
  MockupProjectItem,
  MockupSectionKey,
  MockupService,
  SiteMockupProject,
} from '../types';

export const STORAGE_MOCKUP_KEY = 'dispatch_site_mockup_v1';

export type FirestoreSyncStatus =
  | 'local'
  | 'connecting'
  | 'syncing'
  | 'synced'
  | 'error';

export interface UseFirestoreSiteMockupSyncResult {
  project: SiteMockupProject;
  setProject: React.Dispatch<React.SetStateAction<SiteMockupProject>>;
  updateProject: (updater: (prev: SiteMockupProject) => SiteMockupProject) => void;
  syncStatus: FirestoreSyncStatus;
  lastSyncedAt: string | null;
  syncError: string | null;
  isCloudConnected: boolean;
  firestoreDocPath: string | null;
  forceSyncNow: () => Promise<void>;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const VALID_FONT_MOODS: MockupFontMood[] = ['industrial', 'editorial', 'modern'];
const VALID_MEDIA_CATEGORIES: MockupMediaCategory[] = [
  'logo',
  'hero',
  'project',
  'site-photo',
];
const VALID_SECTION_KEYS: MockupSectionKey[] = [
  'services',
  'projects',
  'about',
  'quote',
];

const INLINE_LOGO_MAX_CHARS = 140_000;
const INLINE_HERO_MAX_CHARS = 140_000;
const INLINE_PROJECT_PHOTO_MAX_CHARS = 60_000;
const ASSET_DOC_MAX_CHARS = 700_000;
const SYNC_DEBOUNCE_MS = 750;

interface FirestoreSiteMockupDoc {
  ownerId: string;
  projectId: string;
  sourceUrl: string;
  lastImportedAt?: string;
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
    palette: MockupPalette;
    fontMood: MockupFontMood;
    fontPairing?: MockupFontPairing;
  };
  brandSwatches: MockupColorSwatch[];
  suggestedFontPairings: MockupFontPairing[];
  hero: {
    kicker: string;
    headline: string;
    subheadline: string;
    primaryCta: string;
    secondaryCta: string;
    trustHighlights: string[];
    photoRef?: string;
  };
  services: MockupService[];
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
  sectionVisibility: Record<MockupSectionKey, boolean>;
  sectionOrder: MockupSectionKey[];
  lockedSections: Partial<Record<MockupSectionKey, boolean>>;
  siteNotes: string;
  revision: number;
  createdAt?: Timestamp | ReturnType<typeof serverTimestamp>;
  updatedAt?: Timestamp | ReturnType<typeof serverTimestamp>;
}

interface FirestoreMediaAssetDoc {
  ownerId: string;
  mockupId: string;
  assetId: string;
  label: string;
  category: MockupMediaCategory;
  slotKey: string;
  dataUrl: string;
  width: number;
  height: number;
  sizeKb: number;
  addedAt: string;
  createdAt?: Timestamp | ReturnType<typeof serverTimestamp>;
  updatedAt?: Timestamp | ReturnType<typeof serverTimestamp>;
}

function clampString(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' ? val : fallback;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function sanitizeId(raw: unknown, fallback: string): string {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
  if (cleaned.length > 0 && VALID_ID_REGEX.test(cleaned)) {
    return cleaned;
  }
  return fallback;
}

function sanitizeColorHex(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length >= 4 && s.length <= 32) return s;
  return fallback;
}

function estimateKb(dataUrl: string): number {
  if (!dataUrl) return 0;
  return Math.min(1024, Math.max(0, Math.round((dataUrl.length * 0.75) / 1024)));
}

function timestampToIso(ts: unknown, fallback: string): string {
  if (
    ts &&
    typeof ts === 'object' &&
    'toDate' in ts &&
    typeof (ts as Timestamp).toDate === 'function'
  ) {
    try {
      return (ts as Timestamp).toDate().toISOString();
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function loadStoredMockup(): SiteMockupProject {
  try {
    const raw = localStorage.getItem(STORAGE_MOCKUP_KEY);
    if (!raw) return createStarterMockup();
    const parsed = JSON.parse(raw) as Partial<SiteMockupProject>;
    const starter = createStarterMockup();
    return {
      ...starter,
      ...parsed,
      brand: {
        ...starter.brand,
        ...(parsed.brand || {}),
        palette: {
          ...starter.brand.palette,
          ...(parsed.brand?.palette || {}),
        },
      },
      brandSwatches:
        Array.isArray(parsed.brandSwatches) && parsed.brandSwatches.length > 0
          ? parsed.brandSwatches
          : starter.brandSwatches,
      suggestedFontPairings: Array.isArray(parsed.suggestedFontPairings)
        ? parsed.suggestedFontPairings
        : [],
      hero: {
        ...starter.hero,
        ...(parsed.hero || {}),
      },
      about: {
        ...starter.about,
        ...(parsed.about || {}),
      },
      quoteForm: {
        ...starter.quoteForm,
        ...(parsed.quoteForm || {}),
      },
      sectionVisibility: {
        ...starter.sectionVisibility,
        ...(parsed.sectionVisibility || {}),
      },
      sectionOrder: normalizeSectionOrder(parsed.sectionOrder),
      lockedSections:
        parsed.lockedSections && typeof parsed.lockedSections === 'object'
          ? parsed.lockedSections
          : {},
      mediaCollection: Array.isArray(parsed.mediaCollection)
        ? parsed.mediaCollection
        : [],
    };
  } catch {
    return createStarterMockup();
  }
}

/**
 * Produces a deterministic fingerprint of project content (ignoring volatile updatedAt)
 * to prevent infinite write loops between local edits and incoming Firestore snapshots.
 */
function computeProjectFingerprint(project: SiteMockupProject): string {
  const { updatedAt: _ignored, ...stable } = project;
  try {
    return JSON.stringify(stable);
  } catch {
    return `${project.id}:${project.updatedAt}`;
  }
}

function buildSanitizedFirestorePayloads(
  project: SiteMockupProject,
  ownerId: string,
  mockupId: string,
  revision: number
): {
  mockupDoc: Omit<FirestoreSiteMockupDoc, 'createdAt' | 'updatedAt'>;
  mediaDocs: Array<Omit<FirestoreMediaAssetDoc, 'createdAt' | 'updatedAt'>>;
} {
  const starter = createStarterMockup();
  const mediaDocs: Array<Omit<FirestoreMediaAssetDoc, 'createdAt' | 'updatedAt'>> = [];
  const seenAssetIds = new Set<string>();

  const pushAsset = (asset: Omit<FirestoreMediaAssetDoc, 'createdAt' | 'updatedAt'>) => {
    if (!asset.dataUrl || asset.dataUrl.length > ASSET_DOC_MAX_CHARS) return false;
    if (seenAssetIds.has(asset.assetId)) return true;
    seenAssetIds.add(asset.assetId);
    mediaDocs.push(asset);
    return true;
  };

  // Resolve brand logo (inline if compact, else offload to mediaAssets subcollection)
  let logoRef: string | undefined;
  if (project.brand.logoDataUrl) {
    if (project.brand.logoDataUrl.length <= INLINE_LOGO_MAX_CHARS) {
      logoRef = project.brand.logoDataUrl;
    } else {
      const assetId = 'slot_brand_logo';
      const stored = pushAsset({
        ownerId,
        mockupId,
        assetId,
        label: clampString(`${project.brand.name || 'Brand'} Logo`, 200, 'Brand Logo'),
        category: 'logo',
        slotKey: 'brand_logo',
        dataUrl: project.brand.logoDataUrl,
        width: 0,
        height: 0,
        sizeKb: estimateKb(project.brand.logoDataUrl),
        addedAt: clampString(project.updatedAt || new Date().toISOString(), 64),
      });
      if (stored) logoRef = `asset://${assetId}`;
    }
  }

  // Resolve hero photo (inline if compact, else offload to mediaAssets subcollection)
  let heroPhotoRef: string | undefined;
  if (project.hero.photoDataUrl) {
    if (project.hero.photoDataUrl.length <= INLINE_HERO_MAX_CHARS) {
      heroPhotoRef = project.hero.photoDataUrl;
    } else {
      const assetId = 'slot_hero_photo';
      const stored = pushAsset({
        ownerId,
        mockupId,
        assetId,
        label: 'Hero Banner Photo',
        category: 'hero',
        slotKey: 'hero_photo',
        dataUrl: project.hero.photoDataUrl,
        width: 0,
        height: 0,
        sizeKb: estimateKb(project.hero.photoDataUrl),
        addedAt: clampString(project.updatedAt || new Date().toISOString(), 64),
      });
      if (stored) heroPhotoRef = `asset://${assetId}`;
    }
  }

  // Resolve project cards and their photos
  const projectsPayload = (Array.isArray(project.projects) ? project.projects : [])
    .slice(0, 24)
    .map((item, idx) => {
      const safeProjectItemId = sanitizeId(item.id, `proj_${idx + 1}`);
      let photoRef: string | undefined;
      if (item.photoDataUrl) {
        if (item.photoDataUrl.length <= INLINE_PROJECT_PHOTO_MAX_CHARS) {
          photoRef = item.photoDataUrl;
        } else {
          const assetId = sanitizeId(`slot_project_${safeProjectItemId}`, `slot_project_${idx + 1}`);
          const stored = pushAsset({
            ownerId,
            mockupId,
            assetId,
            label: clampString(item.title || `Project ${idx + 1}`, 200, `Project ${idx + 1}`),
            category: 'project',
            slotKey: `project_${safeProjectItemId}`,
            dataUrl: item.photoDataUrl,
            width: 0,
            height: 0,
            sizeKb: estimateKb(item.photoDataUrl),
            addedAt: clampString(project.updatedAt || new Date().toISOString(), 64),
          });
          if (stored) photoRef = `asset://${assetId}`;
        }
      }
      const entry: FirestoreSiteMockupDoc['projects'][number] = {
        id: safeProjectItemId,
        title: clampString(item.title, 200),
        location: clampString(item.location, 200),
        metric: clampString(item.metric, 120),
        summary: clampString(item.summary, 1000),
      };
      if (photoRef) entry.photoRef = photoRef;
      return entry;
    });

  // Media collection assets -> stored in subcollection docs (up to 30 assets)
  const collectionList = Array.isArray(project.mediaCollection)
    ? project.mediaCollection.slice(0, 30)
    : [];
  collectionList.forEach((asset, idx) => {
    const assetId = sanitizeId(asset.id, `media_${idx + 1}`);
    const category: MockupMediaCategory = VALID_MEDIA_CATEGORIES.includes(asset.category)
      ? asset.category
      : 'site-photo';
    pushAsset({
      ownerId,
      mockupId,
      assetId,
      label: clampString(asset.label || `Media Asset ${idx + 1}`, 200, `Media Asset ${idx + 1}`),
      category,
      slotKey: 'collection',
      dataUrl: asset.dataUrl || '',
      width: Math.min(16000, Math.max(0, Number(asset.width ?? 0) || 0)),
      height: Math.min(16000, Math.max(0, Number(asset.height ?? 0) || 0)),
      sizeKb: Math.min(
        1024,
        Math.max(0, Number(asset.sizeKb ?? estimateKb(asset.dataUrl || '')) || 0)
      ),
      addedAt: clampString(asset.addedAt || new Date().toISOString(), 64),
    });
  });

  // Palette map (only blueprint-whitelisted keys)
  const rawPalette = project.brand?.palette || starter.brand.palette;
  const canvasMode: MockupCanvasMode =
    rawPalette.canvasMode === 'dark' ? 'dark' : 'light';
  const palette: MockupPalette = {
    primary: sanitizeColorHex(rawPalette.primary, starter.brand.palette.primary),
    accent: sanitizeColorHex(rawPalette.accent, starter.brand.palette.accent),
    canvasMode,
  };
  if (rawPalette.onPrimary) palette.onPrimary = clampString(rawPalette.onPrimary, 32);
  if (rawPalette.onAccent) palette.onAccent = clampString(rawPalette.onAccent, 32);
  if (rawPalette.accentText) palette.accentText = clampString(rawPalette.accentText, 32);
  if (rawPalette.heroKickerText) {
    palette.heroKickerText = clampString(rawPalette.heroKickerText, 32);
  }

  const fontMood: MockupFontMood = VALID_FONT_MOODS.includes(project.brand?.fontMood)
    ? project.brand.fontMood
    : 'industrial';

  const brandPayload: FirestoreSiteMockupDoc['brand'] = {
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
  if (logoRef) brandPayload.logoRef = logoRef;
  if (project.brand?.fontPairing) {
    brandPayload.fontPairing = {
      id: clampString(project.brand.fontPairing.id, 128, 'custom'),
      name: clampString(project.brand.fontPairing.name, 160, 'Custom Pairing'),
      headingFont: clampString(project.brand.fontPairing.headingFont, 120, 'Inter'),
      bodyFont: clampString(project.brand.fontPairing.bodyFont, 120, 'Inter'),
      headingCategory: project.brand.fontPairing.headingCategory || 'sans-serif',
      bodyCategory: project.brand.fontPairing.bodyCategory || 'sans-serif',
      rationale: clampString(project.brand.fontPairing.rationale, 400),
      mood: VALID_FONT_MOODS.includes(project.brand.fontPairing.mood)
        ? project.brand.fontPairing.mood
        : fontMood,
      ...(project.brand.fontPairing.monoFont
        ? { monoFont: clampString(project.brand.fontPairing.monoFont, 120) }
        : {}),
      ...(project.brand.fontPairing.sourceNote
        ? { sourceNote: clampString(project.brand.fontPairing.sourceNote, 200) }
        : {}),
    };
  }

  const heroPayload: FirestoreSiteMockupDoc['hero'] = {
    kicker: clampString(project.hero?.kicker, 200),
    headline: clampString(project.hero?.headline, 400),
    subheadline: clampString(project.hero?.subheadline, 1200),
    primaryCta: clampString(project.hero?.primaryCta, 120),
    secondaryCta: clampString(project.hero?.secondaryCta, 120),
    trustHighlights: (Array.isArray(project.hero?.trustHighlights)
      ? project.hero.trustHighlights
      : []
    )
      .slice(0, 10)
      .map((s) => clampString(s, 300)),
  };
  if (heroPhotoRef) heroPayload.photoRef = heroPhotoRef;

  const lockedSections: Partial<Record<MockupSectionKey, boolean>> = {};
  if (project.lockedSections && typeof project.lockedSections === 'object') {
    for (const key of VALID_SECTION_KEYS) {
      if (typeof project.lockedSections[key] === 'boolean') {
        lockedSections[key] = project.lockedSections[key];
      }
    }
  }

  const mockupDoc: Omit<FirestoreSiteMockupDoc, 'createdAt' | 'updatedAt'> = {
    ownerId,
    projectId: sanitizeId(project.id, 'mockup-default'),
    sourceUrl: clampString(project.sourceUrl, 2048),
    clientUpdatedAt: clampString(project.updatedAt || new Date().toISOString(), 64),
    brand: brandPayload,
    brandSwatches: (Array.isArray(project.brandSwatches) ? project.brandSwatches : [])
      .slice(0, 20)
      .map((sw) => ({
        hex: sanitizeColorHex(sw.hex, '#1E3A5F'),
        name: clampString(sw.name, 100),
        role: sw.role || 'primary',
        usageNote: clampString(sw.usageNote, 240),
      })),
    suggestedFontPairings: (Array.isArray(project.suggestedFontPairings)
      ? project.suggestedFontPairings
      : []
    )
      .slice(0, 12)
      .map((fp, idx) => ({
        id: clampString(fp.id, 128, `pair-${idx + 1}`),
        name: clampString(fp.name, 160),
        headingFont: clampString(fp.headingFont, 120),
        bodyFont: clampString(fp.bodyFont, 120),
        headingCategory: fp.headingCategory || 'sans-serif',
        bodyCategory: fp.bodyCategory || 'sans-serif',
        rationale: clampString(fp.rationale, 400),
        mood: VALID_FONT_MOODS.includes(fp.mood) ? fp.mood : fontMood,
        ...(fp.monoFont ? { monoFont: clampString(fp.monoFont, 120) } : {}),
        ...(fp.sourceNote ? { sourceNote: clampString(fp.sourceNote, 200) } : {}),
      })),
    hero: heroPayload,
    services: (Array.isArray(project.services) ? project.services : [])
      .slice(0, 24)
      .map((srv, idx) => ({
        id: sanitizeId(srv.id, `srv_${idx + 1}`),
        title: clampString(srv.title, 200),
        description: clampString(srv.description, 1000),
        deliverable: clampString(srv.deliverable, 240),
      })),
    projects: projectsPayload,
    about: {
      heading: clampString(project.about?.heading, 300),
      story: clampString(project.about?.story, 5000),
      credentials: (Array.isArray(project.about?.credentials)
        ? project.about.credentials
        : []
      )
        .slice(0, 20)
        .map((c) => clampString(c, 300)),
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
    sectionOrder: normalizeSectionOrder(project.sectionOrder),
    lockedSections,
    siteNotes: clampString(project.siteNotes, 10000),
    revision: Math.max(1, Math.floor(revision)),
  };

  if (project.lastImportedAt) {
    mockupDoc.lastImportedAt = clampString(project.lastImportedAt, 64);
  }

  return { mockupDoc, mediaDocs };
}

function hydrateProjectFromFirestore(
  remoteDoc: FirestoreSiteMockupDoc,
  mediaAssetDocs: FirestoreMediaAssetDoc[]
): SiteMockupProject {
  const starter = createStarterMockup();
  const assetById: Record<string, FirestoreMediaAssetDoc> = {};
  for (const docItem of mediaAssetDocs) {
    assetById[docItem.assetId] = docItem;
  }

  const resolveMediaRef = (refVal?: string): string | undefined => {
    if (!refVal) return undefined;
    if (refVal.startsWith('asset://')) {
      const targetId = refVal.slice('asset://'.length);
      return assetById[targetId]?.dataUrl;
    }
    return refVal;
  };

  const mediaCollection: MockupMediaAsset[] = mediaAssetDocs
    .filter((a) => a.slotKey === 'collection' && Boolean(a.dataUrl))
    .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''))
    .map((a) => ({
      id: a.assetId,
      label: a.label,
      category: a.category,
      dataUrl: a.dataUrl,
      width: a.width || undefined,
      height: a.height || undefined,
      sizeKb: a.sizeKb || undefined,
      addedAt: a.addedAt,
    }));

  const hydratedProjects: MockupProjectItem[] = (remoteDoc.projects || []).map(
    (item) => ({
      id: item.id,
      title: item.title,
      location: item.location,
      metric: item.metric,
      summary: item.summary,
      photoDataUrl: resolveMediaRef(item.photoRef),
    })
  );

  return {
    ...starter,
    id: remoteDoc.projectId || starter.id,
    sourceUrl: remoteDoc.sourceUrl ?? '',
    lastImportedAt: remoteDoc.lastImportedAt,
    updatedAt:
      remoteDoc.clientUpdatedAt ||
      timestampToIso(remoteDoc.updatedAt, new Date().toISOString()),
    brand: {
      ...starter.brand,
      name: remoteDoc.brand?.name ?? starter.brand.name,
      industry: remoteDoc.brand?.industry ?? starter.brand.industry,
      serviceArea: remoteDoc.brand?.serviceArea ?? starter.brand.serviceArea,
      phone: remoteDoc.brand?.phone ?? starter.brand.phone,
      email: remoteDoc.brand?.email ?? starter.brand.email,
      hours: remoteDoc.brand?.hours ?? starter.brand.hours,
      address: remoteDoc.brand?.address ?? starter.brand.address,
      logoDataUrl: resolveMediaRef(remoteDoc.brand?.logoRef),
      palette: {
        ...starter.brand.palette,
        ...(remoteDoc.brand?.palette || {}),
      },
      fontMood: remoteDoc.brand?.fontMood || starter.brand.fontMood,
      fontPairing: remoteDoc.brand?.fontPairing,
    },
    brandSwatches:
      Array.isArray(remoteDoc.brandSwatches) && remoteDoc.brandSwatches.length > 0
        ? remoteDoc.brandSwatches
        : starter.brandSwatches,
    suggestedFontPairings: Array.isArray(remoteDoc.suggestedFontPairings)
      ? remoteDoc.suggestedFontPairings
      : [],
    hero: {
      ...starter.hero,
      kicker: remoteDoc.hero?.kicker ?? starter.hero.kicker,
      headline: remoteDoc.hero?.headline ?? starter.hero.headline,
      subheadline: remoteDoc.hero?.subheadline ?? starter.hero.subheadline,
      primaryCta: remoteDoc.hero?.primaryCta ?? starter.hero.primaryCta,
      secondaryCta: remoteDoc.hero?.secondaryCta ?? starter.hero.secondaryCta,
      trustHighlights: Array.isArray(remoteDoc.hero?.trustHighlights)
        ? remoteDoc.hero.trustHighlights
        : starter.hero.trustHighlights,
      photoDataUrl: resolveMediaRef(remoteDoc.hero?.photoRef),
    },
    services: Array.isArray(remoteDoc.services) ? remoteDoc.services : starter.services,
    projects: hydratedProjects.length > 0 ? hydratedProjects : starter.projects,
    about: {
      ...starter.about,
      ...(remoteDoc.about || {}),
    },
    quoteForm: {
      ...starter.quoteForm,
      ...(remoteDoc.quoteForm || {}),
    },
    sectionVisibility: {
      ...starter.sectionVisibility,
      ...(remoteDoc.sectionVisibility || {}),
    },
    sectionOrder: normalizeSectionOrder(remoteDoc.sectionOrder),
    lockedSections: remoteDoc.lockedSections || {},
    mediaCollection,
    siteNotes: remoteDoc.siteNotes ?? '',
  };
}

/**
 * Synchronizes local Site Mockup state (branding, layout, copy, and compressed media assets)
 * with a Firestore `/siteMockups/{mockupId}` document and `/mediaAssets` subcollection in real time.
 */
export function useFirestoreSiteMockupSync(): UseFirestoreSiteMockupSyncResult {
  const { user, isLoading: authLoading } = useAuth();
  const [project, setProject] = useState<SiteMockupProject>(() => loadStoredMockup());
  const [syncStatus, setSyncStatus] = useState<FirestoreSyncStatus>('local');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Refs for bidirectional echo-free synchronization
  const latestProjectRef = useRef<SiteMockupProject>(project);
  latestProjectRef.current = project;

  const remoteDocExistsRef = useRef<boolean>(false);
  const remoteRevisionRef = useRef<number>(0);
  const remoteMediaStateRef = useRef<Record<string, string>>({});
  const latestRemoteDocRef = useRef<FirestoreSiteMockupDoc | null>(null);
  const latestRemoteMediaRef = useRef<FirestoreMediaAssetDoc[]>([]);
  const docSnapshotReadyRef = useRef<boolean>(false);
  const mediaSnapshotReadyRef = useRef<boolean>(false);
  const initialResolutionDoneRef = useRef<boolean>(false);
  const lastSyncedFingerprintRef = useRef<string>('');
  const applyingRemoteRef = useRef<boolean>(false);
  const debounceTimerRef = useRef<number | null>(null);
  const pushInFlightRef = useRef<boolean>(false);

  const mockupId = user ? `mockup_${sanitizeId(user.uid, 'user')}` : null;
  const firestoreDocPath = mockupId ? `siteMockups/${mockupId}` : null;

  // Always mirror state into localStorage for instant reloads & guest offline safety
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_MOCKUP_KEY, JSON.stringify(project));
    } catch {
      // Ignore browser localStorage quota errors
    }
  }, [project]);

  const pushLocalToFirestore = useCallback(
    async (targetProject: SiteMockupProject) => {
      if (!user || !mockupId || !firestoreDocPath) return;
      if (pushInFlightRef.current) return;

      const fingerprint = computeProjectFingerprint(targetProject);
      if (
        remoteDocExistsRef.current &&
        fingerprint === lastSyncedFingerprintRef.current
      ) {
        return;
      }

      pushInFlightRef.current = true;
      setSyncStatus('syncing');
      setSyncError(null);

      const parentRef = doc(db, 'siteMockups', mockupId);
      const mediaColPath = `${firestoreDocPath}/mediaAssets`;
      const mediaQuery = query(
        collection(db, 'siteMockups', mockupId, 'mediaAssets'),
        where('ownerId', '==', user.uid),
        where('mockupId', '==', mockupId)
      );

      let parentExists = remoteDocExistsRef.current;

      try {
        // Read live parent state so revision and create-vs-update always match Firestore security rules
        let serverRevision = remoteRevisionRef.current;
        try {
          const latestParentSnap = await getDoc(parentRef);
          parentExists = latestParentSnap.exists();
          if (parentExists) {
            const parentData = latestParentSnap.data() as FirestoreSiteMockupDoc;
            serverRevision = Math.max(serverRevision, Number(parentData.revision || 1));
          } else {
            serverRevision = 0;
          }
        } catch (readErr) {
          try {
            handleFirestoreError(readErr, OperationType.GET, firestoreDocPath);
          } catch {
            // Structured diagnostics logged; rethrow original to surface sync status cleanly
          }
          throw readErr;
        }

        const nextRevision = parentExists ? serverRevision + 1 : 1;
        const { mockupDoc, mediaDocs } = buildSanitizedFirestorePayloads(
          targetProject,
          user.uid,
          mockupId,
          nextRevision
        );

        // Fetch live mediaAssets subcollection IDs so existing assets use updateDoc (preserving createdAt)
        const existingMediaMap: Record<string, string> = {
          ...remoteMediaStateRef.current,
        };
        if (parentExists) {
          try {
            const existingMediaSnap = await getDocs(mediaQuery);
            const liveMap: Record<string, string> = {};
            existingMediaSnap.forEach((docSnap) => {
              const d = docSnap.data() as FirestoreMediaAssetDoc;
              const idKey = d.assetId || docSnap.id;
              liveMap[idKey] = `${d.label}|${d.category}|${d.slotKey}|${(d.dataUrl || '').length}|${d.addedAt}`;
            });
            Object.assign(existingMediaMap, liveMap);
          } catch (listErr) {
            try {
              handleFirestoreError(listErr, OperationType.LIST, mediaColPath);
            } catch {
              // Structured diagnostics logged; continue with cached remoteMediaStateRef
            }
          }
        }

        if (!parentExists) {
          // Atomic create of parent workspace + initial media asset documents
          const batch = writeBatch(db);
          batch.set(parentRef, {
            ...mockupDoc,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          for (const asset of mediaDocs) {
            const assetRef = doc(db, 'siteMockups', mockupId, 'mediaAssets', asset.assetId);
            batch.set(assetRef, {
              ...asset,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
          await batch.commit();
          remoteDocExistsRef.current = true;
          remoteRevisionRef.current = nextRevision;

          const nextMediaMap: Record<string, string> = {};
          for (const asset of mediaDocs) {
            nextMediaMap[asset.assetId] = `${asset.label}|${asset.category}|${asset.slotKey}|${asset.dataUrl.length}|${asset.addedAt}`;
          }
          remoteMediaStateRef.current = nextMediaMap;
        } else {
          // Incremental update preserving immutable ownerId and createdAt
          const { ownerId: _ownerId, ...mutableFields } = mockupDoc;
          await updateDoc(parentRef, {
            ...mutableFields,
            updatedAt: serverTimestamp(),
          });
          remoteDocExistsRef.current = true;
          remoteRevisionRef.current = nextRevision;

          // Diff media assets subcollection: create new, update changed, delete removed
          const desiredIds = new Set<string>();
          const nextMediaMap: Record<string, string> = {
            ...existingMediaMap,
          };

          for (const asset of mediaDocs) {
            desiredIds.add(asset.assetId);
            const sig = `${asset.label}|${asset.category}|${asset.slotKey}|${asset.dataUrl.length}|${asset.addedAt}`;
            const existingSig = existingMediaMap[asset.assetId];
            const assetRef = doc(db, 'siteMockups', mockupId, 'mediaAssets', asset.assetId);

            if (!existingSig) {
              try {
                await setDoc(assetRef, {
                  ...asset,
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                });
                nextMediaMap[asset.assetId] = sig;
              } catch (err) {
                try {
                  handleFirestoreError(
                    err,
                    OperationType.CREATE,
                    `${mediaColPath}/${asset.assetId}`
                  );
                } catch {
                  // Logged structured FirestoreErrorInfo; fallback to updateDoc if asset already existed
                }
                await updateDoc(assetRef, {
                  label: asset.label,
                  category: asset.category,
                  slotKey: asset.slotKey,
                  dataUrl: asset.dataUrl,
                  width: asset.width,
                  height: asset.height,
                  sizeKb: asset.sizeKb,
                  addedAt: asset.addedAt,
                  updatedAt: serverTimestamp(),
                });
                nextMediaMap[asset.assetId] = sig;
              }
            } else if (existingSig !== sig) {
              try {
                await updateDoc(assetRef, {
                  label: asset.label,
                  category: asset.category,
                  slotKey: asset.slotKey,
                  dataUrl: asset.dataUrl,
                  width: asset.width,
                  height: asset.height,
                  sizeKb: asset.sizeKb,
                  addedAt: asset.addedAt,
                  updatedAt: serverTimestamp(),
                });
                nextMediaMap[asset.assetId] = sig;
              } catch (err) {
                handleFirestoreError(
                  err,
                  OperationType.UPDATE,
                  `${mediaColPath}/${asset.assetId}`
                );
              }
            }
          }

          for (const existingId of Object.keys(existingMediaMap)) {
            if (!desiredIds.has(existingId)) {
              const assetRef = doc(db, 'siteMockups', mockupId, 'mediaAssets', existingId);
              try {
                await deleteDoc(assetRef);
                delete nextMediaMap[existingId];
              } catch (err) {
                handleFirestoreError(
                  err,
                  OperationType.DELETE,
                  `${mediaColPath}/${existingId}`
                );
              }
            }
          }

          remoteMediaStateRef.current = nextMediaMap;
        }

        lastSyncedFingerprintRef.current = fingerprint;
        setLastSyncedAt(new Date().toISOString());
        setSyncStatus('synced');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSyncStatus('error');
        setSyncError(
          /quota/i.test(msg)
            ? 'Cloud sync paused (Firestore daily quota reached) — all edits are saved locally.'
            : 'Cloud sync paused — all edits are saved locally. Click Retry Sync when ready.'
        );
        if (/permission|insufficient/i.test(msg)) {
          try {
            handleFirestoreError(
              err,
              parentExists ? OperationType.UPDATE : OperationType.CREATE,
              firestoreDocPath
            );
          } catch {
            // Structured FirestoreErrorInfo logged to console; keep workspace interactive
          }
        } else {
          console.error('SiteMockup Firestore sync failed:', msg);
        }
      } finally {
        pushInFlightRef.current = false;
      }
    },
    [firestoreDocPath, mockupId, user]
  );

  // Reconcile incoming Firestore snapshots (parent doc + mediaAssets subcollection)
  const applyRemoteSnapshots = useCallback(() => {
    if (!docSnapshotReadyRef.current || !mediaSnapshotReadyRef.current) return;

    const remoteDoc = latestRemoteDocRef.current;
    const remoteAssets = latestRemoteMediaRef.current;

    if (!remoteDoc) {
      // First-time sign-in: no Firestore workspace yet -> seed from local project
      if (!initialResolutionDoneRef.current) {
        initialResolutionDoneRef.current = true;
        void pushLocalToFirestore(latestProjectRef.current);
      }
      return;
    }

    const hydrated = hydrateProjectFromFirestore(remoteDoc, remoteAssets);
    const hydratedFingerprint = computeProjectFingerprint(hydrated);

    if (!initialResolutionDoneRef.current) {
      initialResolutionDoneRef.current = true;
      const localTs = Date.parse(latestProjectRef.current.updatedAt || '') || 0;
      const remoteTs = Date.parse(remoteDoc.clientUpdatedAt || '') || 0;

      // If local state was just updated by a cross-tab handoff (Media Lab / Maps) or offline edits,
      // push local state up so it persists across sessions; otherwise hydrate from Firestore.
      if (
        localTs > remoteTs + 1000 &&
        computeProjectFingerprint(latestProjectRef.current) !== hydratedFingerprint
      ) {
        void pushLocalToFirestore(latestProjectRef.current);
        return;
      }
    }

    // Apply remote changes without triggering an echo write
    if (hydratedFingerprint !== computeProjectFingerprint(latestProjectRef.current)) {
      applyingRemoteRef.current = true;
      lastSyncedFingerprintRef.current = hydratedFingerprint;
      setProject(hydrated);
      window.setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 0);
    } else {
      lastSyncedFingerprintRef.current = hydratedFingerprint;
    }

    setLastSyncedAt(
      timestampToIso(remoteDoc.updatedAt, remoteDoc.clientUpdatedAt || new Date().toISOString())
    );
    setSyncStatus('synced');
    setSyncError(null);
  }, [pushLocalToFirestore]);

  // Attach real-time Firestore onSnapshot listeners only when auth is ready and user is authenticated
  useEffect(() => {
    if (authLoading) return;

    if (!user || !mockupId || !firestoreDocPath) {
      setSyncStatus('local');
      setSyncError(null);
      remoteDocExistsRef.current = false;
      remoteRevisionRef.current = 0;
      remoteMediaStateRef.current = {};
      latestRemoteDocRef.current = null;
      latestRemoteMediaRef.current = [];
      docSnapshotReadyRef.current = false;
      mediaSnapshotReadyRef.current = false;
      initialResolutionDoneRef.current = false;
      lastSyncedFingerprintRef.current = '';
      return;
    }

    setSyncStatus('connecting');
    setSyncError(null);
    docSnapshotReadyRef.current = false;
    mediaSnapshotReadyRef.current = false;
    initialResolutionDoneRef.current = false;

    const parentRef = doc(db, 'siteMockups', mockupId);
    const mediaColPath = `${firestoreDocPath}/mediaAssets`;
    const mediaQuery = query(
      collection(db, 'siteMockups', mockupId, 'mediaAssets'),
      where('ownerId', '==', user.uid),
      where('mockupId', '==', mockupId)
    );

    const unsubscribeDoc = onSnapshot(
      parentRef,
      (snap) => {
        docSnapshotReadyRef.current = true;
        if (snap.exists()) {
          const data = snap.data() as FirestoreSiteMockupDoc;
          remoteDocExistsRef.current = true;
          remoteRevisionRef.current = Math.max(
            remoteRevisionRef.current,
            Number(data.revision || 1)
          );
          latestRemoteDocRef.current = data;
        } else {
          remoteDocExistsRef.current = false;
          remoteRevisionRef.current = 0;
          latestRemoteDocRef.current = null;
        }
        applyRemoteSnapshots();
      },
      (error) => {
        setSyncStatus('error');
        setSyncError('Cloud workspace sync paused — local autosave remains active.');
        try {
          handleFirestoreError(error, OperationType.GET, firestoreDocPath);
        } catch {
          // Structured FirestoreErrorInfo logged to console; keep workspace interactive
        }
      }
    );

    const unsubscribeMedia = onSnapshot(
      mediaQuery,
      (snap) => {
        mediaSnapshotReadyRef.current = true;
        const docs: FirestoreMediaAssetDoc[] = [];
        const sigMap: Record<string, string> = {};
        snap.forEach((docSnap) => {
          const data = docSnap.data() as FirestoreMediaAssetDoc;
          docs.push(data);
          sigMap[data.assetId] = `${data.label}|${data.category}|${data.slotKey}|${(data.dataUrl || '').length}|${data.addedAt}`;
        });
        latestRemoteMediaRef.current = docs;
        remoteMediaStateRef.current = sigMap;
        applyRemoteSnapshots();
      },
      (error) => {
        setSyncStatus('error');
        setSyncError('Cloud media sync paused — local autosave remains active.');
        try {
          handleFirestoreError(error, OperationType.LIST, mediaColPath);
        } catch {
          // Structured FirestoreErrorInfo logged to console; keep workspace interactive
        }
      }
    );

    return () => {
      unsubscribeDoc();
      unsubscribeMedia();
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [applyRemoteSnapshots, authLoading, firestoreDocPath, mockupId, user]);

  // Debounced auto-push to Firestore whenever local Site Mockup branding/media changes
  useEffect(() => {
    if (!user || !mockupId || !initialResolutionDoneRef.current) return;
    if (applyingRemoteRef.current) return;

    const fingerprint = computeProjectFingerprint(project);
    if (
      remoteDocExistsRef.current &&
      fingerprint === lastSyncedFingerprintRef.current
    ) {
      return;
    }

    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void pushLocalToFirestore(latestProjectRef.current);
    }, SYNC_DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [mockupId, project, pushLocalToFirestore, user]);

  const updateProject = useCallback(
    (updater: (prev: SiteMockupProject) => SiteMockupProject) => {
      setProject((prev) => ({
        ...updater(prev),
        updatedAt: new Date().toISOString(),
      }));
    },
    []
  );

  const forceSyncNow = useCallback(async () => {
    if (!user || !mockupId) return;
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    lastSyncedFingerprintRef.current = '';
    await pushLocalToFirestore(latestProjectRef.current);
  }, [mockupId, pushLocalToFirestore, user]);

  return {
    project,
    setProject,
    updateProject,
    syncStatus,
    lastSyncedAt,
    syncError,
    isCloudConnected: Boolean(user && syncStatus !== 'local'),
    firestoreDocPath,
    forceSyncNow,
  };
}
