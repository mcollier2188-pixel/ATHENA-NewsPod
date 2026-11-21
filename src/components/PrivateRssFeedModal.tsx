import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Radio,
  RefreshCw,
  Rss,
  ShieldCheck,
  Unlock,
  X,
} from 'lucide-react';
import type {
  AudioBriefing,
  LocalRssFeedConfig,
  RssFeedEpisodeSummary,
  RssFeedManifestPublic,
} from '../types';
import {
  buildAbsoluteRssUrl,
  countBriefingsWithRecordedAudio,
  createPrivateRssFeed,
  fetchPrivateRssFeed,
  regeneratePrivateRssFeedToken,
  saveLocalRssFeedConfig,
  syncArchiveToPrivateFeed,
  updatePrivateRssFeed,
  type RssSyncProgress,
} from '../services/rssApi';
import { formatClock } from '../utils/wavUtils';
import { useAuth } from '../contexts/AuthContext';

interface PrivateRssFeedModalProps {
  isOpen: boolean;
  onClose: () => void;
  archive: AudioBriefing[];
  feedConfig: LocalRssFeedConfig | null;
  onFeedConfigChange: (next: LocalRssFeedConfig | null) => void;
}

type ExpirationPreset = 'never' | '24h' | '7d' | '30d' | 'custom';

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

