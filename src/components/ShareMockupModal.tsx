import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  CreateMockupShareResult,
  ShareTtlHours,
  SiteMockupProject,
} from '../types';
import {
  createMockupShare,
  revokeMockupShare,
  updateMockupShare,
} from '../services/api';
import {
  removePublicShareFromFirestore,
  syncPublishedMockupShareToFirestore,
} from '../services/firestorePublicShares';
import { formatStorageKb } from '../utils/imageUpload';
import { useAuth } from '../contexts/AuthContext';

interface ShareMockupModalProps {
  isOpen: boolean;
  project: SiteMockupProject;
  onClose: () => void;
  onOpenPreview: (shareId: string) => void;
}

interface StoredActiveShare extends CreateMockupShareResult {
  brandName: string;
  note: string;
  syncedAt?: string;
}

const STORAGE_ACTIVE_SHARES_KEY = 'dispatch_mockup_active_shares_v1';

const TTL_OPTIONS: Array<{ value: ShareTtlHours; label: string }> = [
  { value: 24, label: '24 hours' },
  { value: 72, label: '3 days' },
  { value: 168, label: '7 days' },
];

function loadActiveShares(): StoredActiveShare[] {
  try {
    const raw = localStorage.getItem(STORAGE_ACTIVE_SHARES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredActiveShare[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (s) => s?.shareId && s?.expiresAt && new Date(s.expiresAt).getTime() > now
    );
  } catch {
    return [];
  }
}

function saveActiveShares(items: StoredActiveShare[]) {
  try {
    localStorage.setItem(STORAGE_ACTIVE_SHARES_KEY, JSON.stringify(items.slice(0, 6)));
  } catch {
    // Ignore storage quota errors
  }
}

export function ShareMockupModal({
  isOpen,
  project,
  onClose,
  onOpenPreview,
}: ShareMockupModalProps) {
  const { user, getIdToken } = useAuth();
  const [ttlHours, setTtlHours] = useState<ShareTtlHours>(72);
  const [note, setNote] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [activeShares, setActiveShares] = useState<StoredActiveShare[]>(() =>
    loadActiveShares()
  );
  const [selectedShareId, setSelectedShareId] = useState<string | null>(() => {
    const existing = loadActiveShares();
    return existing[0]?.shareId ?? null;
  });
  const [showCreateForm, setShowCreateForm] = useState<boolean>(
    () => loadActiveShares().length === 0
  );
  const [copiedMode, setCopiedMode] = useState<'url' | 'sms' | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const fresh = loadActiveShares();
    setActiveShares(fresh);
    setError(null);
    setSyncNotice(null);
    if (fresh.length === 0) {
      setSelectedShareId(null);
      setShowCreateForm(true);
    } else if (!selectedShareId || !fresh.some((s) => s.shareId === selectedShareId)) {
      setSelectedShareId(fresh[0].shareId);
      setShowCreateForm(false);
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, selectedShareId]);

  const shareableProject = useMemo<SiteMockupProject>(() => {
    const { mediaCollection: _unusedCollection, ...rest } = project;
    return rest;
  }, [project]);

  const snapshotMetrics = useMemo(() => {
    const serializedKb = Math.max(
      1,
      Math.round(new Blob([JSON.stringify(shareableProject)]).size / 1024)
    );
    const photoCount =
      (shareableProject.brand.logoDataUrl ? 1 : 0) +
      (shareableProject.hero.photoDataUrl ? 1 : 0) +
      shareableProject.projects.filter((p) => Boolean(p.photoDataUrl)).length;
    return {
      serializedKb,
      photoCount,
      servicesCount: shareableProject.services.length,
    };
  }, [shareableProject]);

  if (!isOpen) return null;

  const activeShare =
    !showCreateForm && selectedShareId
      ? activeShares.find((s) => s.shareId === selectedShareId) ?? null
      : null;

  const fullShareUrl = activeShare
    ? `${window.location.origin}${activeShare.sharePath}`
    : '';

  async function handleCreate() {
    setError(null);
    setSyncNotice(null);
    setIsCreating(true);
    try {
      const token = user ? await getIdToken() : null;
      const res = await createMockupShare(shareableProject, ttlHours, note.trim(), {
        token,
      });
      await syncPublishedMockupShareToFirestore({
        callerUser: user,
        shareId: res.shareId,
        sharePath: res.sharePath,
        createdAt: res.createdAt,
        expiresAt: res.expiresAt,
        ttlHours: res.ttlHours,
        note: note.trim(),
        project: shareableProject,
      }).catch(() => false);
      const entry: StoredActiveShare = {
        ...res,
        brandName: shareableProject.brand.name,
        note: note.trim(),
        syncedAt: res.createdAt,
      };
      const next = [entry, ...activeShares.filter((s) => s.shareId !== res.shareId)];
      setActiveShares(next);
      saveActiveShares(next);
      setSelectedShareId(res.shareId);
      setShowCreateForm(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not publish mockup preview link.'
      );
    } finally {
      setIsCreating(false);
    }
  }

  async function handleSyncLatestEdits() {
    if (!activeShare) return;
    setError(null);
    setSyncNotice(null);
    setIsSyncing(true);
    try {
      const token = user ? await getIdToken() : null;
      const updated = await updateMockupShare(
        activeShare.shareId,
        shareableProject,
        activeShare.ttlHours,
        activeShare.note,
        {
          token,
          manageToken: activeShare.manageToken ?? null,
        }
      );
      await syncPublishedMockupShareToFirestore({
        callerUser: user,
        shareId: activeShare.shareId,
        sharePath: activeShare.sharePath,
        createdAt: activeShare.createdAt,
        expiresAt: updated.expiresAt,
        ttlHours: activeShare.ttlHours,
        note: activeShare.note,
        project: shareableProject,
        isUpdate: true,
      }).catch(() => false);
      const next = activeShares.map((item) =>
        item.shareId === activeShare.shareId
          ? {
              ...item,
              brandName: project.brand.name,
              expiresAt: updated.expiresAt,
              syncedAt: updated.updatedAt || new Date().toISOString(),
            }
          : item
      );
      setActiveShares(next);
      saveActiveShares(next);
      setSyncNotice('Updated live link with your latest edits — same URL stays active.');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not sync edits to this link. Create a fresh preview link instead.'
      );
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleCopyUrl() {
    if (!fullShareUrl) return;
    try {
      await navigator.clipboard.writeText(fullShareUrl);
      setCopiedMode('url');
      setTimeout(() => setCopiedMode(null), 2000);
    } catch {
      setError('Could not copy automatically — select the URL field to copy.');
    }
  }

  async function handleCopyClientMessage() {
    if (!fullShareUrl || !activeShare) return;
    const message = [
      `Put together a draft website mockup for ${project.brand.name} — have a look here:`,
      fullShareUrl,
      activeShare.note ? `Note: ${activeShare.note}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await navigator.clipboard.writeText(message);
      setCopiedMode('sms');
      setTimeout(() => setCopiedMode(null), 2200);
    } catch {
      setError('Could not copy message automatically.');
    }
  }

  async function handleRevoke() {
    if (!activeShare) return;
    setIsRevoking(true);
    setError(null);
    setSyncNotice(null);
    try {
      const token = user ? await getIdToken() : null;
      await revokeMockupShare(activeShare.shareId, {
        token,
        manageToken: activeShare.manageToken ?? null,
      });
      await removePublicShareFromFirestore(user, activeShare.shareId).catch(() => {});
      const remaining = activeShares.filter((s) => s.shareId !== activeShare.shareId);
      setActiveShares(remaining);
      saveActiveShares(remaining);
      if (remaining.length > 0) {
        setSelectedShareId(remaining[0].shareId);
      } else {
        setSelectedShareId(null);
        setShowCreateForm(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke preview link.');
    } finally {
      setIsRevoking(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-mockup-title"
    >
      <div className="w-full max-w-lg bg-[#13161C] border border-[#22D3EE]/45 rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-[#1F2532]">
          <div className="flex items-center gap-2 min-w-0">
            <Share2 className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
            <h2
              id="share-mockup-title"
              className="text-base font-semibold text-[#F5F7FA] truncate"
            >
              Share Mockup
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share dialog"
            className="w-8 h-8 inline-flex items-center justify-center text-[#8C96A8] hover:text-[#F5F7FA] rounded cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Serialized Snapshot Metadata (unboxed clean text) */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1F2532] text-xs">
            <span className="font-semibold text-[#F5F7FA] truncate">
              {project.brand.name}
            </span>
            <span className="font-mono text-[11px] text-[#8C96A8] tabular-nums">
              {snapshotMetrics.servicesCount} services · {snapshotMetrics.photoCount}{' '}
              {snapshotMetrics.photoCount === 1 ? 'image' : 'images'} ·{' '}
              {formatStorageKb(snapshotMetrics.serializedKb)}
            </span>
          </div>

          {/* Active Links Switcher (if multiple links exist) */}
          {activeShares.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 overflow-x-auto">
                {activeShares.map((item, idx) => {
                  const selected = !showCreateForm && selectedShareId === item.shareId;
                  return (
                    <button
                      key={item.shareId}
                      type="button"
                      onClick={() => {
                        setSelectedShareId(item.shareId);
                        setShowCreateForm(false);
                        setError(null);
                        setSyncNotice(null);
                      }}
                      className={`h-7 px-2.5 text-[11px] font-medium rounded border whitespace-nowrap cursor-pointer ${
                        selected
                          ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]/55'
                          : 'bg-[#0B0D10] text-[#8C96A8] border-[#222833] hover:text-[#F5F7FA]'
                      }`}
                    >
                      Link #{activeShares.length - idx}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowCreateForm((v) => !v);
                  setError(null);
                  setSyncNotice(null);
                }}
                className="h-7 px-2 inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3 h-3" aria-hidden="true" />
                {showCreateForm ? 'View Active Link' : 'New Link'}
              </button>
            </div>
          )}

          {showCreateForm || !activeShare ? (
            <>
              <p className="text-xs text-[#A0AABB] leading-relaxed">
                Serializes your current mockup—including brand colours, copy, logo, and compressed site photos—into a temporary hosted URL your client can open remotely on any phone or desktop.
              </p>

              <div>
                <span className="block text-xs font-semibold text-[#F5F7FA] mb-1.5">
                  Link Expiration
                </span>
                <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0B0D10] border border-[#222833] rounded-md">
                  {TTL_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setTtlHours(opt.value)}
                      className={`h-8 text-xs font-medium rounded transition-colors cursor-pointer ${
                        ttlHours === opt.value
                          ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                          : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label
                  htmlFor="share-mockup-note"
                  className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
                >
                  Optional Note for Client
                </label>
                <textarea
                  id="share-mockup-note"
                  rows={2}
                  maxLength={280}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g., Draft v2 with your real brand navy & amber — let me know if the services look right"
                  className="w-full p-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded-md placeholder:text-[#6E788A]"
                />
              </div>

              {error && (
                <p role="alert" className="text-xs text-[#FCA5A5]">
                  {error}
                </p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 px-3.5 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] rounded-md cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isCreating}
                  onClick={handleCreate}
                  className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md whitespace-nowrap cursor-pointer"
                >
                  {isCreating ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      Publishing...
                    </>
                  ) : (
                    <>
                      <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                      Create Hosted Link
                    </>
                  )}
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="p-3 bg-[#0B0D10] border border-[#22D3EE]/40 rounded-md space-y-2.5">
                <div className="flex items-center justify-between text-[11px] text-[#8C96A8]">
                  <span className="font-medium text-[#67E8F9]">
                    Hosted preview URL active
                  </span>
                  <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                    <Clock className="w-3 h-3" aria-hidden="true" />
                    Expires {new Date(activeShare.expiresAt).toLocaleDateString()}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={fullShareUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Shareable mockup preview URL"
                    className="flex-1 min-w-0 h-9 px-2.5 font-mono text-xs text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] rounded"
                  />
                  <button
                    type="button"
                    onClick={handleCopyUrl}
                    className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded whitespace-nowrap cursor-pointer"
                  >
                    {copiedMode === 'url' ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copy URL
                      </>
                    )}
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={handleCopyClientMessage}
                    className="h-7 px-2.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded whitespace-nowrap cursor-pointer"
                  >
                    {copiedMode === 'sms' ? (
                      <>
                        <Check className="w-3 h-3 text-[#34D399]" />
                        Message Copied
                      </>
                    ) : (
                      <>
                        <MessageSquare className="w-3 h-3 text-[#22D3EE]" />
                        Copy SMS / WhatsApp Text
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={isSyncing}
                    onClick={handleSyncLatestEdits}
                    className="h-7 px-2.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/45 hover:border-[#22D3EE] disabled:opacity-50 rounded whitespace-nowrap cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    {isSyncing ? 'Syncing...' : 'Sync Latest Edits'}
                  </button>
                </div>
              </div>

              {syncNotice && (
                <p className="text-xs text-[#34D399]">{syncNotice}</p>
              )}

              {error && (
                <p role="alert" className="text-xs text-[#FCA5A5]">
                  {error}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  disabled={isRevoking}
                  onClick={handleRevoke}
                  className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#FCA5A5] hover:text-white border border-[#FCA5A5]/30 hover:border-[#FCA5A5]/60 rounded cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  {isRevoking ? 'Revoking...' : 'Revoke Link'}
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenPreview(activeShare.shareId);
                    }}
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/45 rounded whitespace-nowrap cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                    Open Preview
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="h-8 px-3 text-xs font-medium text-[#D5DCE6] bg-[#1D2330] hover:bg-[#252D3D] rounded cursor-pointer"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
