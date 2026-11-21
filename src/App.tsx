import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Copy, HardDrive, ListChecks, Plus } from 'lucide-react';
import {
  VOICE_OPTIONS,
  type ActiveView,
  type AudioBriefing,
  type BriefingPreferences,
  type ChatMessage,
  type CitationRef,
  type InspectedSourceTarget,
  type LocalRssFeedConfig,
  type NewsArticle,
  type PlaybackPosition,
  type ScriptLine,
  type VoiceName,
  type WorkspaceLinkItem,
} from './types';
import { useAuth } from './contexts/AuthContext';
import {
  loadLocalRssFeedConfig,
  saveLocalRssFeedConfig,
  syncArchiveToPrivateFeed,
} from './services/rssApi';
import { SAMPLE_ARTICLES } from './data/sampleArticles';
import {
  generateBriefingScript,
  generateSourceTags,
  ingestArticle,
  refineBriefingScript,
  sendEditorChatMessage,
  synthesizeSpeech,
  uploadDocumentSource,
} from './services/api';
import {
  base64WavToObjectUrl,
  getWavDurationSeconds,
  stitchWavBase64Clips,
} from './utils/wavUtils';
import {
  deleteBriefingAudio,
  loadBriefingAudio,
  saveSegmentAudio,
} from './utils/audioCache';
import { ensureArticlePassages } from './utils/passages';
import { TopBar } from './components/TopBar';
import { SourcesSidebar } from './components/SourcesSidebar';
import { SourceInspectorDrawer } from './components/SourceInspectorDrawer';
import { AddSourceModal, type AddSourceTab } from './components/AddSourceModal';
import { GoogleDriveModal } from './components/GoogleDriveModal';
import { GoogleTasksDrawer } from './components/GoogleTasksDrawer';
import { ArticleDeskView } from './components/ArticleDeskView';
import { BriefingStudioView } from './components/BriefingStudioView';
import { ArchiveView } from './components/ArchiveView';
import { AudioPlayerBar, type SleepTimerMode } from './components/AudioPlayerBar';
import { CommuteModeOverlay } from './components/CommuteModeOverlay';
import { SharedBriefingView } from './components/SharedBriefingView';
import { SharedMockupView } from './components/SharedMockupView';
import { SiteMockupView } from './components/SiteMockupView';
import { FirestoreErrorBoundary } from './components/FirestoreErrorBoundary';
import { AiDeskView } from './components/AiDeskView';
import type { DriveFileItem } from './services/googleDriveService';
import type { GoogleTaskItem } from './services/googleTasksService';
import {
  deleteBriefingArchiveFromFirestore,
  deleteNotebookSourceFromFirestore,
  subscribeToBriefingArchives,
  subscribeToNotebookSources,
  subscribeToWorkspaceLinks,
  updateBriefingPlaybackInFirestore,
  upsertBriefingArchiveToFirestore,
  upsertNotebookSourceToFirestore,
  upsertWorkspaceLinkToFirestore,
} from './services/firestoreWorkspaceSync';
import {
  MediaLabView,
  type GeneratedSessionImage,
  type MediaImageTransferPayload,
} from './components/MediaLabView';
import { SpatialMapsHubView } from './components/SpatialMapsHubView';
import { OwnerConsoleView } from './components/OwnerConsoleView';
import { TransferToast, type TransferToastItem } from './components/TransferToast';
import { type RouteWaypoint } from './services/routingService';
import { createStarterMockup } from './data/defaultMockup';
import { compressDataUrl, estimateDataUrlKb } from './utils/imageUpload';
import type { SiteMockupProject } from './types';
import type { Staged3DPayload } from './three/types';
import { isSpatialDisplayUrl } from './three/spatialBroadcastBus';
import {
  renderEditorialFoilCard,
  renderMockupDeviceScreens,
} from './three/texturesAndCards';

function readShareIdFromLocation(): string | null {
  try {
    const pathMatch = /^\/share\/([A-Za-z0-9_-]{6,32})\/?$/.exec(
      window.location.pathname
    );
    if (pathMatch) return pathMatch[1];
    const params = new URLSearchParams(window.location.search);
    const q = params.get('share');
    if (q && /^[A-Za-z0-9_-]{6,32}$/.test(q)) return q;
    return null;
  } catch {
    return null;
  }
}

function readMockupShareIdFromLocation(): string | null {
  try {
    const pathMatch = /^\/mockup\/([A-Za-z0-9_-]{6,32})\/?$/.exec(
      window.location.pathname
    );
    if (pathMatch) return pathMatch[1];
    const params = new URLSearchParams(window.location.search);
    const q = params.get('mockup');
    if (q && /^[A-Za-z0-9_-]{6,32}$/.test(q)) return q;
    return null;
  } catch {
    return null;
  }
}

const VIEW_TO_PATH: Record<ActiveView, string> = {
  articles: '/',
  briefing: '/briefing',
  archive: '/archive',
  chat: '/ai-desk',
  media: '/media-lab',
  mockup: '/site-mockup',
  spatial: '/spatial',
  owner: '/owner',
};

function readActiveViewFromLocation(): ActiveView {
  try {
    if (isSpatialDisplayUrl()) {
      return 'spatial';
    }
    const rawPath = window.location.pathname.replace(/\/+$/, '') || '/';
    switch (rawPath) {
      case '/briefing':
        return 'briefing';
      case '/archive':
      case '/vault':
        return 'archive';
      case '/ai-desk':
        return 'chat';
      case '/media-lab':
        return 'media';
      case '/site-mockup':
        return 'mockup';
      case '/spatial':
        return 'spatial';
      case '/owner':
        return 'owner';
      case '/':
      case '/newsroom':
      default:
        return 'articles';
    }
  } catch {
    return 'articles';
  }
}

const GMP_SETUP_URL =
  'https://developers.google.com/maps/get-started?utm_campaign=gmp_mcp_codeassist_v1_aistudio';

const STORAGE_ARTICLES_KEY = 'dispatch_articles_v1';
const STORAGE_PREFS_KEY = 'dispatch_prefs_v1';
const STORAGE_ARCHIVE_KEY = 'dispatch_archive_v1';
const STORAGE_ACTIVE_BRIEFING_KEY = 'dispatch_active_briefing_id_v1';
const STORAGE_PLAYBACK_KEY = 'dispatch_playback_v1';

const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2, 0.85];

const DEFAULT_PREFERENCES: BriefingPreferences = {
  durationMinutes: 5,
  format: 'podcast',
  tone: 'executive',
  voiceTone: 'professional',
  voiceName: 'Kore',
  coHostVoiceName: 'Puck',
  dynamicPanel: false,
  segmentCoHostVoices: {},
  listenerFocus: '',
  personalizedIntroduction: '',
};

function loadStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stripAudioForStorage(briefing: AudioBriefing): AudioBriefing {
  return {
    ...briefing,
    segments: briefing.segments.map((seg) => ({
      ...seg,
      audioBase64: undefined,
    })),
  };
}