function formatTimestampMmSs(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function toDatetimeLocalInput(iso: string | null | undefined): string {
  const base = iso ? new Date(iso) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const valid = Number.isNaN(base.getTime())
    ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    : base;
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = valid.getFullYear();
  const mm = pad(valid.getMonth() + 1);
  const dd = pad(valid.getDate());
  const hh = pad(valid.getHours());
  const min = pad(valid.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function computePresetExpiresAt(preset: ExpirationPreset, customLocalValue: string): string | null {
  const now = Date.now();
  if (preset === 'never') return null;
  if (preset === '24h') return new Date(now + 24 * 60 * 60 * 1000).toISOString();
  if (preset === '7d') return new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (preset === '30d') return new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  if (preset === 'custom' && customLocalValue) {
    const parsed = new Date(customLocalValue);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function detectMatchingPreset(expiresAt: string | null | undefined): ExpirationPreset {
  if (!expiresAt) return 'never';
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(remainingMs)) return 'never';
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  if (Math.abs(remainingMs - 24 * hourMs) < 2 * hourMs) return '24h';
  if (Math.abs(remainingMs - 7 * dayMs) < 4 * hourMs) return '7d';
  if (Math.abs(remainingMs - 30 * dayMs) < 12 * hourMs) return '30d';
  return 'custom';
}

export function PrivateRssFeedModal({
  isOpen,
  onClose,
  archive,
  feedConfig,
  onFeedConfigChange,
}: PrivateRssFeedModalProps) {
  const { user, getIdToken } = useAuth();
  const defaultAuthor = user?.displayName || 'Dispatch Personal Audio';
  const [titleDraft, setTitleDraft] = useState(
    feedConfig?.title || 'My Daily Dispatch'
  );
  const [authorDraft, setAuthorDraft] = useState(
    feedConfig?.author || defaultAuthor
  );
  const [descriptionDraft, setDescriptionDraft] = useState(
    feedConfig?.description ||
      'Personalized audio news briefings stitched from your Dispatch Archive.'
  );

  // Security & Access draft state (used both during initial feed creation and active feed management)
  const [expirationPreset, setExpirationPreset] = useState<ExpirationPreset>(
    detectMatchingPreset(feedConfig?.expiresAt ?? null)
  );
  const [customExpirationLocal, setCustomExpirationLocal] = useState<string>(
    toDatetimeLocalInput(feedConfig?.expiresAt ?? null)
  );
  const [passwordToggleOpen, setPasswordToggleOpen] = useState<boolean>(
    Boolean(feedConfig?.passwordProtected)
  );
  const [passwordDraft, setPasswordDraft] = useState<string>('');
  const [showPasswordText, setShowPasswordText] = useState<boolean>(false);
  const [useSignedUrlKey, setUseSignedUrlKey] = useState<boolean>(
    feedConfig?.useSignedUrlKey !== false
  );
  const [isUpdatingSecurity, setIsUpdatingSecurity] = useState<boolean>(false);

  const [manifest, setManifest] = useState<RssFeedManifestPublic | null>(null);
  const [audioCounts, setAudioCounts] = useState<{
    total: number;
    readyWithAudio: number;
    scriptOnly: number;
  }>({ total: archive.length, readyWithAudio: 0, scriptOnly: archive.length });

  const [isLoadingFeed, setIsLoadingFeed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<RssSyncProgress | null>(null);
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [titleSavedFlash, setTitleSavedFlash] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [expandedEpisodeId, setExpandedEpisodeId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sync draft fields when feedConfig changes
  useEffect(() => {
    if (!isOpen) return;
    setTitleDraft(feedConfig?.title || 'My Daily Dispatch');
    setAuthorDraft(
      feedConfig?.author || defaultAuthor || 'Dispatch Personal Audio'
    );
    setDescriptionDraft(
      feedConfig?.description ||
        'Personalized audio news briefings stitched from your Dispatch Archive.'
    );
    setExpirationPreset(detectMatchingPreset(feedConfig?.expiresAt ?? null));
    setCustomExpirationLocal(toDatetimeLocalInput(feedConfig?.expiresAt ?? null));
    setPasswordToggleOpen(Boolean(feedConfig?.passwordProtected));
    setPasswordDraft('');
    setUseSignedUrlKey(feedConfig?.useSignedUrlKey !== false);
    setConfirmRegenerate(false);
    setErrorMessage(null);
    setStatusNotice(null);
  }, [
    isOpen,
    feedConfig?.feedId,
    feedConfig?.title,
    feedConfig?.author,
    feedConfig?.description,
    feedConfig?.expiresAt,
    feedConfig?.passwordProtected,
    feedConfig?.useSignedUrlKey,
    defaultAuthor,
  ]);

  // Escape-to-close listener
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  // Inspect archive audio readiness and load current server manifest on open
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    void countBriefingsWithRecordedAudio(archive).then((counts) => {
      if (!cancelled) setAudioCounts(counts);
    });

    if (!feedConfig) {
      setManifest(null);
      return;
    }

    setIsLoadingFeed(true);
    void (async () => {
      try {
        const token = await getIdToken().catch(() => null);
        const fetched = await fetchPrivateRssFeed(feedConfig.feedId, {
          token,
          manageToken: feedConfig.manageToken,
        });
        if (!cancelled) {
          setManifest(fetched);
          setExpirationPreset(detectMatchingPreset(fetched.expiresAt));
          if (fetched.expiresAt) {
            setCustomExpirationLocal(toDatetimeLocalInput(fetched.expiresAt));
          }
          setPasswordToggleOpen(fetched.passwordProtected);
          if (fetched.episodes.length > 0 && !expandedEpisodeId) {
            setExpandedEpisodeId(fetched.episodes[0].briefingId);
          }
        }
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 404 && !cancelled) {
          // Server storage reset; auto-resync transparently to restore feed
          setIsSyncing(true);
          try {
            const token = await getIdToken().catch(() => null);
            const resynced = await syncArchiveToPrivateFeed(feedConfig, archive, {
              authToken: token,
              forceFullSync: true,
              onProgress: (p) => {
                if (!cancelled) setSyncProgress(p);
              },
            });
            if (!cancelled) {
              setManifest(resynced.manifest);
              onFeedConfigChange(resynced.config);
              if (resynced.reprovisioned) {
                setStatusNotice(
                  'Your private feed was refreshed on the server with a new URL and all archived audio synced.'
                );
              }
            }
          } catch (syncErr) {
            if (!cancelled) {
              setErrorMessage(
                syncErr instanceof Error
                  ? syncErr.message
                  : 'Unable to sync your private RSS feed.'
              );
            }
          } finally {
            if (!cancelled) {
              setIsSyncing(false);
              setSyncProgress(null);
            }
          }
        } else if (!cancelled) {
          setErrorMessage(
            err instanceof Error
              ? err.message
              : 'Unable to load private podcast feed.'
          );
        }
      } finally {
        if (!cancelled) setIsLoadingFeed(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, feedConfig?.feedId]);

  if (!isOpen) return null;

  const activeFeedToken = manifest?.feedToken || feedConfig?.feedToken || '';
  const activeExpiresAt =
    manifest !== null ? manifest.expiresAt : (feedConfig?.expiresAt ?? null);
  const isFeedExpired =
    manifest !== null
      ? manifest.isExpired
      : Boolean(activeExpiresAt && new Date(activeExpiresAt).getTime() <= Date.now());
  const isPasswordProtected =
    manifest !== null
      ? manifest.passwordProtected
      : Boolean(feedConfig?.passwordProtected);
  const activeAccessKeyToken =
    manifest?.accessKeyToken || feedConfig?.accessKeyToken || undefined;

  const signedKeyForUrl =
    isPasswordProtected && useSignedUrlKey ? activeAccessKeyToken : undefined;
  const privateFeedUrl = activeFeedToken
    ? buildAbsoluteRssUrl(activeFeedToken, signedKeyForUrl)
    : '';
  const downloadXmlUrl = privateFeedUrl
    ? `${privateFeedUrl}${privateFeedUrl.includes('?') ? '&' : '?'}download=1`
    : '';

  const persistSecurityToLocalConfig = (updated: RssFeedManifestPublic, nextUseSignedKey = useSignedUrlKey) => {
    if (!feedConfig) return;
    const nextConfig: LocalRssFeedConfig = {
      ...feedConfig,
      feedToken: updated.feedToken,
      title: updated.title,
      author: updated.author,
      description: updated.description,
      expiresAt: updated.expiresAt,
      passwordProtected: updated.passwordProtected,
      accessKeyToken: updated.accessKeyToken,
      useSignedUrlKey: nextUseSignedKey,
    };
    saveLocalRssFeedConfig(nextConfig);
    onFeedConfigChange(nextConfig);
  };

  const handleApplyExpiration = async (
    nextPreset: ExpirationPreset,
    explicitExpiresAt?: string | null
  ) => {
    setExpirationPreset(nextPreset);

    // If feed hasn't been created yet (State A), just update local selection
    if (!feedConfig) {
      return;
    }

    // For custom preset without an explicit apply timestamp, wait until user clicks "Apply Date"
    if (nextPreset === 'custom' && explicitExpiresAt === undefined) {
      return;
    }

    const targetExpiresAt =
      explicitExpiresAt !== undefined
        ? explicitExpiresAt
        : computePresetExpiresAt(nextPreset, customExpirationLocal);

    if (nextPreset === 'custom' && !targetExpiresAt) {
      setErrorMessage('Please choose a valid expiration date and time.');
      return;
    }

    setErrorMessage(null);
    setStatusNotice(null);
    setIsUpdatingSecurity(true);
    try {
      const token = await getIdToken().catch(() => null);
      const updated = await updatePrivateRssFeed(
        feedConfig.feedId,
        { expiresAt: targetExpiresAt },
        {
          token,
          manageToken: feedConfig.manageToken,
        }
      );
      setManifest(updated);
      if (updated.expiresAt) {
        setCustomExpirationLocal(toDatetimeLocalInput(updated.expiresAt));
      }
      persistSecurityToLocalConfig(updated);
      if (!updated.expiresAt) {
        setStatusNotice('Feed link expiration removed. Your private podcast URL will remain active indefinitely.');
      } else if (updated.isExpired) {
        setStatusNotice('Feed expiration set in the past. External requests now return HTTP 410 Gone until extended.');
      } else {
        setStatusNotice(`Feed link expiration updated to ${formatShortDate(updated.expiresAt)}.`);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not update feed link expiration.'
      );
    } finally {
      setIsUpdatingSecurity(false);
    }
  };

  const handleTogglePasswordSwitch = async () => {
    const nextState = !passwordToggleOpen;
    setPasswordToggleOpen(nextState);

    if (!feedConfig) {
      if (!nextState) setPasswordDraft('');
      return;
    }

    // If turning OFF an actively password-protected feed, immediately disable protection on server
    if (!nextState && isPasswordProtected) {
      setErrorMessage(null);
      setStatusNotice(null);
      setIsUpdatingSecurity(true);
      try {
        const token = await getIdToken().catch(() => null);
        const updated = await updatePrivateRssFeed(
          feedConfig.feedId,
          { passwordProtected: false, password: '' },
          {
            token,
            manageToken: feedConfig.manageToken,
          }
        );
        setManifest(updated);
        setPasswordDraft('');
        persistSecurityToLocalConfig(updated);
        setStatusNotice('Password protection disabled for your private podcast RSS URL.');
      } catch (err) {
        setPasswordToggleOpen(true);
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not disable password protection.'
        );
      } finally {
        setIsUpdatingSecurity(false);
      }
    }
  };

  const handleSavePassword = async () => {
    if (!feedConfig || isUpdatingSecurity) return;
    const cleanPassword = passwordDraft.trim();
    if (cleanPassword.length < 4) {
      setErrorMessage('Feed password must be at least 4 characters.');
      return;
    }
    setErrorMessage(null);
    setStatusNotice(null);
    setIsUpdatingSecurity(true);
    try {
      const token = await getIdToken().catch(() => null);
      const updated = await updatePrivateRssFeed(
        feedConfig.feedId,
        {
          passwordProtected: true,
          password: cleanPassword,
        },
        {
          token,
          manageToken: feedConfig.manageToken,
        }
      );
      setManifest(updated);
      setPasswordToggleOpen(true);
      setPasswordDraft('');
      persistSecurityToLocalConfig(updated);
      setStatusNotice(
        'Password protection enabled. External podcast players require HTTP Basic Auth or the signed access key URL.'
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not update feed password.'
      );
    } finally {
      setIsUpdatingSecurity(false);
    }
  };

  const handleToggleSignedUrlKey = () => {
    const next = !useSignedUrlKey;
    setUseSignedUrlKey(next);
    if (feedConfig) {
      const nextConfig: LocalRssFeedConfig = {
        ...feedConfig,
        useSignedUrlKey: next,
      };
      saveLocalRssFeedConfig(nextConfig);
      onFeedConfigChange(nextConfig);
    }
  };

  const handleCreateFeed = async () => {
    setErrorMessage(null);
    setStatusNotice(null);

    const initialPassword = passwordToggleOpen ? passwordDraft.trim() : '';
    if (passwordToggleOpen && initialPassword.length < 4) {
      setErrorMessage('Please enter a password of at least 4 characters or toggle off password protection.');
      return;
    }

    const initialExpiresAt = computePresetExpiresAt(
      expirationPreset,
      customExpirationLocal
    );
    if (expirationPreset === 'custom' && !initialExpiresAt) {
      setErrorMessage('Please choose a valid custom expiration date and time.');
      return;
    }

    setIsCreating(true);
    try {
      const cleanTitle = titleDraft.trim() || 'My Daily Dispatch';
      const cleanAuthor = authorDraft.trim() || 'Dispatch Personal Audio';
      const cleanDesc =
        descriptionDraft.trim() ||
        'Personalized audio news briefings stitched from your Dispatch Archive.';

      const token = await getIdToken().catch(() => null);
      const { feed, manageToken } = await createPrivateRssFeed(
        {
          title: cleanTitle,
          author: cleanAuthor,
          description: cleanDesc,
          expiresAt: initialExpiresAt,
          passwordProtected: passwordToggleOpen && initialPassword.length >= 4,
          password: initialPassword || undefined,
        },
        { token }
      );

      const initialConfig: LocalRssFeedConfig = {
        feedId: feed.feedId,
        feedToken: feed.feedToken,
        manageToken,
        title: feed.title,
        description: feed.description,
        author: feed.author,
        autoSync: true,
        lastSyncedAt: null,
        syncedSignatures: {},
        expiresAt: feed.expiresAt,
        passwordProtected: feed.passwordProtected,
        accessKeyToken: feed.accessKeyToken,
        useSignedUrlKey,
      };

      setIsSyncing(true);
      const synced = await syncArchiveToPrivateFeed(initialConfig, archive, {
        authToken: token,
        forceFullSync: true,
        onProgress: setSyncProgress,
      });

      setManifest(synced.manifest);
      setPasswordDraft('');
      onFeedConfigChange({
        ...synced.config,
        useSignedUrlKey,
      });
      if (synced.manifest.episodes.length > 0) {
        setExpandedEpisodeId(synced.manifest.episodes[0].briefingId);
      }
      if (synced.uploadedCount > 0) {
        setStatusNotice(
          `Private RSS feed created and synced ${synced.uploadedCount} full-edition ${synced.uploadedCount === 1 ? 'episode' : 'episodes'}.`
        );
      } else {
        setStatusNotice(
          'Private RSS feed created. Record audio on any briefing and it will appear automatically.'
        );
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Could not create private podcast RSS feed.'
      );
    } finally {
      setIsCreating(false);
      setIsSyncing(false);
      setSyncProgress(null);
    }
  };

  const handleSyncNow = async () => {
    if (!feedConfig || isSyncing) return;
    setErrorMessage(null);
    setStatusNotice(null);
    setIsSyncing(true);
    try {
      const token = await getIdToken().catch(() => null);
      const synced = await syncArchiveToPrivateFeed(feedConfig, archive, {
        authToken: token,
        onProgress: setSyncProgress,
      });
      setManifest(synced.manifest);
      onFeedConfigChange(synced.config);
      const counts = await countBriefingsWithRecordedAudio(archive);
      setAudioCounts(counts);

      if (synced.uploadedCount === 0 && synced.removedCount === 0) {
        setStatusNotice('Your private RSS feed is already up to date.');
      } else {
        const parts: string[] = [];
        if (synced.uploadedCount > 0) {
          parts.push(
            `published ${synced.uploadedCount} ${synced.uploadedCount === 1 ? 'edition' : 'editions'}`
          );
        }
        if (synced.removedCount > 0) {
          parts.push(
            `removed ${synced.removedCount} deleted ${synced.removedCount === 1 ? 'edition' : 'editions'}`
          );
        }
        setStatusNotice(`Feed synced: ${parts.join(' and ')}.`);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to sync archived briefings.'
      );
    } finally {
      setIsSyncing(false);
      setSyncProgress(null);
    }
  };

  const handleSaveTitle = async () => {
    if (!feedConfig || isSavingTitle) return;
    const cleanTitle = titleDraft.trim();
    if (!cleanTitle) {
      setErrorMessage('Podcast title cannot be empty.');
      return;
    }
    setErrorMessage(null);
    setIsSavingTitle(true);
    try {
      const token = await getIdToken().catch(() => null);
      const updated = await updatePrivateRssFeed(
        feedConfig.feedId,
        {
          title: cleanTitle,
          author: authorDraft.trim() || feedConfig.author,
        },
        {
          token,
          manageToken: feedConfig.manageToken,
        }
      );
      setManifest(updated);
      persistSecurityToLocalConfig(updated);
      setTitleSavedFlash(true);
      setTimeout(() => setTitleSavedFlash(false), 2200);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not update podcast title.'
      );
    } finally {
      setIsSavingTitle(false);
    }
  };

  const handleToggleAutoSync = () => {
    if (!feedConfig) return;
    const nextConfig: LocalRssFeedConfig = {
      ...feedConfig,
      autoSync: !feedConfig.autoSync,
    };
    saveLocalRssFeedConfig(nextConfig);
    onFeedConfigChange(nextConfig);
  };

  const handleRegenerateUrl = async () => {
    if (!feedConfig || isRegenerating) return;
    setErrorMessage(null);
    setStatusNotice(null);
    setIsRegenerating(true);
    try {
      const token = await getIdToken().catch(() => null);
      const updated = await regeneratePrivateRssFeedToken(feedConfig.feedId, {
        token,
        manageToken: feedConfig.manageToken,
      });
      setManifest(updated);
      persistSecurityToLocalConfig(updated);
      setConfirmRegenerate(false);
      setStatusNotice(
        'Private RSS URL regenerated. Your previous link and access key are now revoked and all episodes remain intact.'
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to regenerate private URL.'
      );
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleCopyUrl = async () => {
    if (!privateFeedUrl) return;
    try {
      await navigator.clipboard.writeText(privateFeedUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2200);
    } catch {
      setErrorMessage('Could not copy to clipboard. Select the URL field to copy manually.');
    }
  };

  const episodes: RssFeedEpisodeSummary[] = manifest?.episodes || [];
  const hasUnsavedMeta =
    Boolean(feedConfig) &&
    (titleDraft.trim() !== (feedConfig?.title || '') ||
      authorDraft.trim() !== (feedConfig?.author || ''));

  const renderSecurityControls = (mode: 'create' | 'manage') => {
    const presetOptions: Array<{ id: ExpirationPreset; label: string }> = [
      { id: 'never', label: 'Never' },
      { id: '24h', label: '24h' },
      { id: '7d', label: '7d' },
      { id: '30d', label: '30d' },
      { id: 'custom', label: 'Custom' },
    ];

    const previewExpiresAt =
      mode === 'create'
        ? computePresetExpiresAt(expirationPreset, customExpirationLocal)
        : activeExpiresAt;

    return (
      <section className="p-4 bg-[#13161C] border border-[#262B36] rounded-lg space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
            <h3 className="text-xs font-medium uppercase tracking-wider text-[#F5F7FA]">
              Security &amp; Access
            </h3>
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
            {isFeedExpired && mode === 'manage' ? (
              <span className="px-2 py-0.5 bg-[#2A1418] border border-[#F87171]/50 text-[#FCA5A5] rounded">
                EXPIRED · 410 GONE
              </span>
            ) : previewExpiresAt ? (
              <span className="px-2 py-0.5 bg-[#1F1A10] border border-[#F59E0B]/40 text-[#FCD34D] rounded">
                Expires {formatShortDate(previewExpiresAt)}
              </span>
            ) : (
              <span className="px-2 py-0.5 bg-[#0D221C] border border-[#34D399]/35 text-[#6EE7B7] rounded">
                Never Expires
              </span>
            )}

            {(mode === 'manage' ? isPasswordProtected : passwordToggleOpen) ? (
              <span className="px-2 py-0.5 bg-[#0D2129] border border-[#22D3EE]/40 text-[#67E8F9] rounded inline-flex items-center gap-1">
                <Lock className="w-3 h-3" aria-hidden="true" />
                Password Protected
              </span>
            ) : (
              <span className="px-2 py-0.5 bg-[#0B0D10] border border-[#262B36] text-[#8B95A7] rounded inline-flex items-center gap-1">
                <Unlock className="w-3 h-3" aria-hidden="true" />
                Token Link Only
              </span>
            )}
          </div>
        </div>

        {/* Expired 410 Gone One-Click Reactivation Banner */}
        {mode === 'manage' && isFeedExpired && (
          <div className="p-3.5 bg-[#2A1418] border border-[#F87171]/50 rounded-lg space-y-2.5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-[#F87171] shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-[#FCA5A5]">
                  Private Feed Link Expired (HTTP 410 Gone)
                </p>
                <p className="mt-0.5 text-[11px] text-[#F87171]/90">
                  {activeExpiresAt
                    ? `This feed link expired on ${formatShortDate(activeExpiresAt)}. `
                    : 'This feed link has expired. '}
                  Podcast players currently receive a 410 Gone response, while your synced audio episodes remain safely stored.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <button
                type="button"
                disabled={isUpdatingSecurity}
                onClick={() =>
                  void handleApplyExpiration(
                    '7d',
                    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
                  )
                }
                className="h-8 px-3 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                Extend +7d
              </button>
              <button
                type="button"
                disabled={isUpdatingSecurity}
                onClick={() =>
                  void handleApplyExpiration(
                    '30d',
                    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                  )
                }
                className="h-8 px-3 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/45 hover:border-[#22D3EE] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                Extend +30d
              </button>
              <button
                type="button"
                disabled={isUpdatingSecurity}
                onClick={() => void handleApplyExpiration('never', null)}
                className="h-8 px-3 text-xs font-medium text-[#6EE7B7] bg-[#0D221C] border border-[#34D399]/40 hover:border-[#34D399] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                Reactivate (Never Expire)
              </button>
            </div>
          </div>
        )}

        {/* 1. Feed Link Expiration Presets & Custom Date Picker */}
        <div className="space-y-2.5 pt-1">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-[#F5F7FA] flex items-center gap-1.5">
                <CalendarClock className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                Feed Link Expiration
              </p>
              <p className="text-[11px] text-[#8B95A7] mt-0.5">
                Automatically revoke external access to the RSS XML and WAV episodes after a set window.
              </p>
            </div>

            <div
              className="inline-flex items-center p-0.5 bg-[#0B0D10] border border-[#262B36] rounded-md shrink-0"
              role="group"
              aria-label="Feed link expiration preset"
            >
              {presetOptions.map((opt) => {
                const isSelected = expirationPreset === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={isUpdatingSecurity}
                    onClick={() => void handleApplyExpiration(opt.id)}
                    className={`h-7 px-2.5 text-xs font-mono transition-colors rounded whitespace-nowrap cursor-pointer ${
                      isSelected
                        ? 'bg-[#22D3EE] text-[#071318] font-medium'
                        : 'text-[#A0AABB] hover:text-[#F5F7FA]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {expirationPreset === 'custom' && (
            <div className="p-3 bg-[#0B0D10] border border-[#262B36] rounded-md flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Clock className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
                <label
                  htmlFor={`rss-custom-expiry-${mode}`}
                  className="text-xs text-[#D1D5DB] whitespace-nowrap"
                >
                  Custom Expiration:
                </label>
                <input
                  id={`rss-custom-expiry-${mode}`}
                  type="datetime-local"
                  value={customExpirationLocal}
                  onChange={(e) => setCustomExpirationLocal(e.target.value)}
                  className="h-8 px-2.5 font-mono text-xs text-[#F5F7FA] bg-[#13161C] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded"
                />
              </div>
              {mode === 'manage' && (
                <button
                  type="button"
                  disabled={isUpdatingSecurity}
                  onClick={() => {
                    const iso = computePresetExpiresAt('custom', customExpirationLocal);
                    void handleApplyExpiration('custom', iso);
                  }}
                  className="h-8 px-3.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  {isUpdatingSecurity ? 'Saving...' : 'Apply Date'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* 2. Password Protection Toggle & Dual-Mode Auth Controls */}
        <div className="pt-3 border-t border-[#1E232D] space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={passwordToggleOpen}
                aria-label="Toggle password protection for private podcast feed"
                disabled={isUpdatingSecurity}
                onClick={() => void handleTogglePasswordSwitch()}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                  passwordToggleOpen ? 'bg-[#22D3EE]' : 'bg-[#2A303C]'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-[#071318] transition-transform ${
                    passwordToggleOpen ? 'translate-x-4.5' : 'translate-x-1'
                  }`}
                />
              </button>
              <div>
                <p className="text-xs font-medium text-[#F5F7FA]">
                  Password Protection
                </p>
                <p className="text-[11px] text-[#8B95A7]">
                  Require HTTP Basic Auth or a signed access key before serving the RSS feed and episode audio.
                </p>
              </div>
            </div>
          </div>

          {passwordToggleOpen && (
            <div className="p-3 bg-[#0B0D10] border border-[#262B36] rounded-md space-y-3">
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1 min-w-0">
                  <input
                    id={`rss-password-input-${mode}`}
                    type={showPasswordText ? 'text' : 'password'}
                    value={passwordDraft}
                    onChange={(e) => setPasswordDraft(e.target.value)}
                    placeholder={
                      mode === 'manage' && isPasswordProtected
                        ? 'Enter new password to rotate credentials...'
                        : 'Set feed password (min 4 characters)...'
                    }
                    aria-label="Private feed password"
                    className="w-full h-9 pl-3 pr-9 text-xs font-mono text-[#F5F7FA] bg-[#13161C] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded-md"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPasswordText((v) => !v)}
                    aria-label={showPasswordText ? 'Hide password' : 'Show password'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center text-[#8B95A7] hover:text-[#F5F7FA] cursor-pointer"
                  >
                    {showPasswordText ? (
                      <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                  </button>
                </div>

                {mode === 'manage' && (
                  <button
                    type="button"
                    onClick={() => void handleSavePassword()}
                    disabled={isUpdatingSecurity || passwordDraft.trim().length < 4}
                    className="h-9 px-3.5 inline-flex items-center justify-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                    {isUpdatingSecurity
                      ? 'Saving...'
                      : isPasswordProtected
                        ? 'Update Password'
                        : 'Save Password'}
                  </button>
                )}
              </div>

              {/* Dual authentication mode helper & Signed App Access Key toggle */}
              <div className="pt-2 border-t border-[#1E232D] flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-[11px] text-[#A0AABB]">
                <div className="space-y-0.5">
                  <p className="text-[#D1D5DB] font-medium">
                    Include Signed Access Key in Feed URL (<span className="font-mono text-[#67E8F9]">?key=...</span>)
                  </p>
                  <p className="text-[#8B95A7]">
                    Recommended for podcast apps without a password prompt. When off, apps and browsers prompt for HTTP Basic Auth (username <span className="font-mono text-[#D1D5DB]">dispatch</span> + your password).
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useSignedUrlKey}
                  aria-label="Include signed access key in copied feed URL"
                  onClick={handleToggleSignedUrlKey}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                    useSignedUrlKey ? 'bg-[#22D3EE]' : 'bg-[#2A303C]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-[#071318] transition-transform ${
                      useSignedUrlKey ? 'translate-x-4.5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 3. Private Link Regeneration (only shown once feed exists) */}
        {mode === 'manage' && (
          <div className="pt-3 border-t border-[#1E232D] space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <p className="text-xs font-medium text-[#F5F7FA]">
                  Rotate Private Feed Token
                </p>
                <p className="text-[11px] text-[#8B95A7]">
                  Your feed uses an unguessable token and asks directories not to index it. Regenerate anytime to revoke old links and signed keys.
                </p>
              </div>
              {!confirmRegenerate && (
                <button
                  type="button"
                  onClick={() => setConfirmRegenerate(true)}
                  className="h-8 px-3 text-xs font-medium text-[#FCD34D] bg-[#1F1A10] border border-[#F59E0B]/40 hover:border-[#F59E0B] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Regenerate URL
                </button>
              )}
            </div>

            {confirmRegenerate && (
              <div className="pt-2.5 border-t border-[#262B36] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <p className="text-xs text-[#FDE68A]">
                  This immediately revokes your current RSS URL and signed key. You will need to re-add the new URL in your podcast app.
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setConfirmRegenerate(false)}
                    disabled={isRegenerating}
                    className="h-8 px-3 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRegenerateUrl()}
                    disabled={isRegenerating}
                    className="h-8 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#0B0D10] bg-[#F59E0B] hover:bg-[#FBBF24] disabled:opacity-60 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {isRegenerating && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    )}
                    {isRegenerating ? 'Regenerating...' : 'Confirm Regenerate'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rss-modal-title"
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-[#0F1218] border border-[#22D3EE]/35 rounded-xl shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-5 border-b border-[#1E232D] flex items-start justify-between gap-4 bg-[#13161C]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-[#22D3EE]">
              <Rss className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Private Podcast RSS</span>
            </div>
            <h2
              id="rss-modal-title"
              className="mt-1 font-serif text-2xl font-medium text-[#F5F7FA]"
            >
              {feedConfig ? 'Your Private Podcast Feed' : 'Export Archive as Podcast RSS'}
            </h2>
            <p className="mt-1 text-sm text-[#A0AABB]">
              Listen to your stitched full-edition news briefings inside Apple Podcasts, Overcast, Pocket Casts, or any RSS player.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close RSS export dialog"
            className="h-8 w-8 shrink-0 inline-flex items-center justify-center text-[#8B95A7] hover:text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] hover:border-[#22D3EE]/50 rounded-md transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Status / Error Banners */}
          {errorMessage && (
            <div className="p-3.5 bg-[#2A1418] border border-[#F87171]/40 rounded-lg text-sm text-[#FCA5A5] flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-[#F87171]" aria-hidden="true" />
              <span>{errorMessage}</span>
            </div>
          )}

          {statusNotice && !errorMessage && (
            <div className="p-3.5 bg-[#0D2129] border border-[#22D3EE]/35 rounded-lg text-sm text-[#A5F3FC] flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-[#22D3EE]" aria-hidden="true" />
              <span>{statusNotice}</span>
            </div>
          )}

          {/* Sync Progress Strip */}
          {isSyncing && (
            <div className="p-3.5 bg-[#13161C] border border-[#22D3EE]/30 rounded-lg flex items-center gap-3">
              <Loader2 className="w-4 h-4 text-[#22D3EE] animate-spin shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-[#F5F7FA]">
                  {syncProgress && syncProgress.total > 0
                    ? `Stitching & syncing episode ${Math.min(syncProgress.completed + 1, syncProgress.total)} of ${syncProgress.total}`
                    : 'Synchronizing archived briefings...'}
                </p>
                {syncProgress?.currentTitle && (
                  <p className="text-xs text-[#8B95A7] truncate mt-0.5">
                    {syncProgress.currentTitle}
                  </p>
                )}
              </div>
            </div>
          )}

          {!feedConfig ? (
            /* STATE A: First-Time Private Feed Setup */
            <div className="space-y-5">
              <div className="p-4 bg-[#13161C] border border-[#1E232D] rounded-lg space-y-4">
                <div>
                  <label
                    htmlFor="rss-create-title"
                    className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
                  >
                    Podcast Feed Title
                  </label>
                  <input
                    id="rss-create-title"
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    maxLength={120}
                    placeholder="My Daily Dispatch"
                    className="w-full h-10 px-3.5 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded-md"
                  />
                </div>

                <div>
                  <label
                    htmlFor="rss-create-author"
                    className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
                  >
                    Host / Author Label
                  </label>
                  <input
                    id="rss-create-author"
                    type="text"
                    value={authorDraft}
                    onChange={(e) => setAuthorDraft(e.target.value)}
                    maxLength={100}
                    placeholder="Dispatch Personal Audio"
                    className="w-full h-10 px-3.5 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded-md"
                  />
                </div>

                <div>
                  <label
                    htmlFor="rss-create-description"
                    className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
                  >
                    Feed Description
                  </label>
                  <textarea
                    id="rss-create-description"
                    rows={2}
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    maxLength={600}
                    className="w-full px-3.5 py-2.5 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded-md resize-none"
                  />
                </div>
              </div>

              {/* Security & Access Configuration before Creation */}
              {renderSecurityControls('create')}

              <div className="p-4 bg-[#13161C]/70 border border-[#1E232D] rounded-lg space-y-2 text-xs text-[#A0AABB]">
                <div className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-[#D1D5DB]">
                  <span>{audioCounts.total} archived {audioCounts.total === 1 ? 'edition' : 'editions'}</span>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#22D3EE]">
                    {audioCounts.readyWithAudio} with recorded audio ready
                  </span>
                  {audioCounts.scriptOnly > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-[#8B95A7]">
                        {audioCounts.scriptOnly} script-only (excluded until recorded)
                      </span>
                    </>
                  )}
                </div>
                <p>
                  Each briefing with recorded chapters is stitched into a single continuous episode with formatted show notes, chapter timestamps, and source citations. New briefings sync automatically.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-10 px-4 text-sm font-medium text-[#A0AABB] hover:text-[#F5F7FA] bg-transparent border border-[#262B36] hover:border-[#3A4150] rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreateFeed()}
                  disabled={isCreating || isSyncing}
                  className="h-10 px-5 inline-flex items-center gap-2 text-sm font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-60 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  {isCreating ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Rss className="w-4 h-4" aria-hidden="true" />
                  )}
                  {isCreating ? 'Creating Private Feed...' : 'Create Private RSS Feed'}
                </button>
              </div>
            </div>
          ) : (
            /* STATE B: Active Private Podcast Feed Management */
            <>
              {/* Private Feed URL & Actions */}
              <section className="space-y-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <label
                    htmlFor="private-rss-url-input"
                    className="text-xs font-medium uppercase tracking-wider text-[#A0AABB]"
                  >
                    Private Podcast Feed URL
                  </label>
                  <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
                    {isPasswordProtected && (
                      <span className="text-[#67E8F9]">
                        {signedKeyForUrl ? 'Signed App Key Attached' : 'HTTP Basic Auth URL'}
                      </span>
                    )}
                    <span className="text-[#6E788A]">
                      {episodes.length} live {episodes.length === 1 ? 'episode' : 'episodes'}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    id="private-rss-url-input"
                    type="text"
                    readOnly
                    value={privateFeedUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 h-10 px-3.5 font-mono text-xs text-[#67E8F9] bg-[#0B0D10] border border-[#22D3EE]/35 rounded-md focus:outline-none focus:border-[#22D3EE]"
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleCopyUrl()}
                      className="h-10 px-4 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap cursor-pointer"
                    >
                      {copiedUrl ? (
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      {copiedUrl ? 'Copied URL' : 'Copy URL'}
                    </button>
                    <a
                      href={downloadXmlUrl}
                      download
                      className="h-10 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#E5E7EB] bg-[#13161C] border border-[#262B36] hover:border-[#22D3EE]/50 hover:text-[#67E8F9] rounded-md transition-colors whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" aria-hidden="true" />
                      XML
                    </a>
                    <a
                      href={privateFeedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open raw RSS XML in new tab"
                      className="h-10 w-10 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#67E8F9] bg-[#13161C] border border-[#262B36] hover:border-[#22D3EE]/50 rounded-md transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    </a>
                  </div>
                </div>

                {/* Quick App Subscription Guide */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                  <div className="p-3 bg-[#13161C] border border-[#1E232D] rounded-lg">
                    <p className="text-xs font-medium text-[#F5F7FA]">Apple Podcasts</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-[#8B95A7]">
                      Open Library → tap <span className="font-mono text-[#D1D5DB]">···</span> → Follow a Show by URL → paste link.
                    </p>
                  </div>
                  <div className="p-3 bg-[#13161C] border border-[#1E232D] rounded-lg">
                    <p className="text-xs font-medium text-[#F5F7FA]">Overcast</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-[#8B95A7]">
                      Tap <span className="font-mono text-[#D1D5DB]">+</span> in the top right → Add URL → paste your private RSS feed.
                    </p>
                  </div>
                  <div className="p-3 bg-[#13161C] border border-[#1E232D] rounded-lg">
                    <p className="text-xs font-medium text-[#F5F7FA]">Pocket Casts</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-[#8B95A7]">
                      Open Discover → paste the RSS URL directly into the search bar → Subscribe.
                    </p>
                  </div>
                </div>
              </section>

              {/* Security & Access Section */}
              {renderSecurityControls('manage')}

              {/* Feed Customization & Auto-Sync Controls */}
              <section className="p-4 bg-[#13161C] border border-[#1E232D] rounded-lg space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="rss-edit-title"
                      className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
                    >
                      Custom Podcast Title
                    </label>
                    <input
                      id="rss-edit-title"
                      type="text"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      maxLength={120}
                      className="w-full h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded-md"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="rss-edit-author"
                      className="block text-xs font-medium text-[#D1D5DB] mb-1.5"
                    >
                      Author Label
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="rss-edit-author"
                        type="text"
                        value={authorDraft}
                        onChange={(e) => setAuthorDraft(e.target.value)}
                        maxLength={100}
                        className="flex-1 min-w-0 h-9 px-3 text-sm text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded-md"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSaveTitle()}
                        disabled={isSavingTitle || !hasUnsavedMeta}
                        className="h-9 px-3.5 text-xs font-medium text-[#F5F7FA] bg-[#171C24] border border-[#22D3EE]/40 hover:border-[#22D3EE] hover:text-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                      >
                        {isSavingTitle
                          ? 'Saving...'
                          : titleSavedFlash
                            ? 'Saved'
                            : 'Save'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-[#1E232D] flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={feedConfig.autoSync}
                      aria-label="Toggle automatic archive sync"
                      onClick={handleToggleAutoSync}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                        feedConfig.autoSync ? 'bg-[#22D3EE]' : 'bg-[#2A303C]'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-[#071318] transition-transform ${
                          feedConfig.autoSync ? 'translate-x-4.5' : 'translate-x-1'
                        }`}
                      />
                    </button>
                    <div>
                      <p className="text-xs font-medium text-[#F5F7FA]">
                        Automatic Archive Sync
                      </p>
                      <p className="text-[11px] text-[#8B95A7] font-mono tabular-nums">
                        {feedConfig.lastSyncedAt
                          ? `Last synced ${formatShortDate(feedConfig.lastSyncedAt)}`
                          : 'Waiting for first sync'}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleSyncNow()}
                    disabled={isSyncing}
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#E5E7EB] bg-[#0B0D10] border border-[#262B36] hover:border-[#22D3EE]/50 hover:text-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-[#22D3EE]' : ''}`}
                      aria-hidden="true"
                    />
                    Sync Now
                  </button>
                </div>

                {audioCounts.scriptOnly > 0 && (
                  <p className="text-[11px] text-[#8B95A7] border-t border-[#1E232D] pt-2.5">
                    {audioCounts.scriptOnly} archived{' '}
                    {audioCounts.scriptOnly === 1 ? 'edition has' : 'editions have'} only a
                    written script so far and will appear in this podcast feed automatically once audio is synthesized.
                  </p>
                )}
              </section>

              {/* Published Episodes & Show Notes Inspector */}
              <section className="space-y-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-xs font-medium uppercase tracking-wider text-[#A0AABB]">
                    Published Episodes &amp; Show Notes
                  </h3>
                  <span className="font-mono text-[11px] text-[#6E788A]">
                    Stitched full-edition WAV enclosures
                  </span>
                </div>

                {isLoadingFeed ? (
                  <div className="p-6 bg-[#13161C] border border-[#1E232D] rounded-lg flex items-center justify-center gap-2 text-xs text-[#8B95A7]">
                    <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" aria-hidden="true" />
                    <span>Loading published episodes...</span>
                  </div>
                ) : episodes.length === 0 ? (
                  <div className="p-6 bg-[#13161C] border border-[#1E232D] rounded-lg text-center">
                    <Radio className="w-5 h-5 text-[#6E788A] mx-auto" aria-hidden="true" />
                    <p className="mt-2 text-sm font-medium text-[#F5F7FA]">
                      No recorded audio episodes published yet
                    </p>
                    <p className="mt-1 text-xs text-[#8B95A7] max-w-md mx-auto">
                      Open any edition in Briefing Studio and generate its audio narration. With Automatic Sync on, it will publish here as a stitched episode.
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-[#1E232D] border border-[#1E232D] rounded-lg bg-[#13161C] overflow-hidden">
                    {episodes.map((ep) => {
                      const isExpanded = expandedEpisodeId === ep.briefingId;
                      return (
                        <li key={ep.briefingId} className="p-3.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-[#8B95A7] tabular-nums">
                                <span>{formatShortDate(ep.publishedAt)}</span>
                                <span aria-hidden="true">·</span>
                                <span className="text-[#67E8F9]">
                                  {formatClock(ep.durationSeconds)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>{formatByteSize(ep.byteLength)}</span>
                                <span aria-hidden="true">·</span>
                                <span>
                                  {ep.chapters.length}{' '}
                                  {ep.chapters.length === 1 ? 'chapter' : 'chapters'}
                                </span>
                              </div>
                              <p className="mt-1 font-serif text-base font-medium text-[#F5F7FA]">
                                {ep.title}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedEpisodeId(isExpanded ? null : ep.briefingId)
                              }
                              className="h-8 px-2.5 inline-flex items-center gap-1 text-xs text-[#A0AABB] hover:text-[#67E8F9] bg-[#0B0D10] border border-[#262B36] hover:border-[#22D3EE]/40 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              Show Notes
                              {isExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                              )}
                            </button>
                          </div>

                          {isExpanded && (
                            <div className="mt-3 pt-3 border-t border-[#1E232D] space-y-3 text-xs text-[#C4CCD8]">
                              {ep.subtitle && (
                                <p className="text-[#A0AABB] leading-relaxed">
                                  {ep.subtitle}
                                </p>
                              )}

                              {ep.takeaways.length > 0 && (
                                <div>
                                  <p className="font-mono text-[10px] uppercase tracking-wider text-[#6E788A] mb-1">
                                    Key Takeaways
                                  </p>
                                  <ul className="space-y-1 list-disc list-inside text-[#D1D5DB]">
                                    {ep.takeaways.map((t, idx) => (
                                      <li key={idx}>{t}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {ep.chapters.length > 0 && (
                                <div>
                                  <p className="font-mono text-[10px] uppercase tracking-wider text-[#6E788A] mb-1">
                                    Chapter Timeline
                                  </p>
                                  <ol className="space-y-1.5">
                                    {ep.chapters.map((ch, idx) => (
                                      <li
                                        key={idx}
                                        className="flex items-baseline gap-2"
                                      >
                                        <span className="font-mono text-[11px] text-[#22D3EE] tabular-nums shrink-0">
                                          {formatTimestampMmSs(ch.startSeconds)}
                                        </span>
                                        <span className="text-[#E5E7EB]">
                                          <strong className="font-medium text-[#F5F7FA]">
                                            {ch.title}
                                          </strong>
                                          {ch.keyPoint ? ` — ${ch.keyPoint}` : ''}
                                        </span>
                                      </li>
                                    ))}
                                  </ol>
                                </div>
                              )}

                              {ep.articleTitles.length > 0 && (
                                <div>
                                  <p className="font-mono text-[10px] uppercase tracking-wider text-[#6E788A] mb-1">
                                    Sources Covered
                                  </p>
                                  <p className="text-[#9CA3AF]">
                                    {ep.articleTitles.join(' · ')}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
