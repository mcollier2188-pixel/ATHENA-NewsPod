import type {
  AudioBriefing,
  LocalRssFeedConfig,
  RssFeedAnalyticsSnapshot,
  RssFeedManifestPublic,
} from '../types';
import { loadBriefingAudio } from '../utils/audioCache';

export const STORAGE_RSS_FEED_KEY = 'dispatch_private_rss_feed_v1';

export interface RssAuthHeadersOptions {
  token?: string | null;
  manageToken?: string | null;
}

export interface RssSyncProgress {
  completed: number;
  total: number;
  currentTitle: string;
}

export interface RssSyncResult {
  config: LocalRssFeedConfig;
  manifest: RssFeedManifestPublic;
  uploadedCount: number;
  removedCount: number;
  skippedNoAudioCount: number;
  reprovisioned: boolean;
}

function buildHeaders(auth?: RssAuthHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (auth?.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  if (auth?.manageToken) {
    headers['X-Rss-Manage-Token'] = auth.manageToken;
  }
  return headers;
}

async function parseApiResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof (data as { error?: unknown })?.error === 'string'
        ? (data as { error: string }).error
        : `Request failed with status ${res.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export function loadLocalRssFeedConfig(): LocalRssFeedConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_RSS_FEED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalRssFeedConfig>;
    if (!parsed.feedId || !parsed.feedToken || !parsed.manageToken) {
      return null;
    }
    return {
      feedId: parsed.feedId,
      feedToken: parsed.feedToken,
      manageToken: parsed.manageToken,
      title: parsed.title || 'My Daily Dispatch',
      description:
        parsed.description ||
        'Personalized audio news briefings stitched from your Dispatch Archive.',
      author: parsed.author || 'Dispatch Personal Audio',
      autoSync: parsed.autoSync !== false,
      lastSyncedAt: parsed.lastSyncedAt || null,
      syncedSignatures:
        parsed.syncedSignatures && typeof parsed.syncedSignatures === 'object'
          ? parsed.syncedSignatures
          : {},
      expiresAt: parsed.expiresAt ?? null,
      passwordProtected: Boolean(parsed.passwordProtected),
      accessKeyToken: parsed.accessKeyToken,
      useSignedUrlKey: parsed.useSignedUrlKey !== false,
      growthAlert:
        parsed.growthAlert && typeof parsed.growthAlert === 'object'
          ? {
              enabled: parsed.growthAlert.enabled !== false,
              thresholdPercent:
                typeof parsed.growthAlert.thresholdPercent === 'number' &&
                Number.isFinite(parsed.growthAlert.thresholdPercent)
                  ? Math.min(200, Math.max(1, parsed.growthAlert.thresholdPercent))
                  : 10,
              browserNotificationsEnabled: Boolean(
                parsed.growthAlert.browserNotificationsEnabled
              ),
              acknowledgedSignature:
                parsed.growthAlert.acknowledgedSignature ?? null,
            }
          : undefined,
    };
  } catch {
    return null;
  }
}

export function saveLocalRssFeedConfig(config: LocalRssFeedConfig | null): void {
  try {
    if (!config) {
      localStorage.removeItem(STORAGE_RSS_FEED_KEY);
      return;
    }
    localStorage.setItem(STORAGE_RSS_FEED_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota errors
  }
}

export function buildAbsoluteRssUrl(
  feedToken: string,
  accessKeyToken?: string
): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : '';
  const base = `${origin}/api/rss/${encodeURIComponent(feedToken)}.xml`;
  if (accessKeyToken) {
    return `${base}?key=${encodeURIComponent(accessKeyToken)}`;
  }
  return base;
}

export async function createPrivateRssFeed(
  payload: {
    title: string;
    description?: string;
    author?: string;
    expiresAt?: string | null;
    passwordProtected?: boolean;
    password?: string | null;
  },
  auth?: { token?: string | null }
): Promise<{ feed: RssFeedManifestPublic; manageToken: string }> {
  const res = await fetch('/api/rss/feeds', {
    method: 'POST',
    headers: buildHeaders({ token: auth?.token }),
    body: JSON.stringify(payload),
  });
  return parseApiResponse<{ feed: RssFeedManifestPublic; manageToken: string }>(res);
}

export async function fetchPrivateRssFeed(
  feedId: string,
  auth: RssAuthHeadersOptions
): Promise<RssFeedManifestPublic> {
  const res = await fetch(`/api/rss/feeds/${encodeURIComponent(feedId)}`, {
    method: 'GET',
    headers: buildHeaders(auth),
  });
  const data = await parseApiResponse<{ feed: RssFeedManifestPublic }>(res);
  return data.feed;
}

export async function fetchPrivateRssAnalytics(
  feedId: string,
  auth: RssAuthHeadersOptions
): Promise<RssFeedAnalyticsSnapshot> {
  const res = await fetch(
    `/api/rss/feeds/${encodeURIComponent(feedId)}/analytics`,
    {
      method: 'GET',
      headers: buildHeaders(auth),
    }
  );
  const data = await parseApiResponse<{ analytics: RssFeedAnalyticsSnapshot }>(res);
  return data.analytics;
}

export async function updatePrivateRssFeed(
  feedId: string,
  payload: {
    title?: string;
    description?: string;
    author?: string;
    expiresAt?: string | null;
    passwordProtected?: boolean;
    password?: string | null;
  },
  auth: RssAuthHeadersOptions
): Promise<RssFeedManifestPublic> {
  const res = await fetch(`/api/rss/feeds/${encodeURIComponent(feedId)}`, {
    method: 'PATCH',
    headers: buildHeaders(auth),
    body: JSON.stringify(payload),
  });
  const data = await parseApiResponse<{ feed: RssFeedManifestPublic }>(res);
  return data.feed;
}

export async function regeneratePrivateRssFeedToken(
  feedId: string,
  auth: RssAuthHeadersOptions
): Promise<RssFeedManifestPublic> {
  const res = await fetch(
    `/api/rss/feeds/${encodeURIComponent(feedId)}/regenerate`,
    {
      method: 'POST',
      headers: buildHeaders(auth),
      body: JSON.stringify({}),
    }
  );
  const data = await parseApiResponse<{ feed: RssFeedManifestPublic }>(res);
  return data.feed;
}

export async function deleteEpisodeFromRssFeed(
  feedId: string,
  briefingId: string,
  auth: RssAuthHeadersOptions
): Promise<RssFeedManifestPublic> {
  const res = await fetch(
    `/api/rss/feeds/${encodeURIComponent(feedId)}/episodes/${encodeURIComponent(briefingId)}`,
    {
      method: 'DELETE',
      headers: buildHeaders(auth),
    }
  );
  const data = await parseApiResponse<{ feed: RssFeedManifestPublic }>(res);
  return data.feed;
}

function buildAudioSignature(
  briefing: AudioBriefing,
  resolvedSegments: Array<{ id: string; title: string; audioBase64?: string }>
): string {
  const segSig = resolvedSegments
    .map((s) => {
      const len = s.audioBase64?.length || 0;
      const head = s.audioBase64 ? s.audioBase64.slice(0, 16) : '';
      const tail = s.audioBase64 ? s.audioBase64.slice(-16) : '';
      return `${s.id}:${s.title}:${len}:${head}:${tail}`;
    })
    .join('|');
  return `${briefing.editionTitle}::${briefing.editionSubtitle}::${briefing.takeaways.length}::${segSig}`;
}

export async function countBriefingsWithRecordedAudio(
  archive: AudioBriefing[]
): Promise<{ total: number; readyWithAudio: number; scriptOnly: number }> {
  let readyWithAudio = 0;
  for (const briefing of archive) {
    const hasInMemory = briefing.segments.some(
      (seg) => typeof seg.audioBase64 === 'string' && seg.audioBase64.length > 64
    );
    if (hasInMemory) {
      readyWithAudio += 1;
      continue;
    }
    const cached = await loadBriefingAudio(briefing.id);
    const hasCached = briefing.segments.some(
      (seg) => typeof cached[seg.id] === 'string' && cached[seg.id].length > 64
    );
    if (hasCached) {
      readyWithAudio += 1;
    }
  }
  return {
    total: archive.length,
    readyWithAudio,
    scriptOnly: Math.max(0, archive.length - readyWithAudio),
  };
}

export async function syncArchiveToPrivateFeed(
  config: LocalRssFeedConfig,
  archive: AudioBriefing[],
  options?: {
    authToken?: string | null;
    forceFullSync?: boolean;
    onProgress?: (progress: RssSyncProgress) => void;
  }
): Promise<RssSyncResult> {
  let activeConfig: LocalRssFeedConfig = {
    ...config,
    syncedSignatures: { ...config.syncedSignatures },
  };
  let reprovisioned = false;
  let manifest: RssFeedManifestPublic;

  // Verify the server feed still exists (re-provision cleanly if server tmpdir restarted)
  try {
    manifest = await fetchPrivateRssFeed(activeConfig.feedId, {
      token: options?.authToken,
      manageToken: activeConfig.manageToken,
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) {
      const created = await createPrivateRssFeed(
        {
          title: activeConfig.title,
          description: activeConfig.description,
          author: activeConfig.author,
        },
        { token: options?.authToken }
      );
      manifest = created.feed;
      activeConfig = {
        ...activeConfig,
        feedId: created.feed.feedId,
        feedToken: created.feed.feedToken,
        manageToken: created.manageToken,
        syncedSignatures: {},
      };
      reprovisioned = true;
    } else {
      throw err;
    }
  }

  const serverByBriefingId = new Map(
    manifest.episodes.map((ep) => [ep.briefingId, ep])
  );

  // Resolve cached audio from IndexedDB for every archived briefing
  const prepared: Array<{
    briefing: AudioBriefing;
    signature: string;
    segmentsWithAudio: Array<{
      title: string;
      category: string;
      keyPoint: string;
      estimatedSeconds: number;
      audioDurationSeconds?: number;
      audioBase64: string;
    }>;
  }> = [];

  let skippedNoAudioCount = 0;

  for (const briefing of archive) {
    const cachedMap = await loadBriefingAudio(briefing.id);
    const resolvedSegments = briefing.segments.map((seg) => ({
      ...seg,
      audioBase64:
        (typeof seg.audioBase64 === 'string' && seg.audioBase64.length > 64
          ? seg.audioBase64
          : cachedMap[seg.id]) || undefined,
    }));

    const segmentsWithAudio = resolvedSegments
      .filter(
        (seg): seg is typeof seg & { audioBase64: string } =>
          typeof seg.audioBase64 === 'string' && seg.audioBase64.length > 64
      )
      .map((seg) => ({
        title: seg.title,
        category: seg.category,
        keyPoint: seg.keyPoint,
        estimatedSeconds: seg.estimatedSeconds,
        audioDurationSeconds: seg.audioDurationSeconds,
        audioBase64: seg.audioBase64,
      }));

    if (segmentsWithAudio.length === 0) {
      skippedNoAudioCount += 1;
      continue;
    }

    const signature = buildAudioSignature(briefing, resolvedSegments);
    prepared.push({ briefing, signature, segmentsWithAudio });
  }

  const toUpload = prepared.filter(({ briefing, signature }) => {
    if (options?.forceFullSync) return true;
    const serverEp = serverByBriefingId.get(briefing.id);
    if (!serverEp) return true;
    return (
      serverEp.audioSignature !== signature ||
      activeConfig.syncedSignatures[briefing.id] !== signature
    );
  });

  const archiveIdsWithAudio = new Set(prepared.map((p) => p.briefing.id));
  const toDelete = manifest.episodes
    .map((ep) => ep.briefingId)
    .filter((id) => !archiveIdsWithAudio.has(id));

  const totalSteps = toUpload.length + toDelete.length;
  let completedSteps = 0;
  let uploadedCount = 0;
  let removedCount = 0;

  for (const item of toUpload) {
    options?.onProgress?.({
      completed: completedSteps,
      total: totalSteps,
      currentTitle: item.briefing.editionTitle,
    });

    const res = await fetch(
      `/api/rss/feeds/${encodeURIComponent(activeConfig.feedId)}/episodes/${encodeURIComponent(item.briefing.id)}`,
      {
        method: 'PUT',
        headers: buildHeaders({
          token: options?.authToken,
          manageToken: activeConfig.manageToken,
        }),
        body: JSON.stringify({
          title: item.briefing.editionTitle,
          subtitle: item.briefing.editionSubtitle,
          publishedAt: item.briefing.createdAt,
          takeaways: item.briefing.takeaways,
          articleTitles: item.briefing.articleTitles,
          format: item.briefing.preferences.format,
          audioSignature: item.signature,
          segments: item.segmentsWithAudio,
        }),
      }
    );
    const data = await parseApiResponse<{ feed: RssFeedManifestPublic }>(res);
    manifest = data.feed;
    activeConfig.syncedSignatures[item.briefing.id] = item.signature;
    uploadedCount += 1;
    completedSteps += 1;
  }

  for (const staleBriefingId of toDelete) {
    options?.onProgress?.({
      completed: completedSteps,
      total: totalSteps,
      currentTitle: 'Removing deleted edition...',
    });
    manifest = await deleteEpisodeFromRssFeed(
      activeConfig.feedId,
      staleBriefingId,
      {
        token: options?.authToken,
        manageToken: activeConfig.manageToken,
      }
    );
    delete activeConfig.syncedSignatures[staleBriefingId];
    removedCount += 1;
    completedSteps += 1;
  }

  if (totalSteps > 0) {
    options?.onProgress?.({
      completed: totalSteps,
      total: totalSteps,
      currentTitle: 'Sync complete',
    });
  }

  // Clean up signatures map so it only retains synced episodes
  const cleanSignatures: Record<string, string> = {};
  for (const ep of manifest.episodes) {
    cleanSignatures[ep.briefingId] = ep.audioSignature;
  }

  activeConfig = {
    ...activeConfig,
    feedToken: manifest.feedToken,
    title: manifest.title,
    description: manifest.description,
    author: manifest.author,
    expiresAt: manifest.expiresAt,
    passwordProtected: manifest.passwordProtected,
    accessKeyToken: manifest.accessKeyToken,
    lastSyncedAt: new Date().toISOString(),
    syncedSignatures: cleanSignatures,
  };

  saveLocalRssFeedConfig(activeConfig);

  return {
    config: activeConfig,
    manifest,
    uploadedCount,
    removedCount,
    skippedNoAudioCount,
    reprovisioned,
  };
}
