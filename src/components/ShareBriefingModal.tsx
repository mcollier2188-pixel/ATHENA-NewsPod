import { useEffect, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Eye,
  Globe,
  Headphones,
  Link2,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import type { AudioBriefing, CreateShareResult, ShareTtlHours } from '../types';
import { createBriefingShare, revokeBriefingShare } from '../services/api';
import {
  removePublicShareFromFirestore,
  syncPublishedBriefingShareToFirestore,
} from '../services/firestorePublicShares';
import { formatClock } from '../utils/wavUtils';
import { useAuth } from '../contexts/AuthContext';

interface ShareBriefingModalProps {
  open: boolean;
  briefing: AudioBriefing;
  onClose: () => void;
  onPreviewShare: (shareId: string) => void;
}

const TTL_OPTIONS: Array<{ hours: ShareTtlHours; label: string; note: string }> = [
  { hours: 24, label: '24 hours', note: 'Quick pass' },
  { hours: 72, label: '3 days', note: 'Default' },
  { hours: 168, label: '7 days', note: 'Weekly' },
];

const SHARE_CACHE_KEY = 'dispatch_active_shares_v1';

function loadCachedShare(briefingId: string): CreateShareResult | null {
  try {
    const raw = sessionStorage.getItem(SHARE_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, CreateShareResult>;
    const found = map[briefingId];
    if (!found) return null;
    if (Date.now() > new Date(found.expiresAt).getTime()) return null;
    return found;
  } catch {
    return null;
  }
}

function saveCachedShare(briefingId: string, share: CreateShareResult | null) {
  try {
    const raw = sessionStorage.getItem(SHARE_CACHE_KEY);
    const map: Record<string, CreateShareResult> = raw ? JSON.parse(raw) : {};
    if (share) {
      map[briefingId] = share;
    } else {
      delete map[briefingId];
    }
    sessionStorage.setItem(SHARE_CACHE_KEY, JSON.stringify(map));
  } catch {
    // Non-fatal storage fallback
  }
}

function formatExpiryLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Temporary link';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function ShareBriefingModal({
  open,
  briefing,
  onClose,
  onPreviewShare,
}: ShareBriefingModalProps) {
  const { user, getIdToken } = useAuth();
  const [ttlHours, setTtlHours] = useState<ShareTtlHours>(72);
  const [shareResult, setShareResult] = useState<CreateShareResult | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCopied(false);
    const cached = loadCachedShare(briefing.id);
    setShareResult(cached);
    if (cached) {
      setTtlHours(cached.ttlHours);
    }
  }, [open, briefing.id]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPublishing && !isRevoking) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isPublishing, isRevoking, onClose]);

  if (!open) return null;

  const recordedCount = briefing.segments.filter((s) => Boolean(s.audioBase64)).length;
  const totalChapters = briefing.segments.length;
  const totalSeconds = briefing.segments.reduce(
    (sum, s) => sum + (s.audioDurationSeconds || s.estimatedSeconds || 60),
    0
  );

  const publicUrl = shareResult
    ? `${window.location.origin}${shareResult.sharePath}`
    : '';

  async function handlePublish() {
    setError(null);
    setCopied(false);
    setIsPublishing(true);
    try {
      const token = user ? await getIdToken() : null;
      const result = await createBriefingShare(briefing, ttlHours, { token });
      await syncPublishedBriefingShareToFirestore({
        callerUser: user,
        shareId: result.shareId,
        sharePath: result.sharePath,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
        ttlHours: result.ttlHours,
        briefing,
      }).catch(() => false);
      setShareResult(result);
      saveCachedShare(briefing.id, result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not create public share link.'
      );
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleCopyLink() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setError('Clipboard copy was blocked by the browser. Select the URL manually.');
    }
  }

  async function handleRevoke() {
    if (!shareResult) return;
    setError(null);
    setIsRevoking(true);
    try {
      const token = user ? await getIdToken() : null;
      await revokeBriefingShare(shareResult.shareId, {
        token,
        manageToken: shareResult.manageToken ?? null,
      });
      await removePublicShareFromFirestore(user, shareResult.shareId).catch(() => {});
      setShareResult(null);
      saveCachedShare(briefing.id, null);
      setCopied(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not revoke this share link.'
      );
    } finally {
      setIsRevoking(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-briefing-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isPublishing && !isRevoking) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-[540px] bg-[#13161C] border border-[#22D3EE]/45 rounded-lg overflow-hidden shadow-2xl">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[#222833] flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <Globe className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
            <h2
              id="share-briefing-title"
              className="font-serif text-lg font-medium text-[#F5F7FA] truncate"
            >
              Share Audio Briefing
            </h2>
          </div>
          <button
            type="button"
            disabled={isPublishing || isRevoking}
            onClick={onClose}
            aria-label="Close share dialog"
            className="w-8 h-8 inline-flex items-center justify-center text-[#8C96A8] hover:text-[#F5F7FA] rounded-md transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Episode Summary Strip */}
          <div className="pb-4 border-b border-[#1F2532]">
            <p className="font-serif text-base font-medium text-[#F5F7FA] leading-snug">
              {briefing.editionTitle}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[#8C96A8] font-mono tabular-nums">
              <span>{formatClock(totalSeconds)} runtime</span>
              <span aria-hidden="true">·</span>
              <span>
                {recordedCount}/{totalChapters}{' '}
                {totalChapters === 1 ? 'chapter' : 'chapters'} recorded
              </span>
              <span aria-hidden="true">·</span>
              <span className="capitalize">
                {briefing.preferences.format === 'podcast' ? 'Podcast' : 'Solo'}
              </span>
            </div>
            {recordedCount === 0 && (
              <p className="mt-2.5 text-xs text-[#FBBF24] leading-relaxed">
                Audio has not been recorded yet. This link will share the takeaways and full script—record chapters first if you want listeners to stream audio.
              </p>
            )}
          </div>

          {!shareResult ? (
            <>
              {/* Link Expiration Selector */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-semibold text-[#F5F7FA]">
                    Link Expiration
                  </span>
                  <span className="text-[11px] font-mono text-[#6E788A]">
                    Auto-deletes after expiry
                  </span>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Link expiration"
                  className="grid grid-cols-3 gap-2"
                >
                  {TTL_OPTIONS.map((opt) => {
                    const active = ttlHours === opt.hours;
                    return (
                      <button
                        key={opt.hours}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setTtlHours(opt.hours)}
                        className={`py-2.5 px-3 text-left rounded-md border transition-colors cursor-pointer ${
                          active
                            ? 'border-[#22D3EE]/70 bg-[#22D3EE]/[0.08]'
                            : 'border-[#222833] bg-[#0E1116] hover:border-[#394457]'
                        }`}
                      >
                        <span
                          className={`block text-xs font-semibold whitespace-nowrap ${
                            active ? 'text-[#67E8F9]' : 'text-[#F5F7FA]'
                          }`}
                        >
                          {opt.label}
                        </span>
                        <span className="block text-[11px] text-[#6E788A] mt-0.5">
                          {opt.note}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <p className="text-xs text-[#8C96A8] leading-relaxed">
                Generates a temporary cloud-hosted page with a streaming audio player, topic timeline, takeaways, and transcript. Anyone with the link can listen—no sign-in required.
              </p>

              <button
                type="button"
                disabled={isPublishing}
                onClick={handlePublish}
                className="w-full h-11 px-5 inline-flex items-center justify-center gap-2 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors cursor-pointer"
              >
                {isPublishing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Publishing temporary episode link...</span>
                  </>
                ) : (
                  <>
                    <Link2 className="w-4 h-4" aria-hidden="true" />
                    <span>Generate Public Link</span>
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              {/* Published Link Box */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-[#67E8F9]">
                    Public link is live
                  </span>
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[#8C96A8] tabular-nums">
                    <Clock className="w-3 h-3 text-[#6E788A]" aria-hidden="true" />
                    Expires {formatExpiryLabel(shareResult.expiresAt)}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <label htmlFor="public-share-url-input" className="sr-only">
                    Public share URL
                  </label>
                  <input
                    id="public-share-url-input"
                    type="text"
                    readOnly
                    value={publicUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 h-10 px-3 font-mono text-xs text-[#E4E9F1] bg-[#0B0D10] border border-[#22D3EE]/50 rounded-md focus:border-[#22D3EE]"
                  />
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="h-10 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        Copy Link
                      </>
                    )}
                  </button>
                </div>

                <div className="flex items-center gap-2 text-[11px] font-mono text-[#8C96A8]">
                  <Headphones className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  <span>
                    {shareResult.hasAudio
                      ? `Streaming audio hosted for ${shareResult.recordedChapters}/${shareResult.totalChapters} chapters`
                      : 'Hosted as script & takeaways (no recorded audio)'}
                  </span>
                </div>
              </div>

              {/* Secondary Actions */}
              <div className="pt-2 border-t border-[#1F2532] flex flex-wrap items-center justify-between gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onPreviewShare(shareResult.shareId);
                  }}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#18212E] hover:bg-[#1E2A3B] border border-[#22D3EE]/45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Eye className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Preview Public Page
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isPublishing || isRevoking}
                    onClick={handlePublish}
                    className="h-9 px-3 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] border border-[#2A3342] hover:border-[#22D3EE]/45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {isPublishing ? 'Refreshing...' : 'Re-publish'}
                  </button>
                  <button
                    type="button"
                    disabled={isRevoking}
                    onClick={handleRevoke}
                    className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#FCA5A5] hover:text-white bg-[#2A1216] border border-[#F87171]/40 hover:border-[#F87171] rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    {isRevoking ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    Revoke Link
                  </button>
                </div>
              </div>
            </>
          )}

          {error && (
            <p
              role="alert"
              className="text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3 py-2.5 leading-relaxed"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