function isRefreshableUrlSource(article: NewsArticle): boolean {
  if (article.driveFileId) return false;
  const rawUrl = article.url?.trim();
  return Boolean(rawUrl && /^https?:\/\//i.test(rawUrl));
}

export default function App() {
  const [sharedRouteId, setSharedRouteId] = useState<string | null>(() =>
    readShareIdFromLocation()
  );
  const [sharedMockupRouteId, setSharedMockupRouteId] = useState<string | null>(() =>
    readMockupShareIdFromLocation()
  );
  const [activeView, setActiveView] = useState<ActiveView>(() =>
    readActiveViewFromLocation()
  );
  const [gmpQuotaExceeded, setGmpQuotaExceeded] = useState(false);
  const [gmpLinkCopied, setGmpLinkCopied] = useState(false);
  const [stagedImageFor3D, setStagedImageFor3D] = useState<{
    dataUrl: string;
    label: string;
  } | null>(null);
  const [staged3DPayload, setStaged3DPayload] = useState<Staged3DPayload | null>(
    null
  );
  const [autoOpenPitchSheet, setAutoOpenPitchSheet] = useState(false);
  const [stagedImageForVideoStage, setStagedImageForVideoStage] =
    useState<MediaImageTransferPayload | null>(null);
  const [mediaSessionImages, setMediaSessionImages] = useState<GeneratedSessionImage[]>(
    []
  );
  const [activeMediaImageId, setActiveMediaImageId] = useState<string | null>(null);
  const [routeWaypoints, setRouteWaypoints] = useState<RouteWaypoint[]>([]);
  const [transferToast, setTransferToast] = useState<TransferToastItem | null>(null);
  const transferToastTimerRef = useRef<number | null>(null);

  const dismissTransferToast = useCallback(() => {
    if (transferToastTimerRef.current) {
      window.clearTimeout(transferToastTimerRef.current);
      transferToastTimerRef.current = null;
    }
    setTransferToast(null);
  }, []);

  const scheduleTransferToastDismiss = useCallback((delayMs = 4800) => {
    if (transferToastTimerRef.current) {
      window.clearTimeout(transferToastTimerRef.current);
    }
    transferToastTimerRef.current = window.setTimeout(() => {
      setTransferToast(null);
      transferToastTimerRef.current = null;
    }, delayMs);
  }, []);

  const pauseTransferToastTimer = useCallback(() => {
    if (transferToastTimerRef.current) {
      window.clearTimeout(transferToastTimerRef.current);
      transferToastTimerRef.current = null;
    }
  }, []);

  const resumeTransferToastTimer = useCallback(() => {
    scheduleTransferToastDismiss(2600);
  }, [scheduleTransferToastDismiss]);

  const showTransferToast = useCallback(
    (item: Omit<TransferToastItem, 'id'>) => {
      setTransferToast({ ...item, id: Date.now() });
      scheduleTransferToastDismiss(4800);
    },
    [scheduleTransferToastDismiss]
  );

  useEffect(() => {
    return () => {
      if (transferToastTimerRef.current) {
        window.clearTimeout(transferToastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onQuota = () => setGmpQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const nextShareId = readShareIdFromLocation();
      const nextMockupId = readMockupShareIdFromLocation();
      setSharedRouteId(nextShareId);
      setSharedMockupRouteId(nextMockupId);
      if (!nextShareId && !nextMockupId) {
        setActiveView(readActiveViewFromLocation());
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (sharedRouteId || sharedMockupRouteId) return;
    try {
      if (activeView === 'spatial' && isSpatialDisplayUrl()) {
        return;
      }
      const targetPath = VIEW_TO_PATH[activeView] || '/';
      const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
      const matchesAlias =
        (activeView === 'articles' && (currentPath === '/' || currentPath === '/newsroom')) ||
        (activeView === 'archive' && (currentPath === '/archive' || currentPath === '/vault'));
      if (currentPath !== targetPath && !matchesAlias) {
        window.history.pushState({}, '', targetPath);
      }
    } catch {
      // Non-fatal in restricted history environments
    }
  }, [activeView, sharedRouteId, sharedMockupRouteId]);

  const handleOpenSharedPreview = useCallback((shareId: string) => {
    try {
      window.history.pushState({}, '', `/share/${shareId}`);
    } catch {
      // Non-fatal in restricted history environments
    }
    setSharedRouteId(shareId);
  }, []);

  const handleOpenSharedMockup = useCallback((shareId: string) => {
    try {
      window.history.pushState({}, '', `/mockup/${shareId}`);
    } catch {
      // Non-fatal in restricted history environments
    }
    setSharedMockupRouteId(shareId);
  }, []);

  const handleExitSharedView = useCallback(() => {
    const targetPath = VIEW_TO_PATH[activeView] || '/';
    try {
      window.history.pushState({}, '', targetPath);
    } catch {
      // Non-fatal
    }
    setSharedRouteId(null);
    setSharedMockupRouteId(null);
  }, [activeView]);

  // Articles & preferences (normalized so every source has numbered passages)
  const [articles, setArticles] = useState<NewsArticle[]>(() =>
    loadStoredJson<NewsArticle[]>(STORAGE_ARTICLES_KEY, SAMPLE_ARTICLES).map(
      ensureArticlePassages
    )
  );
  const [preferences, setPreferences] = useState<BriefingPreferences>(() => ({
    ...DEFAULT_PREFERENCES,
    ...loadStoredJson<Partial<BriefingPreferences>>(STORAGE_PREFS_KEY, {}),
  }));

  // Active briefing, archive & saved playback bookmarks
  const { user, getIdToken } = useAuth();
  const verifiedOwnerId = user?.uid && user.emailVerified ? user.uid : null;
  const [archive, setArchive] = useState<AudioBriefing[]>(() =>
    loadStoredJson<AudioBriefing[]>(STORAGE_ARCHIVE_KEY, [])
  );
  const [rssFeedConfig, setRssFeedConfig] = useState<LocalRssFeedConfig | null>(() =>
    loadLocalRssFeedConfig()
  );
  const [isRssAutoSyncing, setIsRssAutoSyncing] = useState(false);
  const rssSyncInFlightRef = useRef(false);
  const rssFeedConfigRef = useRef<LocalRssFeedConfig | null>(rssFeedConfig);
  rssFeedConfigRef.current = rssFeedConfig;

  const handleRssFeedConfigChange = useCallback(
    (next: LocalRssFeedConfig | null) => {
      saveLocalRssFeedConfig(next);
      setRssFeedConfig(next);
    },
    []
  );

  const [playbackPositions, setPlaybackPositions] = useState<
    Record<string, PlaybackPosition>
  >(() => loadStoredJson<Record<string, PlaybackPosition>>(STORAGE_PLAYBACK_KEY, {}));

  const [activeBriefing, setActiveBriefing] = useState<AudioBriefing | null>(() => {
    try {
      const savedActiveId = localStorage.getItem(STORAGE_ACTIVE_BRIEFING_KEY);
      if (!savedActiveId) return null;
      const storedArchive = loadStoredJson<AudioBriefing[]>(STORAGE_ARCHIVE_KEY, []);
      return storedArchive.find((b) => b.id === savedActiveId) ?? null;
    } catch {
      return null;
    }
  });

  // Async workflow states
  const [isIngesting, setIsIngesting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [isRefreshingArticles, setIsRefreshingArticles] = useState(false);
  const [refreshArticlesStatus, setRefreshArticlesStatus] = useState<string | null>(
    null
  );
  const [refreshArticlesError, setRefreshArticlesError] = useState<string | null>(null);
  const [isTagging, setIsTagging] = useState(false);
  const autoTagAttemptedIdsRef = useRef<Set<string>>(new Set());

  // Notebook Sources modal, Google Workspace modals/drawers, mobile drawer & Source Guide inspector
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addModalTab, setAddModalTab] = useState<AddSourceTab>('upload');
  const [driveModalOpen, setDriveModalOpen] = useState(false);
  const [driveModalTab, setDriveModalTab] = useState<'browse' | 'export' | 'activity'>(
    'browse'
  );
  const [tasksDrawerOpen, setTasksDrawerOpen] = useState(false);
  const [stagedTaskIndices, setStagedTaskIndices] = useState<number[] | null>(null);
  const [workspaceLinks, setWorkspaceLinks] = useState<WorkspaceLinkItem[]>([]);
  const [cloudSyncStatus, setCloudSyncStatus] = useState<'local' | 'syncing' | 'synced'>(
    'local'
  );
  const [mobileSourcesOpen, setMobileSourcesOpen] = useState(false);
  const [inspectedTarget, setInspectedTarget] = useState<InspectedSourceTarget | null>(
    null
  );

  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const [synthesizingSegmentId, setSynthesizingSegmentId] = useState<string | null>(null);
  const [isSynthesizingAll, setIsSynthesizingAll] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const [isRefining, setIsRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);

  // Audio playback state (initialized from saved position when returning to an active briefing)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeObjectUrlRef = useRef<string | null>(null);
  const pendingSeekTimeRef = useRef<number | null>(null);
  const pendingAutoPlayRef = useRef<boolean>(false);
  const lastPlaybackSaveMsRef = useRef<number>(0);

  const initialSavedPosition = (() => {
    if (!activeBriefing) return null;
    return playbackPositions[activeBriefing.id] ?? null;
  })();

  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number>(() => {
    if (!activeBriefing || !initialSavedPosition) return 0;
    return Math.max(
      0,
      Math.min(initialSavedPosition.segmentIndex, activeBriefing.segments.length - 1)
    );
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState<number>(
    () => initialSavedPosition?.currentTime ?? 0
  );
  const [duration, setDuration] = useState<number>(
    () => initialSavedPosition?.duration ?? 0
  );
  const [playbackRate, setPlaybackRate] = useState<number>(
    () => initialSavedPosition?.playbackRate ?? 1
  );
  const [commuteModeOpen, setCommuteModeOpen] = useState(false);

  // Sleep timer state
  const [sleepTimerMode, setSleepTimerMode] = useState<SleepTimerMode>('off');
  const [sleepTimerRemainingSec, setSleepTimerRemainingSec] = useState<number | null>(
    null
  );

  // Keep fresh snapshot ref for pagehide / visibilitychange saves
  const latestPlaybackRef = useRef({
    briefingId: activeBriefing?.id ?? null,
    segmentIndex: activeSegmentIndex,
    currentTime,
    duration,
    playbackRate,
  });

  useEffect(() => {
    latestPlaybackRef.current = {
      briefingId: activeBriefing?.id ?? null,
      segmentIndex: activeSegmentIndex,
      currentTime,
      duration,
      playbackRate,
    };
  }, [activeBriefing?.id, activeSegmentIndex, currentTime, duration, playbackRate]);

  // Multi-turn Editor Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatSending, setIsChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const chatAudioRef = useRef<HTMLAudioElement | null>(null);
  const chatAudioUrlRef = useRef<string | null>(null);

  // Keep live state refs for initial Firestore cloud bootstrap without re-subscribing
  const articlesRef = useRef<NewsArticle[]>(articles);
  articlesRef.current = articles;
  const archiveRef = useRef<AudioBriefing[]>(archive);
  archiveRef.current = archive;
  const playbackPositionsRef = useRef<Record<string, PlaybackPosition>>(playbackPositions);
  playbackPositionsRef.current = playbackPositions;
  const bootstrappedSourcesUidRef = useRef<string | null>(null);
  const bootstrappedBriefingsUidRef = useRef<string | null>(null);

  // Persist articles, preferences, and lightweight archive metadata
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_ARTICLES_KEY, JSON.stringify(articles));
    } catch {
      // Ignore storage quota errors
    }
  }, [articles]);

  // Real-time Firestore cloud sync for Notebook Sources, Briefing Archive + Playback, and Workspace Links
  useEffect(() => {
    if (!verifiedOwnerId) {
      bootstrappedSourcesUidRef.current = null;
      bootstrappedBriefingsUidRef.current = null;
      setWorkspaceLinks([]);
      setCloudSyncStatus('local');
      return;
    }

    setCloudSyncStatus('syncing');

    const unsubSources = subscribeToNotebookSources(verifiedOwnerId, (cloudSources) => {
      if (
        cloudSources.length === 0 &&
        bootstrappedSourcesUidRef.current !== verifiedOwnerId
      ) {
        bootstrappedSourcesUidRef.current = verifiedOwnerId;
        const seedSources = articlesRef.current;
        if (seedSources.length > 0) {
          void Promise.all(
            seedSources.map((src) =>
              upsertNotebookSourceToFirestore(verifiedOwnerId, src)
            )
          ).finally(() => setCloudSyncStatus('synced'));
        } else {
          setCloudSyncStatus('synced');
        }
        return;
      }

      bootstrappedSourcesUidRef.current = verifiedOwnerId;
      setCloudSyncStatus('synced');
      setArticles((prev) => {
        const sig = (list: NewsArticle[]) =>
          JSON.stringify(
            list.map((a) => [
              a.id,
              a.title,
              a.category,
              a.summary,
              a.content.length,
              a.estimatedReadMinutes,
              a.selected,
              Boolean(a.readLater),
              a.tags ?? [],
              a.driveFileId ?? '',
              a.driveWebViewLink ?? '',
            ])
          );
        return sig(prev) === sig(cloudSources) ? prev : cloudSources;
      });
    });

    const unsubBriefings = subscribeToBriefingArchives(verifiedOwnerId, (records) => {
      if (
        records.length === 0 &&
        bootstrappedBriefingsUidRef.current !== verifiedOwnerId
      ) {
        bootstrappedBriefingsUidRef.current = verifiedOwnerId;
        const seedArchive = archiveRef.current;
        if (seedArchive.length > 0) {
          void Promise.all(
            seedArchive.map((b) =>
              upsertBriefingArchiveToFirestore(
                verifiedOwnerId,
                b,
                playbackPositionsRef.current[b.id] ?? null
              )
            )
          ).finally(() => setCloudSyncStatus('synced'));
        } else {
          setCloudSyncStatus('synced');
        }
        return;
      }

      bootstrappedBriefingsUidRef.current = verifiedOwnerId;
      setCloudSyncStatus('synced');

      setArchive((prev) => {
        const localMap = new Map(prev.map((b) => [b.id, b]));
        const merged = records.map(({ briefing: cloudB }) => {
          const localB = localMap.get(cloudB.id);
          if (!localB) return cloudB;
          return {
            ...cloudB,
            segments: cloudB.segments.map((seg) => {
              const localSeg = localB.segments.find((ls) => ls.id === seg.id);
              return localSeg?.audioBase64
                ? {
                    ...seg,
                    audioBase64: localSeg.audioBase64,
                    audioDurationSeconds:
                      seg.audioDurationSeconds ?? localSeg.audioDurationSeconds,
                  }
                : seg;
            }),
          };
        });

        const sig = (list: AudioBriefing[]) =>
          JSON.stringify(
            list.map((b) => [
              b.id,
              b.editionTitle,
              b.exportedDocUrl ?? '',
              b.exportedWavUrl ?? '',
              b.syncedTaskCount ?? 0,
              b.segments.map((s) => [
                s.id,
                s.title,
                s.coHostVoiceName ?? '',
                Boolean(s.audioStale),
                s.lines.length,
              ]),
            ])
          );
        return sig(prev) === sig(merged) ? prev : merged;
      });

      setActiveBriefing((prev) => {
        if (!prev) return records[0]?.briefing ?? null;
        const match = records.find((r) => r.briefing.id === prev.id)?.briefing;
        if (!match) return prev;
        const mergedActive: AudioBriefing = {
          ...match,
          segments: match.segments.map((seg) => {
            const localSeg = prev.segments.find((ls) => ls.id === seg.id);
            return localSeg?.audioBase64
              ? {
                  ...seg,
                  audioBase64: localSeg.audioBase64,
                  audioDurationSeconds:
                    seg.audioDurationSeconds ?? localSeg.audioDurationSeconds,
                }
              : seg;
          }),
        };
        const sameMeta =
          prev.editionTitle === mergedActive.editionTitle &&
          (prev.exportedDocUrl ?? '') === (mergedActive.exportedDocUrl ?? '') &&
          (prev.exportedWavUrl ?? '') === (mergedActive.exportedWavUrl ?? '') &&
          (prev.syncedTaskCount ?? 0) === (mergedActive.syncedTaskCount ?? 0) &&
          JSON.stringify(
            prev.segments.map((s) => [s.id, s.lines, s.coHostVoiceName])
          ) ===
            JSON.stringify(
              mergedActive.segments.map((s) => [s.id, s.lines, s.coHostVoiceName])
            );
        return sameMeta ? prev : mergedActive;
      });

      setPlaybackPositions((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const { briefing: cloudB, playback } of records) {
          if (!playback) continue;
          const localPb = prev[cloudB.id];
          if (!localPb || playback.updatedAt > localPb.updatedAt) {
            next[cloudB.id] = playback;
            changed = true;
          }
        }
        if (changed) {
          try {
            localStorage.setItem(STORAGE_PLAYBACK_KEY, JSON.stringify(next));
          } catch {
            // Ignore storage quota errors
          }
        }
        return changed ? next : prev;
      });
    });

    const unsubLinks = subscribeToWorkspaceLinks(verifiedOwnerId, (links) => {
      setWorkspaceLinks(links);
    });

    return () => {
      unsubSources();
      unsubBriefings();
      unsubLinks();
    };
  }, [verifiedOwnerId]);

  // Automatically generate context-relevant tags for any sources missing tags
  useEffect(() => {
    const untagged = articles.filter(
      (a) =>
        (!a.tags || a.tags.length === 0) &&
        !autoTagAttemptedIdsRef.current.has(a.id)
    );
    if (untagged.length === 0) return;

    untagged.forEach((a) => autoTagAttemptedIdsRef.current.add(a.id));
    let cancelled = false;

    setIsTagging(true);
    generateSourceTags(
      untagged.map((a) => ({
        id: a.id,
        title: a.title,
        summary: a.summary,
        content: a.content,
        category: a.category,
      }))
    )
      .then((tagsById) => {
        if (cancelled) return;
        const updatedItems = articlesRef.current
          .filter((a) => tagsById[a.id] && tagsById[a.id].length > 0)
          .map((a) => ({ ...a, tags: tagsById[a.id] }));
        setArticles((prev) =>
          prev.map((a) =>
            tagsById[a.id] && tagsById[a.id].length > 0
              ? { ...a, tags: tagsById[a.id] }
              : a
          )
        );
        if (verifiedOwnerId && updatedItems.length > 0) {
          for (const item of updatedItems) {
            void upsertNotebookSourceToFirestore(verifiedOwnerId, item);
          }
        }
      })
      .catch(() => {
        // Silently skip auto-tag failure so UI stays responsive
      })
      .finally(() => {
        if (!cancelled) setIsTagging(false);
      });

    return () => {
      cancelled = true;
    };
  }, [articles, verifiedOwnerId]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFS_KEY, JSON.stringify(preferences));
    } catch {
      // Ignore storage quota errors
    }
  }, [preferences]);

  useEffect(() => {
    try {
      const compact = archive.slice(0, 15).map(stripAudioForStorage);
      localStorage.setItem(STORAGE_ARCHIVE_KEY, JSON.stringify(compact));
    } catch {
      // Ignore storage quota errors
    }
  }, [archive]);

  // Automatic background synchronization for Private Podcast RSS Feed
  useEffect(() => {
    const activeFeed = rssFeedConfigRef.current;
    if (!activeFeed || !activeFeed.autoSync) return;

    const timer = window.setTimeout(() => {
      const latestFeed = rssFeedConfigRef.current;
      if (!latestFeed || !latestFeed.autoSync || rssSyncInFlightRef.current) {
        return;
      }
      rssSyncInFlightRef.current = true;
      setIsRssAutoSyncing(true);
      void (async () => {
        try {
          const authToken = await getIdToken().catch(() => null);
          const result = await syncArchiveToPrivateFeed(latestFeed, archive, {
            authToken,
          });
          if (
            result.uploadedCount > 0 ||
            result.removedCount > 0 ||
            result.reprovisioned
          ) {
            setRssFeedConfig(result.config);
          }
        } catch {
          // Background auto-sync failures remain non-blocking; user can retry in modal
        } finally {
          rssSyncInFlightRef.current = false;
          setIsRssAutoSyncing(false);
        }
      })();
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [archive, rssFeedConfig?.feedId, rssFeedConfig?.autoSync, getIdToken]);

  // Persist active briefing ID so returning users restore their exact edition
  useEffect(() => {
    try {
      if (activeBriefing?.id) {
        localStorage.setItem(STORAGE_ACTIVE_BRIEFING_KEY, activeBriefing.id);
      } else {
        localStorage.removeItem(STORAGE_ACTIVE_BRIEFING_KEY);
      }
    } catch {
      // Ignore storage quota errors
    }
  }, [activeBriefing?.id]);

  // Helper to persist playback position immediately or throttled
  const persistPlaybackPosition = useCallback(
    (
      briefingId: string,
      segmentIndex: number,
      timeSec: number,
      durSec: number,
      rate: number,
      forceImmediate = false,
      markCompleted = false
    ) => {
      const now = Date.now();
      if (!forceImmediate && now - lastPlaybackSaveMsRef.current < 1000) {
        return;
      }
      lastPlaybackSaveMsRef.current = now;

      const safeTime = Number.isFinite(timeSec) && timeSec >= 0 ? timeSec : 0;
      const safeDur = Number.isFinite(durSec) && durSec >= 0 ? durSec : 0;

      setPlaybackPositions((prev) => {
        const existing = prev[briefingId];
        const targetBriefing =
          (activeBriefing?.id === briefingId ? activeBriefing : null) ||
          archive.find((b) => b.id === briefingId);

        let cumulativeSec = safeTime;
        let totalBriefingSec = 0;
        if (targetBriefing) {
          for (let i = 0; i < targetBriefing.segments.length; i++) {
            const segDur = Math.max(
              10,
              Math.round(
                targetBriefing.segments[i].audioDurationSeconds ||
                  targetBriefing.segments[i].estimatedSeconds ||
                  60
              )
            );
            totalBriefingSec += segDur;
            if (i < segmentIndex) {
              cumulativeSec += segDur;
            }
          }
        }

        const isCompleted = Boolean(markCompleted || existing?.completed);
        const maxListenedSeconds = Math.round(
          Math.max(
            existing?.maxListenedSeconds ?? 0,
            cumulativeSec,
            isCompleted && totalBriefingSec > 0 ? totalBriefingSec : 0
          )
        );

        const entry: PlaybackPosition = {
          briefingId,
          segmentIndex,
          currentTime: safeTime,
          duration: safeDur,
          playbackRate: rate,
          updatedAt: new Date().toISOString(),
          completed: isCompleted,
          maxListenedSeconds,
        };

        const next = { ...prev, [briefingId]: entry };
        try {
          localStorage.setItem(STORAGE_PLAYBACK_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage quota errors
        }
        if (forceImmediate && verifiedOwnerId) {
          void updateBriefingPlaybackInFirestore(verifiedOwnerId, briefingId, entry);
        }
        return next;
      });
    },
    [activeBriefing, archive, verifiedOwnerId]
  );

  // Flush playback position when tab hides or closes
  useEffect(() => {
    const flushNow = () => {
      const snap = latestPlaybackRef.current;
      if (!snap.briefingId) return;
      const liveTime = audioRef.current?.currentTime ?? snap.currentTime;
      const liveDur = audioRef.current?.duration || snap.duration;
      persistPlaybackPosition(
        snap.briefingId,
        snap.segmentIndex,
        liveTime,
        liveDur,
        snap.playbackRate,
        true
      );
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flushNow();
      }
    };

    window.addEventListener('pagehide', flushNow);
    window.addEventListener('beforeunload', flushNow);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      window.removeEventListener('beforeunload', flushNow);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [persistPlaybackPosition]);

  // Ensure co-host voice(s) differ from lead voice when switching
  const handlePreferencesChange = useCallback((next: BriefingPreferences) => {
    const availableCoHosts = VOICE_OPTIONS.filter((v) => v.name !== next.voiceName);
    let updated = { ...next };

    if (updated.format === 'podcast' && updated.voiceName === updated.coHostVoiceName) {
      updated.coHostVoiceName = availableCoHosts[0].name;
    }

    if (updated.segmentCoHostVoices) {
      const cleanedMap: Record<string, VoiceName> = {};
      let rotateIdx = 0;
      for (const [articleId, voice] of Object.entries(updated.segmentCoHostVoices)) {
        if (voice === updated.voiceName) {
          cleanedMap[articleId] =
            availableCoHosts[rotateIdx % availableCoHosts.length].name;
          rotateIdx++;
        } else {
          cleanedMap[articleId] = voice;
        }
      }
      updated.segmentCoHostVoices = cleanedMap;
    }

    setPreferences(updated);
  }, []);

  // Cleanup audio object URLs on unmount
  useEffect(() => {
    return () => {
      if (activeObjectUrlRef.current) {
        URL.revokeObjectURL(activeObjectUrlRef.current);
      }
      if (chatAudioUrlRef.current) {
        URL.revokeObjectURL(chatAudioUrlRef.current);
      }
    };
  }, []);

  // Sync audio playback rate
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Stop chat read-aloud helper
  const stopChatAudio = useCallback(() => {
    if (chatAudioRef.current) {
      chatAudioRef.current.pause();
      chatAudioRef.current.currentTime = 0;
    }
    setPlayingMessageId(null);
  }, []);

  // Load and play a specific chapter index (with optional exact seek restoration)
  const loadAndPlaySegment = useCallback(
    (
      briefingObj: AudioBriefing,
      index: number,
      autoPlay: boolean,
      initialSeekSeconds = 0
    ) => {
      const seg = briefingObj.segments[index];
      if (!seg || !seg.audioBase64) return;

      stopChatAudio();

      if (activeObjectUrlRef.current) {
        URL.revokeObjectURL(activeObjectUrlRef.current);
      }
      const objectUrl = base64WavToObjectUrl(seg.audioBase64);
      activeObjectUrlRef.current = objectUrl;

      const seekTarget =
        Number.isFinite(initialSeekSeconds) && initialSeekSeconds > 0
          ? initialSeekSeconds
          : 0;

      setActiveSegmentIndex(index);
      setCurrentTime(seekTarget);
      if (seg.audioDurationSeconds) {
        setDuration(seg.audioDurationSeconds);
      }

      const audioEl = audioRef.current;
      if (!audioEl) return;

      pendingSeekTimeRef.current = seekTarget > 0 ? seekTarget : null;
      pendingAutoPlayRef.current = autoPlay;

      audioEl.src = objectUrl;
      audioEl.playbackRate = playbackRate;
      audioEl.load();

      if (autoPlay && seekTarget === 0) {
        pendingAutoPlayRef.current = false;
        audioEl
          .play()
          .then(() => setIsPlaying(true))
          .catch(() => setIsPlaying(false));
      } else if (!autoPlay) {
        setIsPlaying(false);
      }
    },
    [playbackRate, stopChatAudio]
  );

  // Hydrate cached chapter audio from IndexedDB when returning to a saved active briefing
  const hasHydratedInitialRef = useRef(false);
  useEffect(() => {
    if (hasHydratedInitialRef.current || !activeBriefing) return;
    hasHydratedInitialRef.current = true;

    const targetId = activeBriefing.id;
    const savedPos = playbackPositions[targetId];

    loadBriefingAudio(targetId).then((audioMap) => {
      if (Object.keys(audioMap).length === 0) return;

      const hydrated: AudioBriefing = {
        ...activeBriefing,
        segments: activeBriefing.segments.map((seg) => {
          const cached = audioMap[seg.id];
          if (!cached) return seg;
          const exactSeconds = getWavDurationSeconds(cached);
          return {
            ...seg,
            audioBase64: cached,
            audioDurationSeconds:
              exactSeconds > 0 ? exactSeconds : seg.audioDurationSeconds,
            audioStale: false,
          };
        }),
      };

      setActiveBriefing(hydrated);

      const desiredIdx = savedPos
        ? Math.max(0, Math.min(savedPos.segmentIndex, hydrated.segments.length - 1))
        : 0;
      const desiredTime = savedPos?.currentTime ?? 0;

      if (hydrated.segments[desiredIdx]?.audioBase64) {
        loadAndPlaySegment(hydrated, desiredIdx, false, desiredTime);
      } else {
        const firstReady = hydrated.segments.findIndex((s) => Boolean(s.audioBase64));
        if (firstReady >= 0) {
          loadAndPlaySegment(hydrated, firstReady, false, 0);
        }
      }
    });
  }, [activeBriefing, loadAndPlaySegment, playbackPositions]);

  // Helper to read binary document files (PDF / DOCX) as base64
  const readFileAsBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const commaIdx = result.indexOf(',');
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
      };
      reader.onerror = () => reject(new Error(`Could not read "${file.name}".`));
      reader.readAsDataURL(file);
    });
  }, []);

  const handleOpenAddModal = useCallback(
    (tab: AddSourceTab = 'upload') => {
      setIngestError(null);
      setAddModalTab(tab);
      setAddModalOpen(true);
    },
    []
  );

  // Upload user documents (PDF, DOCX, TXT, Markdown) into Notebook Sources
  const handleUploadFiles = useCallback(
    async (files: FileList | File[]): Promise<boolean> => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return false;

      const MAX_BYTES = 15 * 1024 * 1024;
      setIngestError(null);
      setIsIngesting(true);

      let uploadedCount = 0;
      try {
        for (let i = 0; i < fileArray.length; i++) {
          const file = fileArray[i];
          const lower = file.name.toLowerCase();
          const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
          const isDocx =
            lower.endsWith('.docx') ||
            file.type ===
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const isTxt = lower.endsWith('.txt') || file.type === 'text/plain';
          const isMd =
            lower.endsWith('.md') ||
            lower.endsWith('.markdown') ||
            file.type === 'text/markdown';

          if (!isPdf && !isDocx && !isTxt && !isMd) {
            throw new Error(
              `Unsupported file "${file.name}". Upload PDF, Word (DOCX), TXT, or Markdown.`
            );
          }
          if (file.size > MAX_BYTES) {
            throw new Error(`"${file.name}" exceeds the 15 MB limit.`);
          }

          setUploadStatus(
            `Indexing ${file.name} (${i + 1} of ${fileArray.length})...`
          );

          let extracted: Omit<NewsArticle, 'id' | 'selected' | 'addedAt'>;
          if (isPdf || isDocx) {
            const base64Data = await readFileAsBase64(file);
            extracted = await uploadDocumentSource({
              fileName: file.name,
              mimeType:
                file.type ||
                (isPdf
                  ? 'application/pdf'
                  : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
              base64Data,
              fileSizeBytes: file.size,
            });
          } else {
            const textContent = await file.text();
            extracted = await uploadDocumentSource({
              fileName: file.name,
              mimeType: file.type || (isMd ? 'text/markdown' : 'text/plain'),
              textContent,
              fileSizeBytes: file.size,
            });
          }

          const newSource = ensureArticlePassages({
            ...extracted,
            id: `src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            selected: true,
            addedAt: new Date().toISOString(),
          });
          setArticles((prev) => [newSource, ...prev]);
          if (verifiedOwnerId) {
            void upsertNotebookSourceToFirestore(verifiedOwnerId, newSource);
          }
          uploadedCount++;
        }
        return uploadedCount > 0;
      } catch (err) {
        setIngestError(
          err instanceof Error ? err.message : 'Failed to upload document.'
        );
        return uploadedCount > 0;
      } finally {
        setIsIngesting(false);
        setUploadStatus(null);
      }
    },
    [readFileAsBase64, verifiedOwnerId]
  );

  // Import Google Docs & Drive files while preserving Drive provenance and syncing to Firestore
  const handleImportDriveItems = useCallback(
    async (
      items: Array<{ file: File; driveItem: DriveFileItem }>
    ): Promise<boolean> => {
      if (items.length === 0) return false;

      const MAX_BYTES = 15 * 1024 * 1024;
      setIngestError(null);
      setIsIngesting(true);

      let importedCount = 0;
      let firstTitle = '';

      try {
        for (let i = 0; i < items.length; i++) {
          const { file, driveItem } = items[i];
          const lower = file.name.toLowerCase();
          const isPdf = lower.endsWith('.pdf') || file.type === 'application/pdf';
          const isDocx =
            lower.endsWith('.docx') ||
            file.type ===
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const isMd =
            lower.endsWith('.md') ||
            lower.endsWith('.markdown') ||
            file.type === 'text/markdown';

          if (file.size > MAX_BYTES) {
            throw new Error(`"${file.name}" exceeds the 15 MB limit.`);
          }

          setUploadStatus(
            `Indexing "${driveItem.name}" from Google Drive (${i + 1} of ${items.length})...`
          );

          let extracted: Omit<NewsArticle, 'id' | 'selected' | 'addedAt'>;
          if (isPdf || isDocx) {
            const base64Data = await readFileAsBase64(file);
            extracted = await uploadDocumentSource({
              fileName: file.name,
              mimeType:
                file.type ||
                (isPdf
                  ? 'application/pdf'
                  : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
              base64Data,
              fileSizeBytes: file.size,
            });
          } else {
            const textContent = await file.text();
            extracted = await uploadDocumentSource({
              fileName: file.name,
              mimeType: file.type || (isMd ? 'text/markdown' : 'text/plain'),
              textContent,
              fileSizeBytes: file.size,
            });
          }

          const isGoogleDoc =
            driveItem.mimeType === 'application/vnd.google-apps.document';
          const newSource = ensureArticlePassages({
            ...extracted,
            id: `drv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            source: isGoogleDoc ? 'Google Docs' : extracted.source || 'Google Drive',
            url: driveItem.webViewLink || extracted.url,
            driveFileId: driveItem.id,
            driveWebViewLink: driveItem.webViewLink,
            driveMimeType: driveItem.mimeType,
            selected: true,
            addedAt: new Date().toISOString(),
          });

          if (!firstTitle) firstTitle = newSource.title;
          setArticles((prev) => [newSource, ...prev]);

          if (verifiedOwnerId) {
            void upsertNotebookSourceToFirestore(verifiedOwnerId, newSource);
            void upsertWorkspaceLinkToFirestore(verifiedOwnerId, {
              kind: 'drive_source',
              externalId: driveItem.id,
              title: newSource.title,
              url: driveItem.webViewLink,
              sourceId: newSource.id,
            });
          }
          importedCount++;
        }

        if (importedCount > 0) {
          showTransferToast({
            target: 'notebook',
            title:
              importedCount === 1
                ? 'Imported from Google Drive'
                : `Imported ${importedCount} Drive Documents`,
            description:
              'Indexed passages for clickable citations and synced to your workspace.',
            label: firstTitle || 'Google Drive Source',
          });
        }

        return importedCount > 0;
      } catch (err) {
        setIngestError(
          err instanceof Error ? err.message : 'Failed to import from Google Drive.'
        );
        return importedCount > 0;
      } finally {
        setIsIngesting(false);
        setUploadStatus(null);
      }
    },
    [readFileAsBase64, showTransferToast, verifiedOwnerId]
  );

  // Article URL / pasted text ingestion
  const handleIngestArticle = useCallback(
    async (payload: { url?: string; rawText?: string }): Promise<boolean> => {
      setIngestError(null);
      setIsIngesting(true);
      setUploadStatus(
        payload.url ? 'Reading article and indexing passages...' : 'Indexing pasted text...'
      );
      try {
        const extracted = await ingestArticle(payload);
        const newArticle = ensureArticlePassages({
          ...extracted,
          id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          selected: true,
          addedAt: new Date().toISOString(),
        });
        setArticles((prev) => [newArticle, ...prev]);
        if (verifiedOwnerId) {
          void upsertNotebookSourceToFirestore(verifiedOwnerId, newArticle);
        }
        return true;
      } catch (err) {
        setIngestError(
          err instanceof Error ? err.message : 'Failed to ingest article.'
        );
        return false;
      } finally {
        setIsIngesting(false);
        setUploadStatus(null);
      }
    },
    [verifiedOwnerId]
  );

  const handleToggleArticle = useCallback(
    (id: string) => {
      const existing = articlesRef.current.find((a) => a.id === id);
      const updatedItem = existing ? { ...existing, selected: !existing.selected } : null;
      setArticles((prev) =>
        prev.map((a) => (a.id === id ? { ...a, selected: !a.selected } : a))
      );
      if (verifiedOwnerId && updatedItem) {
        void upsertNotebookSourceToFirestore(verifiedOwnerId, updatedItem);
      }
    },
    [verifiedOwnerId]
  );

  const handleToggleAll = useCallback(
    (selected: boolean) => {
      const changed = articlesRef.current
        .filter((a) => !a.readLater)
        .map((a) => ({ ...a, selected }));
      setArticles((prev) =>
        prev.map((a) => (a.readLater ? a : { ...a, selected }))
      );
      if (verifiedOwnerId && changed.length > 0) {
        for (const item of changed) {
          void upsertNotebookSourceToFirestore(verifiedOwnerId, item);
        }
      }
    },
    [verifiedOwnerId]
  );

  const handleBulkToggleCategory = useCallback(
    (category: string, selected: boolean) => {
      const targetKey = (category.trim() || 'General').toLowerCase();
      const changed: NewsArticle[] = [];
      const nextArticles = articlesRef.current.map((a) => {
        if (a.readLater) return a;
        const articleKey = ((a.category || '').trim() || 'General').toLowerCase();
        if (articleKey !== targetKey || a.selected === selected) {
          return a;
        }
        const updated = { ...a, selected };
        changed.push(updated);
        return updated;
      });

      if (changed.length === 0) return;

      articlesRef.current = nextArticles;
      setArticles(nextArticles);

      if (verifiedOwnerId) {
        for (const item of changed) {
          void upsertNotebookSourceToFirestore(verifiedOwnerId, item);
        }
      }
    },
    [verifiedOwnerId]
  );

  const handleToggleReadLater = useCallback(
    (id: string) => {
      const existing = articlesRef.current.find((a) => a.id === id);
      const nowIso = new Date().toISOString();
      const updatedItem = existing
        ? {
            ...existing,
            readLater: !existing.readLater,
            selected: !existing.readLater ? false : true,
            shelvedAt: !existing.readLater ? nowIso : undefined,
          }
        : null;
      setArticles((prev) =>
        prev.map((a) => {
          if (a.id !== id) return a;
          const movingToReadLater = !a.readLater;
          return {
            ...a,
            readLater: movingToReadLater,
            selected: movingToReadLater ? false : true,
            shelvedAt: movingToReadLater ? nowIso : undefined,
          };
        })
      );
      if (verifiedOwnerId && updatedItem) {
        void upsertNotebookSourceToFirestore(verifiedOwnerId, updatedItem);
      }
    },
    [verifiedOwnerId]
  );

  const handleRestoreAllReadLater = useCallback(() => {
    const restored = articlesRef.current
      .filter((a) => Boolean(a.readLater))
      .map((a) => ({
        ...a,
        readLater: false,
        selected: true,
        shelvedAt: undefined,
      }));
    setArticles((prev) =>
      prev.map((a) =>
        a.readLater
          ? { ...a, readLater: false, selected: true, shelvedAt: undefined }
          : a
      )
    );
    if (verifiedOwnerId && restored.length > 0) {
      for (const item of restored) {
        void upsertNotebookSourceToFirestore(verifiedOwnerId, item);
      }
    }
  }, [verifiedOwnerId]);

  const handleRemoveArticle = useCallback(
    (id: string) => {
      setArticles((prev) => prev.filter((a) => a.id !== id));
      setInspectedTarget((prev) => (prev?.sourceId === id ? null : prev));
      if (verifiedOwnerId) {
        void deleteNotebookSourceFromFirestore(verifiedOwnerId, id);
      }
    },
    [verifiedOwnerId]
  );

  const handleResetSamples = useCallback(() => {
    setIngestError(null);
    const sampleIds = new Set(SAMPLE_ARTICLES.map((s) => s.id));
    const freshSamples = SAMPLE_ARTICLES.map((a) =>
      ensureArticlePassages({
        ...a,
        selected: true,
        readLater: false,
        shelvedAt: undefined,
      })
    );
    const removedIds = articlesRef.current
      .filter((a) => !a.readLater && !sampleIds.has(a.id))
      .map((a) => a.id);
    setArticles((prev) => {
      const keptReadLater = prev.filter(
        (a) => Boolean(a.readLater) && !sampleIds.has(a.id)
      );
      return [...freshSamples, ...keptReadLater];
    });
    if (verifiedOwnerId) {
      for (const id of removedIds) {
        void deleteNotebookSourceFromFirestore(verifiedOwnerId, id);
      }
      for (const sample of freshSamples) {
        void upsertNotebookSourceToFirestore(verifiedOwnerId, sample);
      }
    }
  }, [verifiedOwnerId]);

  const runAutoTagForSources = useCallback(
    async (targetSources?: NewsArticle[]) => {
      const sourceList = Array.isArray(targetSources)
        ? targetSources
        : articlesRef.current;
      if (sourceList.length === 0) return;

      sourceList.forEach((a) => autoTagAttemptedIdsRef.current.add(a.id));
      setIsTagging(true);
      try {
        const mergedTagsById: Record<string, string[]> = {};
        for (let offset = 0; offset < sourceList.length; offset += 20) {
          const batch = sourceList.slice(offset, offset + 20);
          const batchTags = await generateSourceTags(
            batch.map((a) => ({
              id: a.id,
              title: a.title,
              summary: a.summary,
              content: a.content,
              category: a.category,
            }))
          );
          Object.assign(mergedTagsById, batchTags);
        }

        const nextArticles = articlesRef.current.map((a) =>
          mergedTagsById[a.id] && mergedTagsById[a.id].length > 0
            ? { ...a, tags: mergedTagsById[a.id] }
            : a
        );
        const updatedItems = nextArticles.filter(
          (a) => mergedTagsById[a.id] && mergedTagsById[a.id].length > 0
        );

        articlesRef.current = nextArticles;
        setArticles(nextArticles);

        if (verifiedOwnerId && updatedItems.length > 0) {
          for (const item of updatedItems) {
            void upsertNotebookSourceToFirestore(verifiedOwnerId, item);
          }
        }
      } catch {
        // Non-fatal: keep existing tags intact
      } finally {
        setIsTagging(false);
      }
    },
    [verifiedOwnerId]
  );

  const handleAutoTagSources = useCallback(async () => {
    if (articlesRef.current.length === 0 || isTagging) return;
    await runAutoTagForSources(articlesRef.current);
  }, [isTagging, runAutoTagForSources]);

  const handleRefreshAllArticles = useCallback(async () => {
    if (isRefreshingArticles || isIngesting) return;
    const snapshot = articlesRef.current;
    if (snapshot.length === 0) return;

    const urlSources = snapshot.filter(isRefreshableUrlSource);
    setRefreshArticlesError(null);
    setIsRefreshingArticles(true);

    let workingArticles = [...snapshot];
    let refreshedCount = 0;
    const failedTitles: string[] = [];

    try {
      for (let i = 0; i < urlSources.length; i++) {
        const target = urlSources[i];
        const targetUrl = target.url!.trim();
        setRefreshArticlesStatus(
          `Refreshing URL ${i + 1} of ${urlSources.length}: ${target.title}`
        );

        try {
          const extracted = await ingestArticle({ url: targetUrl });
          autoTagAttemptedIdsRef.current.add(target.id);

          const updatedArticle = ensureArticlePassages({
            ...target,
            ...extracted,
            id: target.id,
            url: extracted.url || targetUrl,
            selected: target.selected,
            readLater: target.readLater,
            shelvedAt: target.shelvedAt,
            addedAt: target.addedAt,
            imageUrl: extracted.imageUrl || target.imageUrl,
            tags:
              extracted.tags && extracted.tags.length > 0
                ? extracted.tags
                : target.tags,
            passages: undefined,
          });

          workingArticles = workingArticles.map((item) =>
            item.id === target.id ? updatedArticle : item
          );
          articlesRef.current = workingArticles;
          setArticles(workingArticles);

          if (verifiedOwnerId) {
            void upsertNotebookSourceToFirestore(verifiedOwnerId, updatedArticle);
          }
          refreshedCount++;
        } catch {
          failedTitles.push(target.title);
        }
      }

      setRefreshArticlesStatus('Regenerating automatic topic tags...');
      workingArticles.forEach((a) => autoTagAttemptedIdsRef.current.delete(a.id));
      await runAutoTagForSources(workingArticles);

      if (failedTitles.length > 0) {
        setRefreshArticlesError(
          `Updated ${refreshedCount} of ${urlSources.length} URL ${
            urlSources.length === 1 ? 'source' : 'sources'
          }. Could not refresh: ${failedTitles.slice(0, 2).join(', ')}${
            failedTitles.length > 2 ? ` (+${failedTitles.length - 2} more)` : ''
          }.`
        );
      } else if (urlSources.length > 0) {
        showTransferToast({
          target: 'notebook',
          title:
            refreshedCount === 1
              ? 'Refreshed 1 Article & Updated Tags'
              : `Refreshed ${refreshedCount} Articles & Updated Tags`,
          description:
            'Re-fetched URL content, re-indexed passages, and regenerated newsroom topic tags.',
          label: urlSources[0]?.title || 'Notebook Sources',
        });
      } else {
        showTransferToast({
          target: 'notebook',
          title: 'Topic Tags Regenerated',
          description:
            'No external article URLs were queued to re-fetch; refreshed automatic tags across your current sources.',
          label: `${workingArticles.length} ${
            workingArticles.length === 1 ? 'source' : 'sources'
          } tagged`,
        });
      }
    } finally {
      setIsRefreshingArticles(false);
      setRefreshArticlesStatus(null);
    }
  }, [
    isIngesting,
    isRefreshingArticles,
    runAutoTagForSources,
    showTransferToast,
    verifiedOwnerId,
  ]);

  const handleInspectSource = useCallback((sourceId: string) => {
    setInspectedTarget({ sourceId });
  }, []);

  const handleSelectCitation = useCallback((citation: CitationRef) => {
    setInspectedTarget({
      sourceId: citation.sourceId,
      passageIndex: citation.passageIndex,
      excerpt: citation.excerpt,
    });
  }, []);

  // Helper to update both activeBriefing, archive, and Firestore cloud sync
  const commitBriefingUpdate = useCallback(
    (updated: AudioBriefing) => {
      setActiveBriefing(updated);
      setArchive((prev) => {
        const exists = prev.some((b) => b.id === updated.id);
        if (exists) {
          return prev.map((b) => (b.id === updated.id ? updated : b));
        }
        return [updated, ...prev];
      });
      if (verifiedOwnerId) {
        void upsertBriefingArchiveToFirestore(
          verifiedOwnerId,
          updated,
          playbackPositionsRef.current[updated.id] ?? null
        );
      }
    },
    [verifiedOwnerId]
  );

  // Synthesize audio for a single chapter using gemini-3.8-flash-tts
  const synthesizeOneSegment = useCallback(
    async (briefingObj: AudioBriefing, segmentId: string): Promise<AudioBriefing> => {
      const segment = briefingObj.segments.find((s) => s.id === segmentId);
      if (!segment) return briefingObj;

      setTtsError(null);
      setSynthesizingSegmentId(segmentId);
      try {
        const result = await synthesizeSpeech({
          format: briefingObj.preferences.format,
          lines: segment.lines,
          voiceName: briefingObj.preferences.voiceName,
          coHostVoiceName:
            segment.coHostVoiceName || briefingObj.preferences.coHostVoiceName,
          tone: briefingObj.preferences.tone,
          voiceTone: briefingObj.preferences.voiceTone || 'professional',
        });

        const exactSeconds = getWavDurationSeconds(result.audioBase64);
        // Cache chapter WAV in IndexedDB for seamless resume across page reloads
        saveSegmentAudio(briefingObj.id, segmentId, result.audioBase64);
        const updated: AudioBriefing = {
          ...briefingObj,
          segments: briefingObj.segments.map((s) =>
            s.id === segmentId
              ? {
                  ...s,
                  audioBase64: result.audioBase64,
                  audioDurationSeconds: exactSeconds > 0 ? exactSeconds : s.estimatedSeconds,
                  audioStale: false,
                }
              : s
          ),
        };
        commitBriefingUpdate(updated);
        return updated;
      } finally {
        setSynthesizingSegmentId(null);
      }
    },
    [commitBriefingUpdate]
  );

  // Synthesize all unsynthesized or stale chapters sequentially so playback starts quickly
  const synthesizeAllChapters = useCallback(
    async (briefingObj: AudioBriefing, autoPlayFirst = false): Promise<AudioBriefing> => {
      setIsSynthesizingAll(true);
      setTtsError(null);
      let working = briefingObj;

      try {
        const savedPos = playbackPositions[briefingObj.id];
        const targetLoadIdx = savedPos
          ? Math.max(0, Math.min(savedPos.segmentIndex, working.segments.length - 1))
          : 0;
        const targetSeekTime = savedPos?.currentTime ?? 0;

        for (let i = 0; i < working.segments.length; i++) {
          const seg = working.segments[i];
          if (seg.audioBase64 && !seg.audioStale) continue;
          setGenerationStatus(
            `Recording chapter ${i + 1} of ${working.segments.length}...`
          );
          working = await synthesizeOneSegment(working, seg.id);
          if (autoPlayFirst && i === targetLoadIdx) {
            loadAndPlaySegment(working, targetLoadIdx, false, targetSeekTime);
          }
        }
        return working;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Failed to record briefing audio.';
        setTtsError(msg);
        throw err;
      } finally {
        setIsSynthesizingAll(false);
        setGenerationStatus(null);
      }
    },
    [loadAndPlaySegment, playbackPositions, synthesizeOneSegment]
  );

  // Full briefing generation workflow
  const handleBuildBriefing = useCallback(
    async (autoSynthesize: boolean) => {
      const selected = articles
        .filter((a) => !a.readLater && a.selected)
        .map(ensureArticlePassages);
      if (selected.length === 0) {
        setGenerationError('Select at least one active source from your notebook first.');
        return;
      }

      setGenerationError(null);
      setTtsError(null);
      setIsGenerating(true);
      setGenerationStatus('Writing cited personalized script...');

      try {
        const customIntro = preferences.personalizedIntroduction?.trim() || '';
        const requestPreferences: BriefingPreferences = {
          ...preferences,
          personalizedIntroduction: customIntro || undefined,
        };
        const generated = await generateBriefingScript(
          selected,
          requestPreferences
        );
        const availableCoHosts = VOICE_OPTIONS.filter(
          (v) => v.name !== preferences.voiceName
        );

        const resolveSegmentCoHostVoice = (
          sourceTitles: string[],
          segmentIndex: number
        ): VoiceName => {
          if (preferences.format !== 'podcast') {
            return preferences.coHostVoiceName;
          }
          if (!preferences.dynamicPanel) {
            return preferences.coHostVoiceName;
          }

          // Match segment to its source article when possible
          const matchedArticle = selected.find((art) =>
            sourceTitles.some(
              (st) =>
                st.toLowerCase().includes(art.title.toLowerCase().slice(0, 24)) ||
                art.title.toLowerCase().includes(st.toLowerCase().slice(0, 24))
            )
          );
          const candidateArticle = matchedArticle || selected[segmentIndex % selected.length];
          const chosen = candidateArticle
            ? preferences.segmentCoHostVoices?.[candidateArticle.id]
            : undefined;
          if (chosen && chosen !== preferences.voiceName) {
            return chosen;
          }
          return availableCoHosts[segmentIndex % availableCoHosts.length].name;
        };

        const enrichedSegments = generated.segments.map((seg, idx) => ({
          ...seg,
          coHostVoiceName: resolveSegmentCoHostVoice(seg.sourceTitles, idx),
        }));

        const newBriefing: AudioBriefing = {
          id: `brief-${Date.now()}`,
          createdAt: new Date().toISOString(),
          editionTitle: generated.editionTitle,
          editionSubtitle: generated.editionSubtitle,
          takeaways: generated.takeaways,
          takeawayCitations: generated.takeawayCitations,
          preferences: {
            ...requestPreferences,
            segmentCoHostVoices: { ...(preferences.segmentCoHostVoices || {}) },
          },
          articleTitles: selected.map((a) => a.title),
          segments: enrichedSegments,
        };

        commitBriefingUpdate(newBriefing);
        setActiveSegmentIndex(0);
        setCurrentTime(0);
        setDuration(0);
        setIsPlaying(false);
        persistPlaybackPosition(newBriefing.id, 0, 0, 0, playbackRate, true);
        setActiveView('briefing');

        if (autoSynthesize) {
          await synthesizeAllChapters(newBriefing, true);
        }
      } catch (err) {
        setGenerationError(
          err instanceof Error ? err.message : 'Could not build briefing.'
        );
      } finally {
        setIsGenerating(false);
        setGenerationStatus(null);
      }
    },
    [
      articles,
      preferences,
      commitBriefingUpdate,
      persistPlaybackPosition,
      playbackRate,
      synthesizeAllChapters,
    ]
  );

  // Edit a single chapter script locally
  const handleUpdateSegmentLines = useCallback(
    (segmentId: string, lines: ScriptLine[]) => {
      if (!activeBriefing) return;
      const updated: AudioBriefing = {
        ...activeBriefing,
        segments: activeBriefing.segments.map((s) =>
          s.id === segmentId
            ? {
                ...s,
                lines,
                audioStale: Boolean(s.audioBase64),
              }
            : s
        ),
      };
      commitBriefingUpdate(updated);
    },
    [activeBriefing, commitBriefingUpdate]
  );

  // Update a single chapter's co-host voice in the active briefing
  const handleUpdateSegmentCoHostVoice = useCallback(
    (segmentId: string, voice: VoiceName) => {
      if (!activeBriefing) return;
      const updated: AudioBriefing = {
        ...activeBriefing,
        segments: activeBriefing.segments.map((s) =>
          s.id === segmentId
            ? {
                ...s,
                coHostVoiceName: voice,
                audioStale: Boolean(s.audioBase64),
              }
            : s
        ),
      };
      commitBriefingUpdate(updated);
    },
    [activeBriefing, commitBriefingUpdate]
  );

  // Refine script via Gemini intelligence
  const handleRefineScript = useCallback(
    async (instruction: string, targetSegmentId?: string) => {
      if (!activeBriefing) return;
      setRefineError(null);
      setIsRefining(true);
      try {
        const updatedSegments = await refineBriefingScript({
          segments: activeBriefing.segments,
          format: activeBriefing.preferences.format,
          instruction,
          targetSegmentId,
        });

        const merged: AudioBriefing = {
          ...activeBriefing,
          segments: updatedSegments.map((seg) => ({
            ...seg,
            audioStale: Boolean(seg.audioBase64),
          })),
        };
        commitBriefingUpdate(merged);
      } catch (err) {
        setRefineError(
          err instanceof Error ? err.message : 'Could not refine script.'
        );
      } finally {
        setIsRefining(false);
      }
    },
    [activeBriefing, commitBriefingUpdate]
  );

  // Player controls
  const handleTogglePlayPause = useCallback(() => {
    const audioEl = audioRef.current;
    if (!audioEl || !activeBriefing) return;

    const currentSeg = activeBriefing.segments[activeSegmentIndex];
    if (!currentSeg?.audioBase64) {
      const firstReadyIdx = activeBriefing.segments.findIndex((s) =>
        Boolean(s.audioBase64)
      );
      if (firstReadyIdx >= 0) {
        loadAndPlaySegment(activeBriefing, firstReadyIdx, true);
      }
      return;
    }

    if (!audioEl.src) {
      loadAndPlaySegment(activeBriefing, activeSegmentIndex, true, currentTime);
      return;
    }

    if (audioEl.paused) {
      stopChatAudio();
      audioEl
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      audioEl.pause();
      setIsPlaying(false);
      persistPlaybackPosition(
        activeBriefing.id,
        activeSegmentIndex,
        audioEl.currentTime,
        audioEl.duration || duration,
        playbackRate,
        true
      );
    }
  }, [
    activeBriefing,
    activeSegmentIndex,
    currentTime,
    duration,
    loadAndPlaySegment,
    persistPlaybackPosition,
    playbackRate,
    stopChatAudio,
  ]);

  const handlePlaySegment = useCallback(
    (index: number) => {
      if (!activeBriefing) return;
      loadAndPlaySegment(activeBriefing, index, true, 0);
      const segDur = activeBriefing.segments[index]?.audioDurationSeconds ?? 0;
      persistPlaybackPosition(activeBriefing.id, index, 0, segDur, playbackRate, true);
    },
    [activeBriefing, loadAndPlaySegment, persistPlaybackPosition, playbackRate]
  );

  const handleRestartBriefing = useCallback(() => {
    if (!activeBriefing) return;
    const firstReady = activeBriefing.segments.findIndex((s) => Boolean(s.audioBase64));
    const idx = firstReady >= 0 ? firstReady : 0;
    const segDur = activeBriefing.segments[idx]?.audioDurationSeconds ?? 0;
    persistPlaybackPosition(activeBriefing.id, idx, 0, segDur, playbackRate, true);
    if (firstReady >= 0) {
      loadAndPlaySegment(activeBriefing, idx, true, 0);
    } else {
      setActiveSegmentIndex(0);
      setCurrentTime(0);
    }
  }, [activeBriefing, loadAndPlaySegment, persistPlaybackPosition, playbackRate]);

  const handleSeek = useCallback(
    (time: number) => {
      const audioEl = audioRef.current;
      if (!audioEl) return;
      const clamped = Math.max(0, Math.min(time, audioEl.duration || time));
      audioEl.currentTime = clamped;
      setCurrentTime(clamped);
      if (activeBriefing) {
        persistPlaybackPosition(
          activeBriefing.id,
          activeSegmentIndex,
          clamped,
          audioEl.duration || duration,
          playbackRate,
          true
        );
      }
    },
    [activeBriefing, activeSegmentIndex, duration, persistPlaybackPosition, playbackRate]
  );

  const handleSkipSeconds = useCallback(
    (delta: number) => {
      const audioEl = audioRef.current;
      if (!audioEl) return;
      const next = Math.max(
        0,
        Math.min((audioEl.currentTime || 0) + delta, audioEl.duration || 0)
      );
      audioEl.currentTime = next;
      setCurrentTime(next);
      if (activeBriefing) {
        persistPlaybackPosition(
          activeBriefing.id,
          activeSegmentIndex,
          next,
          audioEl.duration || duration,
          playbackRate,
          true
        );
      }
    },
    [activeBriefing, activeSegmentIndex, duration, persistPlaybackPosition, playbackRate]
  );

  const handlePrevChapter = useCallback(() => {
    if (!activeBriefing || activeSegmentIndex <= 0) return;
    for (let i = activeSegmentIndex - 1; i >= 0; i--) {
      if (activeBriefing.segments[i].audioBase64) {
        loadAndPlaySegment(activeBriefing, i, isPlaying, 0);
        persistPlaybackPosition(
          activeBriefing.id,
          i,
          0,
          activeBriefing.segments[i].audioDurationSeconds ?? 0,
          playbackRate,
          true
        );
        return;
      }
    }
  }, [
    activeBriefing,
    activeSegmentIndex,
    isPlaying,
    loadAndPlaySegment,
    persistPlaybackPosition,
    playbackRate,
  ]);

  const handleNextChapter = useCallback(() => {
    if (!activeBriefing) return;
    for (let i = activeSegmentIndex + 1; i < activeBriefing.segments.length; i++) {
      if (activeBriefing.segments[i].audioBase64) {
        loadAndPlaySegment(activeBriefing, i, isPlaying, 0);
        persistPlaybackPosition(
          activeBriefing.id,
          i,
          0,
          activeBriefing.segments[i].audioDurationSeconds ?? 0,
          playbackRate,
          true
        );
        return;
      }
    }
  }, [
    activeBriefing,
    activeSegmentIndex,
    isPlaying,
    loadAndPlaySegment,
    persistPlaybackPosition,
    playbackRate,
  ]);

  const handleCyclePlaybackRate = useCallback(() => {
    setPlaybackRate((prev) => {
      const idx = PLAYBACK_RATES.indexOf(prev);
      const nextRate = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
      if (activeBriefing) {
        persistPlaybackPosition(
          activeBriefing.id,
          activeSegmentIndex,
          audioRef.current?.currentTime ?? currentTime,
          audioRef.current?.duration || duration,
          nextRate,
          true
        );
      }
      return nextRate;
    });
  }, [activeBriefing, activeSegmentIndex, currentTime, duration, persistPlaybackPosition]);

  // Sleep timer handlers
  const handleSetSleepTimerMinutes = useCallback((minutes: number) => {
    setSleepTimerMode('countdown');
    setSleepTimerRemainingSec(minutes * 60);
  }, []);

  const handleSetSleepTimerEndOfChapter = useCallback(() => {
    setSleepTimerMode('end-of-chapter');
    setSleepTimerRemainingSec(null);
  }, []);

  const handleExtendSleepTimer = useCallback((extraMinutes: number) => {
    setSleepTimerMode('countdown');
    setSleepTimerRemainingSec((prev) => (prev ?? 0) + extraMinutes * 60);
  }, []);

  const handleCancelSleepTimer = useCallback(() => {
    setSleepTimerMode('off');
    setSleepTimerRemainingSec(null);
  }, []);

  const handleCycleCommuteSleepTimer = useCallback(() => {
    if (sleepTimerMode === 'off') {
      handleSetSleepTimerMinutes(15);
    } else if (
      sleepTimerMode === 'countdown' &&
      sleepTimerRemainingSec !== null &&
      sleepTimerRemainingSec <= 15 * 60
    ) {
      handleSetSleepTimerMinutes(30);
    } else if (
      sleepTimerMode === 'countdown' &&
      sleepTimerRemainingSec !== null &&
      sleepTimerRemainingSec <= 30 * 60
    ) {
      handleSetSleepTimerMinutes(60);
    } else if (sleepTimerMode === 'countdown') {
      handleSetSleepTimerEndOfChapter();
    } else {
      handleCancelSleepTimer();
    }
  }, [
    sleepTimerMode,
    sleepTimerRemainingSec,
    handleSetSleepTimerMinutes,
    handleSetSleepTimerEndOfChapter,
    handleCancelSleepTimer,
  ]);

  // Countdown tick & automatic pause + bookmark save when sleep timer expires
  useEffect(() => {
    if (sleepTimerMode !== 'countdown') return;

    const timerId = window.setInterval(() => {
      setSleepTimerRemainingSec((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          if (audioRef.current && !audioRef.current.paused) {
            audioRef.current.pause();
          }
          if (chatAudioRef.current && !chatAudioRef.current.paused) {
            chatAudioRef.current.pause();
          }
          setIsPlaying(false);
          setPlayingMessageId(null);

          const snap = latestPlaybackRef.current;
          if (snap.briefingId) {
            const liveTime = audioRef.current?.currentTime ?? snap.currentTime;
            const liveDur = audioRef.current?.duration || snap.duration;
            persistPlaybackPosition(
              snap.briefingId,
              snap.segmentIndex,
              liveTime,
              liveDur,
              snap.playbackRate,
              true
            );
          }

          setSleepTimerMode('off');
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timerId);
  }, [sleepTimerMode, persistPlaybackPosition]);

  // Seamless chapter-to-chapter auto-advance (respecting End-of-Chapter sleep timer)
  const handleAudioEnded = useCallback(() => {
    if (!activeBriefing) {
      setIsPlaying(false);
      return;
    }

    if (sleepTimerMode === 'end-of-chapter') {
      setSleepTimerMode('off');
      setSleepTimerRemainingSec(null);
      setIsPlaying(false);

      // Bookmark the start of the next chapter if available so Resume picks up cleanly
      for (let i = activeSegmentIndex + 1; i < activeBriefing.segments.length; i++) {
        if (activeBriefing.segments[i].audioBase64) {
          loadAndPlaySegment(activeBriefing, i, false, 0);
          persistPlaybackPosition(
            activeBriefing.id,
            i,
            0,
            activeBriefing.segments[i].audioDurationSeconds ?? 0,
            playbackRate,
            true
          );
          return;
        }
      }
      setCurrentTime(0);
      persistPlaybackPosition(activeBriefing.id, 0, 0, 0, playbackRate, true, true);
      return;
    }

    for (let i = activeSegmentIndex + 1; i < activeBriefing.segments.length; i++) {
      if (activeBriefing.segments[i].audioBase64) {
        loadAndPlaySegment(activeBriefing, i, true, 0);
        persistPlaybackPosition(
          activeBriefing.id,
          i,
          0,
          activeBriefing.segments[i].audioDurationSeconds ?? 0,
          playbackRate,
          true
        );
        return;
      }
    }
    // Finished final chapter — record 100% completion while resetting bookmark to start cleanly next time
    setIsPlaying(false);
    setCurrentTime(0);
    persistPlaybackPosition(activeBriefing.id, 0, 0, 0, playbackRate, true, true);
  }, [
    activeBriefing,
    activeSegmentIndex,
    loadAndPlaySegment,
    persistPlaybackPosition,
    playbackRate,
    sleepTimerMode,
  ]);

  // Build stitched WAV Blob from recorded briefing chapters
  const handleBuildStitchedWavBlob = useCallback((): Blob | null => {
    if (!activeBriefing) return null;
    const clips = activeBriefing.segments
      .map((s) => s.audioBase64)
      .filter((b): b is string => Boolean(b));
    if (clips.length === 0) return null;
    return stitchWavBase64Clips(clips);
  }, [activeBriefing]);

  // Download full stitched WAV episode
  const handleDownloadFullWav = useCallback(() => {
    if (!activeBriefing) return;
    const wavBlob = handleBuildStitchedWavBlob();
    if (!wavBlob) return;

    const safeSlug = activeBriefing.editionTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);

    const url = URL.createObjectURL(wavBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dispatch-${safeSlug || 'briefing'}.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, [activeBriefing, handleBuildStitchedWavBlob]);

  // Persist exported Google Doc / WAV metadata onto briefing & Firestore workspaceLinks
  const handleExportedBriefingAsset = useCallback(
    ({
      briefingId,
      kind,
      driveItem,
    }: {
      briefingId: string;
      kind: 'doc' | 'wav';
      driveItem: DriveFileItem;
    }) => {
      const target =
        (activeBriefing?.id === briefingId ? activeBriefing : null) ||
        archive.find((b) => b.id === briefingId);

      if (target) {
        const updated: AudioBriefing =
          kind === 'doc'
            ? {
                ...target,
                exportedDocId: driveItem.id,
                exportedDocUrl: driveItem.webViewLink || target.exportedDocUrl,
              }
            : {
                ...target,
                exportedWavFileId: driveItem.id,
                exportedWavUrl: driveItem.webViewLink || target.exportedWavUrl,
              };
        commitBriefingUpdate(updated);
      }

      if (verifiedOwnerId) {
        void upsertWorkspaceLinkToFirestore(verifiedOwnerId, {
          kind: kind === 'doc' ? 'google_doc_export' : 'drive_wav_export',
          externalId: driveItem.id,
          title: driveItem.name,
          url: driveItem.webViewLink,
          briefingId,
        });
      }

      showTransferToast({
        target: 'notebook',
        title:
          kind === 'doc'
            ? 'Saved Formatted Google Doc'
            : 'Saved WAV Episode to Google Drive',
        description:
          kind === 'doc'
            ? 'Created structured Google Doc in Drive and linked to this edition.'
            : 'Uploaded stitched WAV episode to Drive and linked to this edition.',
        label: driveItem.name,
      });
    },
    [activeBriefing, archive, commitBriefingUpdate, showTransferToast, verifiedOwnerId]
  );

  // Record created Google Tasks against briefing & Firestore workspaceLinks
  const handleTasksCreatedFromBriefing = useCallback(
    (createdTasks: GoogleTaskItem[], briefingId?: string) => {
      if (createdTasks.length === 0) return;

      if (briefingId) {
        const target =
          (activeBriefing?.id === briefingId ? activeBriefing : null) ||
          archive.find((b) => b.id === briefingId);
        if (target) {
          const updated: AudioBriefing = {
            ...target,
            syncedTaskCount: (target.syncedTaskCount ?? 0) + createdTasks.length,
          };
          commitBriefingUpdate(updated);
        }
      }

      if (verifiedOwnerId) {
        for (const task of createdTasks) {
          void upsertWorkspaceLinkToFirestore(verifiedOwnerId, {
            kind: 'google_task',
            externalId: task.id,
            title: task.title,
            url: task.webViewLink || 'https://tasks.google.com',
            briefingId,
          });
        }
      }

      showTransferToast({
        target: 'notebook',
        title:
          createdTasks.length === 1
            ? 'Added Takeaway to Google Tasks'
            : `Added ${createdTasks.length} Takeaways to Google Tasks`,
        description: 'Synced follow-up items with cited briefing notes to Google Tasks.',
        label: createdTasks[0].title,
      });
    },
    [activeBriefing, archive, commitBriefingUpdate, showTransferToast, verifiedOwnerId]
  );

  // Multi-turn Editor Chat handlers
  const handleSendChatMessage = useCallback(
    async (text: string) => {
      setChatError(null);
      const userMsg: ChatMessage = {
        id: `msg-u-${Date.now()}`,
        role: 'user',
        text,
        timestamp: new Date().toISOString(),
      };

      const nextHistory = [...chatMessages, userMsg];
      setChatMessages(nextHistory);
      setIsChatSending(true);

      try {
        const activeNotebook = articles.filter((a) => !a.readLater);
        const selectedArticles = activeNotebook
          .filter((a) => a.selected)
          .map(ensureArticlePassages);
        const contextSources =
          selectedArticles.length > 0
            ? selectedArticles
            : activeNotebook.map(ensureArticlePassages);

        const { reply, citations } = await sendEditorChatMessage({
          messages: nextHistory.map((m) => ({ role: m.role, text: m.text })),
          articles: contextSources,
          briefingTitle: activeBriefing?.editionTitle,
          briefingTakeaways: activeBriefing?.takeaways,
        });

        const modelMsg: ChatMessage = {
          id: `msg-m-${Date.now()}`,
          role: 'model',
          text: reply,
          citations,
          timestamp: new Date().toISOString(),
        };
        setChatMessages((prev) => [...prev, modelMsg]);
      } catch (err) {
        setChatError(
          err instanceof Error ? err.message : 'Editor could not respond right now.'
        );
      } finally {
        setIsChatSending(false);
      }
    },
    [articles, activeBriefing, chatMessages]
  );

  // Read-aloud an Editor Chat answer with gemini-3.8-flash-tts
  const handleSpeakChatMessage = useCallback(
    async (message: ChatMessage) => {
      setChatError(null);
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
        setIsPlaying(false);
      }
      stopChatAudio();

      try {
        let base64 = message.audioBase64;
        if (!base64) {
          setSpeakingMessageId(message.id);
          const res = await synthesizeSpeech({
            format: 'solo',
            text: message.text,
            voiceName: preferences.voiceName,
            tone: 'conversational',
            voiceTone: preferences.voiceTone || 'professional',
          });
          base64 = res.audioBase64;
          setChatMessages((prev) =>
            prev.map((m) => (m.id === message.id ? { ...m, audioBase64: base64 } : m))
          );
          setSpeakingMessageId(null);
        }

        if (chatAudioUrlRef.current) {
          URL.revokeObjectURL(chatAudioUrlRef.current);
        }
        const url = base64WavToObjectUrl(base64);
        chatAudioUrlRef.current = url;

        const el = chatAudioRef.current;
        if (!el) return;
        el.src = url;
        el.playbackRate = playbackRate;
        await el.play();
        setPlayingMessageId(message.id);
      } catch (err) {
        setSpeakingMessageId(null);
        setChatError(
          err instanceof Error ? err.message : 'Could not synthesize audio for reply.'
        );
      }
    },
    [playbackRate, preferences.voiceName, preferences.voiceTone, stopChatAudio]
  );

  // Archive handlers (with IndexedDB audio hydration and bookmark restoration)
  const handleOpenArchivedBriefing = useCallback(
    (item: AudioBriefing) => {
      if (audioRef.current) {
        if (activeBriefing && !audioRef.current.paused) {
          persistPlaybackPosition(
            activeBriefing.id,
            activeSegmentIndex,
            audioRef.current.currentTime,
            audioRef.current.duration || duration,
            playbackRate,
            true
          );
        }
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
        audioRef.current.load();
      }
      setIsPlaying(false);

      const savedPos = playbackPositions[item.id];
      const safeIdx = savedPos
        ? Math.max(0, Math.min(savedPos.segmentIndex, item.segments.length - 1))
        : 0;
      const savedTime = savedPos?.currentTime ?? 0;

      setActiveBriefing(item);
      setActiveSegmentIndex(safeIdx);
      setCurrentTime(savedTime);
      setDuration(savedPos?.duration ?? 0);
      if (savedPos?.playbackRate) {
        setPlaybackRate(savedPos.playbackRate);
      }
      setActiveView('briefing');

      loadBriefingAudio(item.id).then((audioMap) => {
        if (Object.keys(audioMap).length === 0) return;

        const hydrated: AudioBriefing = {
          ...item,
          segments: item.segments.map((seg) => {
            const cached = audioMap[seg.id];
            if (!cached) return seg;
            const exactSeconds = getWavDurationSeconds(cached);
            return {
              ...seg,
              audioBase64: cached,
              audioDurationSeconds:
                exactSeconds > 0 ? exactSeconds : seg.audioDurationSeconds,
              audioStale: false,
            };
          }),
        };

        setActiveBriefing(hydrated);
        if (hydrated.segments[safeIdx]?.audioBase64) {
          loadAndPlaySegment(hydrated, safeIdx, false, savedTime);
        } else {
          const firstReady = hydrated.segments.findIndex((s) => Boolean(s.audioBase64));
          if (firstReady >= 0) {
            loadAndPlaySegment(hydrated, firstReady, false, 0);
          }
        }
      });
    },
    [
      activeBriefing,
      activeSegmentIndex,
      duration,
      loadAndPlaySegment,
      persistPlaybackPosition,
      playbackPositions,
      playbackRate,
    ]
  );

  const handleDeleteArchivedBriefing = useCallback(
    (id: string) => {
      setArchive((prev) => prev.filter((b) => b.id !== id));
      deleteBriefingAudio(id);
      setPlaybackPositions((prev) => {
        const next = { ...prev };
        delete next[id];
        try {
          localStorage.setItem(STORAGE_PLAYBACK_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage quota errors
        }
        return next;
      });
      if (activeBriefing?.id === id) {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.removeAttribute('src');
        }
        setActiveBriefing(null);
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
      }
      if (verifiedOwnerId) {
        void deleteBriefingArchiveFromFirestore(verifiedOwnerId, id);
      }
    },
    [activeBriefing, verifiedOwnerId]
  );

  const hasReadyAudio = Boolean(
    activeBriefing?.segments.some((s) => Boolean(s.audioBase64))
  );

  const handleTopBarPrimaryAction = useCallback(() => {
    if (hasReadyAudio) {
      setCommuteModeOpen(true);
    } else if (activeBriefing) {
      setActiveView('briefing');
      synthesizeAllChapters(activeBriefing, true).catch(() => {});
    } else {
      handleBuildBriefing(true);
    }
  }, [hasReadyAudio, activeBriefing, synthesizeAllChapters, handleBuildBriefing]);

  const handleSendImageToMockup = useCallback(
    async (imageDataUrl: string, label: string) => {
      let safeDataUrl = imageDataUrl;
      let width: number | undefined;
      let height: number | undefined;
      let sizeKb = estimateDataUrlKb(imageDataUrl);

      try {
        if (sizeKb > 220 || imageDataUrl.length > 280_000) {
          const compressed = await compressDataUrl(imageDataUrl, {
            maxWidth: 1440,
            maxHeight: 1080,
            quality: 0.84,
            maxSizeKb: 220,
          });
          safeDataUrl = compressed.dataUrl;
          width = compressed.width;
          height = compressed.height;
          sizeKb = compressed.sizeKb;
        }
      } catch {
        // Fallback to original dataUrl if canvas compression is unavailable
      }

      try {
        const raw = localStorage.getItem('dispatch_site_mockup_v1');
        const current: SiteMockupProject = raw
          ? (JSON.parse(raw) as SiteMockupProject)
          : createStarterMockup();
        const nextMedia = [
          {
            id: `media-${Date.now()}`,
            label: label || 'AI Studio Visual',
            category: 'hero' as const,
            dataUrl: safeDataUrl,
            width,
            height,
            sizeKb,
            addedAt: new Date().toISOString(),
          },
          ...(current.mediaCollection || []),
        ].slice(0, 24);
        const updated: SiteMockupProject = {
          ...current,
          updatedAt: new Date().toISOString(),
          hero: {
            ...current.hero,
            photoDataUrl: safeDataUrl,
          },
          mediaCollection: nextMedia,
        };
        localStorage.setItem('dispatch_site_mockup_v1', JSON.stringify(updated));
      } catch {
        // Non-fatal storage write
      }
      setActiveView('mockup');
      showTransferToast({
        target: 'mockup',
        title: 'Sent to Site Mockup',
        description: 'Applied to the hero banner and queued for Firestore sync.',
        label: label || 'AI Studio Visual',
        thumbnailDataUrl: safeDataUrl,
      });
    },
    [showTransferToast]
  );

  const handleSendLocationToMockup = useCallback(
    (serviceArea: string, address: string) => {
      try {
        const raw = localStorage.getItem('dispatch_site_mockup_v1');
        const current: SiteMockupProject = raw
          ? (JSON.parse(raw) as SiteMockupProject)
          : createStarterMockup();
        const updated: SiteMockupProject = {
          ...current,
          updatedAt: new Date().toISOString(),
          brand: {
            ...current.brand,
            serviceArea: serviceArea || current.brand.serviceArea,
            address: address || current.brand.address,
          },
        };
        localStorage.setItem('dispatch_site_mockup_v1', JSON.stringify(updated));
      } catch {
        // Non-fatal storage write
      }
      setActiveView('mockup');
      showTransferToast({
        target: 'mockup',
        title: 'Location Sent to Site Mockup',
        description: 'Updated brand service area and address in Site Mockup.',
        label: serviceArea || address || 'Mapped Location',
      });
    },
    [showTransferToast]
  );

  const handleSendImageTo3DStage = useCallback(
    (imageDataUrl: string, label: string) => {
      const resolvedLabel = label || 'Media Lab Visual';
      setStagedImageFor3D({
        dataUrl: imageDataUrl,
        label: resolvedLabel,
      });
      setStaged3DPayload({
        id: `img3d-${Date.now()}`,
        rigMode: 'pavilion',
        activeSlot: 0,
        sourceStudio: 'Media Lab',
        slots: {
          0: {
            kind: 'image',
            src: imageDataUrl,
            label: resolvedLabel,
            aspectRatio: 16 / 9,
          },
        },
      });
      setActiveView('spatial');
      showTransferToast({
        target: 'spatial3d',
        title: 'Sent to 3D Stage',
        description: 'Projected onto the Spatial & Maps Hub Showcase Screen.',
        label: resolvedLabel,
        thumbnailDataUrl: imageDataUrl,
      });
    },
    [showTransferToast]
  );

  const handleSendVideoTo3DStage = useCallback(
    (videoUrl: string, label: string, aspectRatio?: string) => {
      const resolvedLabel = label || 'Media Lab Video Plate';
      const numericAspect = aspectRatio === '9:16' ? 9 / 16 : 16 / 9;
      const isVertical = aspectRatio === '9:16';
      setStaged3DPayload({
        id: `vid3d-${Date.now()}`,
        rigMode: isVertical ? 'devices' : 'pavilion',
        activeSlot: isVertical ? 1 : 0,
        sourceStudio: 'Media Lab Video',
        slots: isVertical
          ? {
              1: {
                kind: 'video',
                src: videoUrl,
                label: `${resolvedLabel} (9:16)`,
                aspectRatio: numericAspect,
              },
            }
          : {
              0: {
                kind: 'video',
                src: videoUrl,
                label: `${resolvedLabel} (Live Video)`,
                aspectRatio: numericAspect,
              },
            },
      });
      setActiveView('spatial');
      showTransferToast({
        target: 'spatial3d',
        title: 'Wrapped Video on 3D Stage',
        description: isVertical
          ? 'Streaming live 9:16 VideoTexture onto the 3D Smartphone OLED screen.'
          : 'Streaming live 60fps VideoTexture onto the 3D Broadcast Pavilion screen.',
        label: resolvedLabel,
      });
    },
    [showTransferToast]
  );

  const handlePreviewMockupIn3DDevices = useCallback(
    async (project: SiteMockupProject) => {
      const screens = await renderMockupDeviceScreens(project);
      const brandLabel = project.brand.name || 'Client Website';
      setStaged3DPayload({
        id: `mockup3d-${Date.now()}`,
        rigMode: 'devices',
        activeSlot: 0,
        sourceStudio: 'Site Mockup',
        slots: {
          0: {
            kind: 'mockupPreview',
            src: screens.desktopDataUrl,
            label: `${brandLabel} Desktop`,
            aspectRatio: 16 / 10,
          },
          1: {
            kind: 'mockupPreview',
            src: screens.mobileDataUrl,
            label: `${brandLabel} Mobile`,
            aspectRatio: 9 / 19.5,
          },
          2: {
            kind: 'mockupPreview',
            src: screens.plaqueDataUrl,
            label: `${brandLabel} Spec Plaque`,
            aspectRatio: 4,
          },
        },
      });
      setActiveView('spatial');
      showTransferToast({
        target: 'spatial3d',
        title: 'Projected onto 3D Device Rig',
        description:
          'Mapped live Desktop + Mobile layouts onto the 3D Laptop & Phone Showcase.',
        label: brandLabel,
        thumbnailDataUrl: screens.desktopDataUrl,
      });
    },
    [showTransferToast]
  );

  const handleProjectArticleTo3DFoil = useCallback(
    (article: NewsArticle) => {
      const cards = renderEditorialFoilCard({ kind: 'article', article });
      setStaged3DPayload({
        id: `art3d-${Date.now()}`,
        rigMode: 'foilCard',
        activeSlot: 0,
        sourceStudio: 'Studio Desk',
        slots: {
          0: {
            kind: 'editorialCard',
            src: cards.frontDataUrl,
            label: 'Front Collector Poster',
            aspectRatio: 3 / 4,
          },
          1: {
            kind: 'editorialCard',
            src: cards.backDataUrl,
            label: 'Rear Provenance Plate',
            aspectRatio: 3 / 4,
          },
          2: {
            kind: 'editorialCard',
            src: cards.plaqueDataUrl,
            label: 'Plinth Edition Plaque',
            aspectRatio: 4,
          },
        },
      });
      setActiveView('spatial');
      showTransferToast({
        target: 'spatial3d',
        title: 'Staged on 3D Holographic Foil Card',
        description:
          'Projected article front & provenance plates onto the iridescent 3D collector slab.',
        label: article.title,
        thumbnailDataUrl: cards.frontDataUrl,
      });
    },
    [showTransferToast]
  );

  const handleProjectBriefingTo3DFoil = useCallback(
    (briefingObj: AudioBriefing) => {
      const cards = renderEditorialFoilCard({
        kind: 'briefing',
        briefing: briefingObj,
      });
      setStaged3DPayload({
        id: `brief3d-${Date.now()}`,
        rigMode: 'foilCard',
        activeSlot: 0,
        sourceStudio: 'Audio Briefing',
        slots: {
          0: {
            kind: 'editorialCard',
            src: cards.frontDataUrl,
            label: 'Edition Foil Cover',
            aspectRatio: 3 / 4,
          },
          1: {
            kind: 'editorialCard',
            src: cards.backDataUrl,
            label: 'Chapter Provenance Plate',
            aspectRatio: 3 / 4,
          },
          2: {
            kind: 'editorialCard',
            src: cards.plaqueDataUrl,
            label: 'Broadcast Plinth Plaque',
            aspectRatio: 4,
          },
        },
      });
      setActiveView('spatial');
      showTransferToast({
        target: 'spatial3d',
        title: 'Briefing Staged on 3D Foil Slab',
        description:
          'Projected edition takeaways onto the iridescent 3D Holographic Foil Card.',
        label: briefingObj.editionTitle,
        thumbnailDataUrl: cards.frontDataUrl,
      });
    },
    [showTransferToast]
  );

  const handleSave3DRenderToClientPitch = useCallback(
    async (imageDataUrl: string, label: string) => {
      let safeDataUrl = imageDataUrl;
      let width: number | undefined;
      let height: number | undefined;
      let sizeKb = estimateDataUrlKb(imageDataUrl);

      try {
        if (sizeKb > 220 || imageDataUrl.length > 280_000) {
          const compressed = await compressDataUrl(imageDataUrl, {
            maxWidth: 1440,
            maxHeight: 1080,
            quality: 0.86,
            maxSizeKb: 220,
          });
          safeDataUrl = compressed.dataUrl;
          width = compressed.width;
          height = compressed.height;
          sizeKb = compressed.sizeKb;
        }
      } catch {
        // Keep original dataUrl if canvas compression is skipped
      }

      const cleanLabel = `3D Stage: ${label || 'Showcase Render'}`;
      try {
        const raw = localStorage.getItem('dispatch_site_mockup_v1');
        const current: SiteMockupProject = raw
          ? (JSON.parse(raw) as SiteMockupProject)
          : createStarterMockup();
        const filteredExisting = (current.mediaCollection || []).filter(
          (item) => !item.id.startsWith('render3d-')
        );
        const nextMedia = [
          {
            id: `render3d-${Date.now()}`,
            label: cleanLabel,
            category: 'project' as const,
            dataUrl: safeDataUrl,
            width,
            height,
            sizeKb,
            addedAt: new Date().toISOString(),
          },
          ...filteredExisting,
        ].slice(0, 24);
        const updated: SiteMockupProject = {
          ...current,
          updatedAt: new Date().toISOString(),
          mediaCollection: nextMedia,
        };
        localStorage.setItem('dispatch_site_mockup_v1', JSON.stringify(updated));
      } catch {
        // Non-fatal storage write
      }

      showTransferToast({
        target: 'mockup',
        title: '3D Render Saved to Client Pitch',
        description:
          'Attached to Site Mockup assets and ready inside your single-page Client Pitch PDF.',
        label: cleanLabel,
        thumbnailDataUrl: safeDataUrl,
        actionLabel: 'Open Client Pitch PDF',
        onAction: () => {
          setAutoOpenPitchSheet(true);
          setActiveView('mockup');
          dismissTransferToast();
        },
      });
    },
    [showTransferToast, dismissTransferToast]
  );

  const handleSendImageToVideoStage = useCallback(
    (payload: MediaImageTransferPayload) => {
      setStagedImageForVideoStage(payload);
      if (payload.source !== 'upload') {
        showTransferToast({
          target: 'videoStage',
          title: 'Sent to Video Stage',
          description: 'Loaded as the starting frame in Video Studio.',
          label: payload.label || 'Generated Studio Frame',
          thumbnailDataUrl: payload.dataUrl,
        });
      }
    },
    [showTransferToast]
  );

  const handleSendTranscriptToSources = useCallback(
    (rawTitle: string, transcriptText: string) => {
      const trimmed = transcriptText.trim();
      if (!trimmed) return;

      const cleanTitle = (rawTitle || 'Audio Transcript').trim().slice(0, 120);
      const sentences = trimmed
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 16);

      const summary = (sentences.slice(0, 2).join(' ') || trimmed).slice(0, 220);
      const keyFacts =
        sentences.length > 0
          ? sentences.slice(0, 3).map((s) => s.slice(0, 180))
          : [trimmed.slice(0, 180)];
      const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
      const estimatedReadMinutes = Math.max(1, Math.round(wordCount / 200));

      const newSource = ensureArticlePassages({
        id: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: cleanTitle,
        source: 'AI Desk Transcript',
        sourceType: 'txt',
        category: 'Transcript',
        summary,
        keyFacts,
        content: trimmed,
        estimatedReadMinutes,
        selected: true,
        addedAt: new Date().toISOString(),
      });

      setArticles((prev) => [newSource, ...prev]);
      if (verifiedOwnerId) {
        void upsertNotebookSourceToFirestore(verifiedOwnerId, newSource);
      }
      showTransferToast({
        target: 'notebook',
        title: 'Added to Newsroom Sources',
        description: 'Indexed into passages and selected for your next Audio Briefing.',
        label: cleanTitle,
        actionLabel: 'Open in Newsroom',
        onAction: () => {
          setActiveView('articles');
          dismissTransferToast();
        },
      });
    },
    [showTransferToast, dismissTransferToast, verifiedOwnerId]
  );

  const [isSpatialImmersive, setIsSpatialImmersive] = useState(() =>
    isSpatialDisplayUrl()
  );

  useEffect(() => {
    if (activeView !== 'spatial') {
      setIsSpatialImmersive(false);
    }
  }, [activeView]);

  const hideChromeForSpatialImmersive =
    activeView === 'spatial' && isSpatialImmersive;

  const isNewsroomView =
    activeView === 'articles' || activeView === 'briefing' || activeView === 'archive';
  const showSourcesSidebar = isNewsroomView;
  const newsroomCtaLabel = hasReadyAudio
    ? 'Commute Mode'
    : activeBriefing
      ? 'Record Audio'
      : 'Build Briefing';

  const activeSources = articles.filter((a) => !a.readLater);
  const readLaterSources = articles.filter((a) => Boolean(a.readLater));
  const selectedSourceCount = activeSources.filter((a) => a.selected).length;

  if (sharedRouteId) {
    return (
      <SharedBriefingView
        shareId={sharedRouteId}
        onExitSharedView={handleExitSharedView}
      />
    );
  }

  if (sharedMockupRouteId) {
    return (
      <SharedMockupView
        shareId={sharedMockupRouteId}
        onExit={() => {
          handleExitSharedView();
          setActiveView('mockup');
        }}
      />
    );
  }

  return (
    <div
      className={`min-h-screen bg-[#0B0D10] text-[#F5F7FA] ${
        hideChromeForSpatialImmersive
          ? 'h-screen overflow-hidden'
          : hasReadyAudio
            ? 'pb-24'
            : 'pb-12'
      }`}
    >
      {!hideChromeForSpatialImmersive && (
        <TopBar
          activeView={activeView}
          onSelectView={setActiveView}
          onOpenGoogleDrive={() => {
            setDriveModalTab(activeView === 'briefing' ? 'export' : 'browse');
            setDriveModalOpen(true);
          }}
          onOpenGoogleTasks={() => {
            setStagedTaskIndices(null);
            setTasksDrawerOpen(true);
          }}
        />
      )}

      {/* Google Maps Platform Demo Key Quota Banner (Section 8 Case A) */}
      {gmpQuotaExceeded && (
        <div
          role="alert"
          className="sticky top-0 z-50 flex items-center justify-between gap-3 flex-wrap bg-amber-50 border-b border-amber-300 px-4 py-2.5 text-sm text-amber-950"
        >
          <span>
            <strong>Google Maps Platform free demo limit reached</strong> — this demo key is shared across the session and has run out of quota. Switch to your own Google Cloud project API key (free tier available) to restore map, search, and routing features.
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(GMP_SETUP_URL);
                  setGmpLinkCopied(true);
                  window.setTimeout(() => setGmpLinkCopied(false), 2200);
                } catch {
                  // Ignore clipboard restrictions
                }
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-200/70 hover:bg-amber-200 text-xs font-medium cursor-pointer"
            >
              {gmpLinkCopied ? (
                <>
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  Copied URL
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  Copy Setup Link
                </>
              )}
            </button>
            <a
              href={GMP_SETUP_URL}
              target="_blank"
              rel="noreferrer"
              className="underline font-medium text-xs"
            >
              Get a free key
            </a>
            <button
              type="button"
              onClick={() => setGmpQuotaExceeded(false)}
              aria-label="Dismiss"
              className="px-2 py-0.5 rounded hover:bg-amber-200 cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Newsroom Sub-Navigation Bar (Sources | Briefing | Archive + Briefing Action) */}
      {isNewsroomView && (
        <div className="bg-[#0E1116] border-b border-[#22D3EE]/20 px-5 sm:px-7 py-2.5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 overflow-x-auto">
            {(
              [
                { id: 'articles', label: 'Studio Desk' },
                { id: 'briefing', label: 'Audio Briefing' },
                { id: 'archive', label: `Archive (${archive.length})` },
              ] as const
            ).map((tab) => {
              const active = activeView === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveView(tab.id)}
                  className={`h-9 px-3.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#22D3EE]/15 text-[#67E8F9] border border-[#22D3EE]/45'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {verifiedOwnerId && (
              <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-mono text-[#8C96A8] tabular-nums whitespace-nowrap mr-1">
                <span className="text-[#67E8F9]">
                  {cloudSyncStatus === 'syncing' ? 'Syncing...' : 'Cloud Synced'}
                </span>
                {workspaceLinks.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{workspaceLinks.length} linked</span>
                  </>
                )}
              </span>
            )}

            <button
              type="button"
              onClick={() => {
                setDriveModalTab(activeView === 'briefing' ? 'export' : 'browse');
                setDriveModalOpen(true);
              }}
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#E4E9F1] hover:text-[#67E8F9] bg-[#13161C] hover:bg-[#19202B] border border-[#273040] hover:border-[#22D3EE]/55 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <HardDrive className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Drive &amp; Docs
            </button>

            <button
              type="button"
              onClick={() => {
                setStagedTaskIndices(null);
                setTasksDrawerOpen(true);
              }}
              className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#E4E9F1] hover:text-[#67E8F9] bg-[#13161C] hover:bg-[#19202B] border border-[#273040] hover:border-[#22D3EE]/55 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ListChecks className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Google Tasks
            </button>

            <button
              type="button"
              disabled={isGenerating || isSynthesizingAll}
              onClick={handleTopBarPrimaryAction}
              className="h-9 px-3.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {newsroomCtaLabel}
            </button>
          </div>
        </div>
      )}

      {/* Mobile Sources Strip (< lg) — shown only in Newsroom views */}
      {showSourcesSidebar && (
        <div className="lg:hidden px-4 py-2.5 bg-[#0E1116] border-b border-[#22D3EE]/20 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setMobileSourcesOpen(true)}
            className="h-9 px-3 inline-flex items-center gap-2 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/40 rounded-md cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Sources ({selectedSourceCount}/{activeSources.length}
            {readLaterSources.length > 0 ? ` · ${readLaterSources.length} saved` : ''})
          </button>
          <button
            type="button"
            onClick={() => handleOpenAddModal('upload')}
            className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] rounded-md cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            Add source
          </button>
        </div>
      )}

      {/* Persistent 2-Pane Newsroom Workspace (full-width canvas for AI Desk, Media Lab, Site Mockup, Spatial & Map) */}
      <div className="flex items-start min-h-[calc(100vh-4rem)]">
        {showSourcesSidebar && (
          <SourcesSidebar
            sources={articles}
            inspectedSourceId={inspectedTarget?.sourceId ?? null}
            isUploading={isIngesting}
            uploadStatus={uploadStatus}
            isTagging={isTagging}
            isRefreshingArticles={isRefreshingArticles}
            refreshArticlesStatus={refreshArticlesStatus}
            mobileOpen={mobileSourcesOpen}
            onCloseMobile={() => setMobileSourcesOpen(false)}
            onOpenAddModal={handleOpenAddModal}
            onDropFiles={async (files) => {
              await handleUploadFiles(files);
            }}
            onToggleSource={handleToggleArticle}
            onToggleAll={handleToggleAll}
            onToggleReadLater={handleToggleReadLater}
            onRestoreAllReadLater={handleRestoreAllReadLater}
            onInspectSource={handleInspectSource}
            onRemoveSource={handleRemoveArticle}
            onResetSamples={handleResetSamples}
            onAutoTagSources={handleAutoTagSources}
            onRefreshAllArticles={handleRefreshAllArticles}
          />
        )}

        <main className="flex-1 min-w-0">
          {activeView === 'articles' && (
            <FirestoreErrorBoundary
              resetKey={activeView}
              title="Newsroom Desk encountered a workspace error"
            >
              <ArticleDeskView
                articles={activeSources}
                readLaterArticles={readLaterSources}
                preferences={preferences}
                onPreferencesChange={handlePreferencesChange}
                onOpenAddModal={handleOpenAddModal}
                onInspectSource={handleInspectSource}
                onToggleArticle={handleToggleArticle}
                onToggleAll={handleToggleAll}
                onBulkToggleCategory={handleBulkToggleCategory}
                onToggleReadLater={handleToggleReadLater}
                onRestoreAllReadLater={handleRestoreAllReadLater}
                onRemoveArticle={handleRemoveArticle}
                onResetSamples={handleResetSamples}
                onRefreshAllArticles={handleRefreshAllArticles}
                isRefreshingArticles={isRefreshingArticles}
                refreshArticlesStatus={refreshArticlesStatus}
                refreshArticlesError={refreshArticlesError}
                onDismissRefreshError={() => setRefreshArticlesError(null)}
                onBuildBriefing={handleBuildBriefing}
                isGenerating={isGenerating || isSynthesizingAll}
                generationStatus={generationStatus}
                generationError={generationError}
                onProjectArticleTo3D={handleProjectArticleTo3DFoil}
              />
            </FirestoreErrorBoundary>
          )}

          {activeView === 'briefing' && (
            <FirestoreErrorBoundary
              resetKey={activeView}
              title="Audio Briefing Studio encountered a workspace error"
            >
              <BriefingStudioView
                briefing={activeBriefing}
                sources={articles}
                activeSegmentIndex={activeSegmentIndex}
                currentTime={currentTime}
                isPlaying={isPlaying}
                synthesizingSegmentId={synthesizingSegmentId}
                isSynthesizingAll={isSynthesizingAll}
                isRefining={isRefining}
                refineError={refineError}
                ttsError={ttsError}
                onGoToArticles={() => setActiveView('articles')}
                onPlaySegment={handlePlaySegment}
                onTogglePlayPause={handleTogglePlayPause}
                onRestartBriefing={handleRestartBriefing}
                onSynthesizeSegment={async (segmentId) => {
                  if (!activeBriefing) return;
                  try {
                    const updated = await synthesizeOneSegment(activeBriefing, segmentId);
                    const idx = updated.segments.findIndex((s) => s.id === segmentId);
                    if (idx >= 0) {
                      loadAndPlaySegment(updated, idx, false);
                    }
                  } catch (err) {
                    setTtsError(
                      err instanceof Error ? err.message : 'Failed to record chapter.'
                    );
                  }
                }}
                onSynthesizeAll={async () => {
                  if (!activeBriefing) return;
                  await synthesizeAllChapters(activeBriefing, true).catch(() => {});
                }}
                onUpdateSegmentLines={handleUpdateSegmentLines}
                onUpdateSegmentCoHostVoice={handleUpdateSegmentCoHostVoice}
                onRefineScript={handleRefineScript}
                onSelectCitation={handleSelectCitation}
                onDownloadFullWav={handleDownloadFullWav}
                onOpenCommuteMode={() => setCommuteModeOpen(true)}
                onPreviewShare={handleOpenSharedPreview}
                onProjectBriefingTo3D={handleProjectBriefingTo3DFoil}
                onOpenDriveExport={() => {
                  setDriveModalTab('export');
                  setDriveModalOpen(true);
                }}
                onSendTakeawaysToTasks={(indices) => {
                  setStagedTaskIndices(indices ?? []);
                  setTasksDrawerOpen(true);
                }}
              />
            </FirestoreErrorBoundary>
          )}

          {activeView === 'chat' && (
            <FirestoreErrorBoundary
              resetKey={activeView}
              title="AI Desk encountered a workspace error"
            >
              <AiDeskView
                editorMessages={chatMessages}
                articles={activeSources}
                briefing={activeBriefing}
                isEditorSending={isChatSending}
                editorError={chatError}
                speakingMessageId={speakingMessageId}
                playingMessageId={playingMessageId}
                onSendEditorMessage={handleSendChatMessage}
                onClearEditorChat={() => {
                  stopChatAudio();
                  setChatMessages([]);
                  setChatError(null);
                }}
                onSpeakEditorMessage={handleSpeakChatMessage}
                onStopSpeakingEditorMessage={stopChatAudio}
                onSelectCitation={handleSelectCitation}
                onSendTranscriptToSources={handleSendTranscriptToSources}
              />
            </FirestoreErrorBoundary>
          )}

          {activeView === 'media' && (
            <FirestoreErrorBoundary
              resetKey={activeView}
              title="Media Lab encountered a workspace error"
            >
              <MediaLabView
                onSendImageToMockup={(dataUrl, label) => {
                  void handleSendImageToMockup(dataUrl, label);
                }}
                onSendImageTo3DStage={handleSendImageTo3DStage}
                onSendVideoTo3DStage={handleSendVideoTo3DStage}
                stagedVideoImage={stagedImageForVideoStage}
                onSendImageToVideoStage={handleSendImageToVideoStage}
                onClearStagedVideoImage={() => setStagedImageForVideoStage(null)}
                persistedSessionImages={mediaSessionImages}
                activeSessionImageId={activeMediaImageId}
                onSessionImagesChange={setMediaSessionImages}
                onActiveSessionImageChange={setActiveMediaImageId}
              />
            </FirestoreErrorBoundary>
          )}

          {activeView === 'archive' && (
            <FirestoreErrorBoundary
              resetKey={activeView}
              title="Archive encountered a workspace error"
            >
              <ArchiveView
                archive={archive}
                activeBriefingId={activeBriefing?.id ?? null}
                playbackPositions={playbackPositions}
                rssFeedConfig={rssFeedConfig}
                isRssAutoSyncing={isRssAutoSyncing}
                onRssFeedConfigChange={handleRssFeedConfigChange}
                onOpenBriefing={handleOpenArchivedBriefing}
                onDeleteBriefing={handleDeleteArchivedBriefing}
                onGoToArticles={() => setActiveView('articles')}
              />
            </FirestoreErrorBoundary>
          )}

          {activeView === 'mockup' && (
            <FirestoreErrorBoundary
              resetKey={activeView}
              title="Site Mockup encountered a workspace error"
            >
              <SiteMockupView
                onOpenSharedMockup={handleOpenSharedMockup}
                onPreviewIn3DDevices={(project) => {
                  void handlePreviewMockupIn3DDevices(project);
                }}
                autoOpenPitchSheet={autoOpenPitchSheet}
                onAutoOpenPitchSheetHandled={() => setAutoOpenPitchSheet(false)}
              />
            </FirestoreErrorBoundary>
          )}

          {activeView === 'spatial' && (
            <FirestoreErrorBoundary
              resetKey={activeView}
              title="Spatial & Maps Hub encountered a workspace error"
            >
              <SpatialMapsHubView
                onSendLocationToMockup={handleSendLocationToMockup}
                stagedImageFor3D={stagedImageFor3D}
                onSetStagedImageFor3D={setStagedImageFor3D}
                staged3DPayload={staged3DPayload}
                onSetStaged3DPayload={setStaged3DPayload}
                onSaveRenderToClientPitch={(dataUrl, label) => {
                  void handleSave3DRenderToClientPitch(dataUrl, label);
                }}
                waypoints={routeWaypoints}
                onWaypointsChange={setRouteWaypoints}
                activeBriefing={activeBriefing}
                articles={activeSources}
                activeSegmentIndex={activeSegmentIndex}
                isPlayingAudio={isPlaying && Boolean(activeBriefing)}
                onSelectBriefingSegment={handlePlaySegment}
                onToggleBriefingAudio={handleTogglePlayPause}
                onImmersiveModeChange={setIsSpatialImmersive}
              />
            </FirestoreErrorBoundary>
          )}

          {activeView === 'owner' && (
            <FirestoreErrorBoundary
              resetKey={activeView}
              title="Owner Console encountered a workspace error"
            >
              <OwnerConsoleView
                onNavigateView={setActiveView}
                onPreviewSharedBriefing={handleOpenSharedPreview}
                onPreviewSharedMockup={handleOpenSharedMockup}
              />
            </FirestoreErrorBoundary>
          )}
        </main>
      </div>

      {/* Source Guide & Cited Passage Inspector Slide-Over */}
      <SourceInspectorDrawer
        target={inspectedTarget}
        sources={articles}
        onClose={() => setInspectedTarget(null)}
        onToggleReadLater={handleToggleReadLater}
      />

      {/* Add Source Modal (Upload PDF/DOCX/TXT/MD, Google Drive, Article URL, or Paste Text) */}
      <AddSourceModal
        open={addModalOpen}
        initialTab={addModalTab}
        isBusy={isIngesting}
        statusMessage={uploadStatus}
        errorMessage={ingestError}
        onClose={() => {
          if (!isIngesting) {
            setAddModalOpen(false);
            setIngestError(null);
          }
        }}
        onUploadFiles={handleUploadFiles}
        onImportDriveItems={handleImportDriveItems}
        onIngestUrlOrText={handleIngestArticle}
      />

      {/* Google Drive & Formatted Google Docs Workspace Modal */}
      <FirestoreErrorBoundary
        resetKey={driveModalOpen ? 'drive-open' : 'drive-closed'}
        title="Google Drive Workspace encountered an error"
      >
        <GoogleDriveModal
          open={driveModalOpen}
          initialTab={driveModalTab}
          briefing={activeBriefing}
          onBuildStitchedWavBlob={handleBuildStitchedWavBlob}
          onImportFilesToSources={handleUploadFiles}
          onImportDriveItems={handleImportDriveItems}
          onExportedBriefingAsset={handleExportedBriefingAsset}
          onClose={() => setDriveModalOpen(false)}
        />
      </FirestoreErrorBoundary>

      {/* Google Tasks Slide-Over Drawer */}
      <FirestoreErrorBoundary
        resetKey={tasksDrawerOpen ? 'tasks-open' : 'tasks-closed'}
        title="Google Tasks encountered an error"
      >
        <GoogleTasksDrawer
          open={tasksDrawerOpen}
          briefing={activeBriefing}
          stagedTakeawayIndices={stagedTaskIndices}
          onClearStagedTakeaways={() => setStagedTaskIndices(null)}
          onTasksCreated={handleTasksCreatedFromBriefing}
          onClose={() => {
            setTasksDrawerOpen(false);
            setStagedTaskIndices(null);
          }}
        />
      </FirestoreErrorBoundary>

      {/* Persistent Audio Player Bar */}
      {!hideChromeForSpatialImmersive && activeBriefing && hasReadyAudio && (
        <AudioPlayerBar
          briefing={activeBriefing}
          activeSegmentIndex={activeSegmentIndex}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          playbackRate={playbackRate}
          audioElementRef={audioRef}
          sleepTimerMode={sleepTimerMode}
          sleepTimerRemainingSec={sleepTimerRemainingSec}
          onSetSleepTimerMinutes={handleSetSleepTimerMinutes}
          onSetSleepTimerEndOfChapter={handleSetSleepTimerEndOfChapter}
          onExtendSleepTimer={handleExtendSleepTimer}
          onCancelSleepTimer={handleCancelSleepTimer}
          onTogglePlayPause={handleTogglePlayPause}
          onSeek={handleSeek}
          onSkipSeconds={handleSkipSeconds}
          onPrevChapter={handlePrevChapter}
          onNextChapter={handleNextChapter}
          onCyclePlaybackRate={handleCyclePlaybackRate}
          onOpenCommuteMode={() => setCommuteModeOpen(true)}
        />
      )}

      {/* Distraction-Free Commute Mode Full-Screen Overlay */}
      {commuteModeOpen && activeBriefing && hasReadyAudio && (
        <CommuteModeOverlay
          briefing={activeBriefing}
          activeSegmentIndex={activeSegmentIndex}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          playbackRate={playbackRate}
          sleepTimerMode={sleepTimerMode}
          sleepTimerRemainingSec={sleepTimerRemainingSec}
          onCycleSleepTimer={handleCycleCommuteSleepTimer}
          onClose={() => setCommuteModeOpen(false)}
          onTogglePlayPause={handleTogglePlayPause}
          onSeek={handleSeek}
          onSkipSeconds={handleSkipSeconds}
          onPrevChapter={handlePrevChapter}
          onNextChapter={handleNextChapter}
          onSelectChapter={handlePlaySegment}
          onCyclePlaybackRate={handleCyclePlaybackRate}
        />
      )}

      {/* Hidden Audio Elements */}
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          const d = e.currentTarget.duration || duration;
          setCurrentTime(t);
          if (activeBriefing && !e.currentTarget.paused) {
            persistPlaybackPosition(
              activeBriefing.id,
              activeSegmentIndex,
              t,
              d,
              playbackRate,
              false
            );
          }
        }}
        onLoadedMetadata={(e) => {
          const audioEl = e.currentTarget;
          const dur = audioEl.duration || 0;
          setDuration(dur);
          if (pendingSeekTimeRef.current !== null) {
            const clamped = Math.max(
              0,
              Math.min(pendingSeekTimeRef.current, Math.max(0, dur - 0.5))
            );
            audioEl.currentTime = clamped;
            setCurrentTime(clamped);
            pendingSeekTimeRef.current = null;
          }
          if (pendingAutoPlayRef.current) {
            pendingAutoPlayRef.current = false;
            audioEl
              .play()
              .then(() => setIsPlaying(true))
              .catch(() => setIsPlaying(false));
          }
        }}
        onEnded={handleAudioEnded}
        onPause={(e) => {
          setIsPlaying(false);
          if (activeBriefing && e.currentTarget.currentTime > 0) {
            persistPlaybackPosition(
              activeBriefing.id,
              activeSegmentIndex,
              e.currentTarget.currentTime,
              e.currentTarget.duration || duration,
              playbackRate,
              true
            );
          }
        }}
        onPlay={() => setIsPlaying(true)}
      />
      <audio
        ref={chatAudioRef}
        onEnded={() => setPlayingMessageId(null)}
        onPause={() => setPlayingMessageId(null)}
      />

      {/* Global Image Transfer Confirmation Toast */}
      <TransferToast
        toast={transferToast}
        onDismiss={dismissTransferToast}
        onPauseAutoDismiss={pauseTransferToastTimer}
        onResumeAutoDismiss={resumeTransferToastTimer}
        onReturnToMediaLab={
          activeView !== 'media'
            ? () => {
                setActiveView('media');
                dismissTransferToast();
              }
            : undefined
        }
      />
    </div>
  );
}
