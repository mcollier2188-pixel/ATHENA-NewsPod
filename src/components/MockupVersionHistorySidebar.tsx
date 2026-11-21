import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Bookmark,
  Check,
  Cloud,
  History,
  Layers,
  Loader2,
  PenLine,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import type { MockupSnapshot, SiteMockupProject } from '../types';
import type { DbSavedMockupSummary } from '../services/suiteApi';

interface MockupVersionHistorySidebarProps {
  project: SiteMockupProject;
  activeContentHash: string;
  isAuthenticated: boolean;
  cloudVersions: DbSavedMockupSummary[];
  localSnapshots: MockupSnapshot[];
  isLoadingCloud: boolean;
  isSavingVersion: boolean;
  revertingVersionId: number | null;
  errorMessage: string | null;
  revertFeedback: {
    restoredLabel: string;
    canUndo: boolean;
  } | null;
  onSignIn: () => void;
  onRefreshCloud: () => void;
  onSaveVersion: (input: { label: string; changeNote: string }) => Promise<void>;
  onRevertCloudVersion: (row: DbSavedMockupSummary) => Promise<void>;
  onUpdateCloudVersionMeta: (
    id: number,
    input: { label: string; changeNote: string }
  ) => Promise<void>;
  onDeleteCloudVersion: (id: number) => Promise<void>;
  onRevertLocalSnapshot: (snapshot: MockupSnapshot) => void;
  onDeleteLocalSnapshot: (id: string) => void;
  onUndoRevert: () => void;
  onDismissRevertFeedback: () => void;
  onSwitchToLayers?: () => void;
  onClose: () => void;
}

function formatVersionTimestamp(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'Saved';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function MockupVersionHistorySidebar({
  project,
  activeContentHash,
  isAuthenticated,
  cloudVersions,
  localSnapshots,
  isLoadingCloud,
  isSavingVersion,
  revertingVersionId,
  errorMessage,
  revertFeedback,
  onSignIn,
  onRefreshCloud,
  onSaveVersion,
  onRevertCloudVersion,
  onUpdateCloudVersionMeta,
  onDeleteCloudVersion,
  onRevertLocalSnapshot,
  onDeleteLocalSnapshot,
  onUndoRevert,
  onDismissRevertFeedback,
  onSwitchToLayers,
  onClose,
}: MockupVersionHistorySidebarProps) {
  const [storageView, setStorageView] = useState<'cloud' | 'local'>('cloud');
  const [labelInput, setLabelInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Inline metadata edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editNote, setEditNote] = useState('');
  const [isUpdatingMeta, setIsUpdatingMeta] = useState(false);

  // Two-step delete confirmation state
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const nextVersionNumber = useMemo(() => {
    if (cloudVersions.length === 0) return 1;
    return Math.max(...cloudVersions.map((v) => v.versionNumber || 1)) + 1;
  }, [cloudVersions]);

  const matchingCloudVersion = useMemo(() => {
    if (!activeContentHash) return null;
    return cloudVersions.find((v) => v.contentHash && v.contentHash === activeContentHash) ?? null;
  }, [activeContentHash, cloudVersions]);

  const latestCloudVersion = cloudVersions[0] ?? null;

  const filteredCloudVersions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return cloudVersions;
    return cloudVersions.filter((row) => {
      const versionTag = `v${row.versionNumber}`;
      return (
        versionTag.includes(q) ||
        row.label.toLowerCase().includes(q) ||
        (row.changeNote || '').toLowerCase().includes(q) ||
        (row.brandName || '').toLowerCase().includes(q) ||
        (row.headlinePreview || '').toLowerCase().includes(q) ||
        (row.sourceUrl || '').toLowerCase().includes(q)
      );
    });
  }, [cloudVersions, searchQuery]);

  async function handleSubmitSave(e: FormEvent) {
    e.preventDefault();
    const cleanLabel = labelInput.trim();
    const cleanNote = noteInput.trim();
    await onSaveVersion({
      label: cleanLabel,
      changeNote: cleanNote,
    });
    setLabelInput('');
    setNoteInput('');
  }

  function startEditingRow(row: DbSavedMockupSummary) {
    setConfirmDeleteId(null);
    setEditingId(row.id);
    setEditLabel(row.label);
    setEditNote(row.changeNote || '');
  }

  async function handleSaveMetaEdit(e: FormEvent, id: number) {
    e.preventDefault();
    if (!editLabel.trim()) return;
    setIsUpdatingMeta(true);
    try {
      await onUpdateCloudVersionMeta(id, {
        label: editLabel.trim(),
        changeNote: editNote.trim(),
      });
      setEditingId(null);
    } finally {
      setIsUpdatingMeta(false);
    }
  }

  async function handleConfirmDelete(id: number) {
    setDeletingId(id);
    try {
      await onDeleteCloudVersion(id);
      setConfirmDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  }

  const defaultLabelPlaceholder = `${(project.brand.name || 'Mockup').slice(0, 20)} · v${
    isAuthenticated ? nextVersionNumber : localSnapshots.length + 1
  }`;

  return (
    <aside
      aria-label="Mockup version history"
      className="w-full lg:w-[304px] xl:w-[324px] shrink-0 bg-[#101319] border-t lg:border-t-0 lg:border-l border-[#222833] flex flex-col"
    >
      {/* Sidebar Header */}
      <div className="px-3.5 py-3 border-b border-[#1F2532] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <History className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-[#F5F7FA] leading-tight">
              Version History
            </h2>
            <p className="font-mono text-[10px] text-[#8C96A8] tabular-nums mt-0.5 truncate">
              {isAuthenticated ? (
                <>
                  {cloudVersions.length}{' '}
                  {cloudVersions.length === 1 ? 'iteration' : 'iterations'}
                  {matchingCloudVersion
                    ? ` · Active v${matchingCloudVersion.versionNumber}`
                    : latestCloudVersion
                      ? ` · Edited since v${latestCloudVersion.versionNumber}`
                      : ''}
                </>
              ) : (
                `${localSnapshots.length} session ${
                  localSnapshots.length === 1 ? 'draft' : 'drafts'
                }`
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onSwitchToLayers && (
            <button
              type="button"
              onClick={onSwitchToLayers}
              title="Switch to canvas layer manager"
              aria-label="Switch to canvas layer manager"
              className="h-7 px-2 inline-flex items-center gap-1 rounded text-[11px] font-medium text-[#8C96A8] hover:text-[#F5F7FA] hover:bg-[#18212E] transition-colors whitespace-nowrap cursor-pointer"
            >
              <Layers className="w-3 h-3" aria-hidden="true" />
              Layers
            </button>
          )}
          {isAuthenticated && (
            <button
              type="button"
              disabled={isLoadingCloud}
              onClick={onRefreshCloud}
              aria-label="Refresh saved versions"
              title="Refresh saved versions"
              className="w-7 h-7 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#67E8F9] hover:bg-[#18212E] disabled:opacity-40 transition-colors cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoadingCloud ? 'animate-spin text-[#22D3EE]' : ''}`}
              />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide version history sidebar"
            title="Hide version history sidebar"
            className="w-7 h-7 inline-flex items-center justify-center rounded text-[#8C96A8] hover:text-[#F5F7FA] hover:bg-[#18212E] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Save Current Iteration Dock */}
      <form
        onSubmit={(e) => void handleSubmitSave(e)}
        className="p-3.5 border-b border-[#1F2532] bg-[#0D1016] space-y-2"
      >
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="version-label-input"
            className="text-[11px] font-semibold text-[#E4E9F1]"
          >
            Save Current Iteration
          </label>
          {isAuthenticated && matchingCloudVersion ? (
            <span className="font-mono text-[10px] text-[#34D399] tabular-nums">
              Matches v{matchingCloudVersion.versionNumber}
            </span>
          ) : isAuthenticated && latestCloudVersion ? (
            <span className="font-mono text-[10px] text-[#F59E0B] tabular-nums">
              Modified
            </span>
          ) : null}
        </div>

        <input
          id="version-label-input"
          type="text"
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          placeholder={defaultLabelPlaceholder}
          maxLength={120}
          className="w-full h-8 px-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#2A3342] focus:border-[#22D3EE] rounded placeholder:text-[#6E788A]"
        />

        <input
          type="text"
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
          placeholder="Change note (optional, e.g. Dark hero + new CTA)"
          maxLength={240}
          aria-label="Optional version change note"
          className="w-full h-8 px-2.5 text-[11px] text-[#D5DCE6] bg-[#0B0D10] border border-[#222833] focus:border-[#22D3EE] rounded placeholder:text-[#6E788A]"
        />

        <button
          type="submit"
          disabled={isSavingVersion}
          className="w-full h-8 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {isSavingVersion ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              Saving iteration...
            </>
          ) : (
            <>
              <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
              {isAuthenticated
                ? `Save Iteration (v${nextVersionNumber})`
                : 'Save Session Draft'}
            </>
          )}
        </button>
      </form>

      {/* Reverted State Undo Safety Banner */}
      {revertFeedback && (
        <div
          role="status"
          aria-live="polite"
          className="px-3.5 py-2.5 border-b border-[#22D3EE]/35 bg-[#121D28] flex items-center justify-between gap-2"
        >
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-[#E4E9F1] truncate">
              Reverted to {revertFeedback.restoredLabel}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {revertFeedback.canUndo && (
              <button
                type="button"
                onClick={onUndoRevert}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#67E8F9] hover:underline whitespace-nowrap cursor-pointer"
              >
                <Undo2 className="w-3 h-3" aria-hidden="true" />
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={onDismissRevertFeedback}
              aria-label="Dismiss revert notice"
              className="text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* Storage Switcher (Cloud Iterations vs Local Session Drafts) */}
      {(localSnapshots.length > 0 || !isAuthenticated) && (
        <div className="px-3.5 pt-2.5">
          <div className="grid grid-cols-2 gap-1 p-0.5 bg-[#0B0D10] border border-[#1F2532] rounded-md">
            <button
              type="button"
              onClick={() => setStorageView('cloud')}
              className={`h-7 inline-flex items-center justify-center gap-1.5 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                storageView === 'cloud'
                  ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/45'
                  : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
              }`}
            >
              <Cloud className="w-3 h-3" aria-hidden="true" />
              Cloud ({cloudVersions.length})
            </button>
            <button
              type="button"
              onClick={() => setStorageView('local')}
              className={`h-7 inline-flex items-center justify-center gap-1.5 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                storageView === 'local'
                  ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/45'
                  : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
              }`}
            >
              Session ({localSnapshots.length})
            </button>
          </div>
        </div>
      )}

      {/* Localized Error Banner */}
      {errorMessage && (
        <div
          role="alert"
          className="mx-3.5 mt-2.5 p-2.5 bg-red-950/45 border border-red-400/35 rounded-md flex items-start justify-between gap-2"
        >
          <div className="flex items-start gap-1.5 min-w-0">
            <AlertTriangle
              className="w-3.5 h-3.5 text-[#FCA5A5] shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <p className="text-[11px] text-red-200 leading-snug">{errorMessage}</p>
          </div>
          {isAuthenticated && (
            <button
              type="button"
              onClick={onRefreshCloud}
              className="text-[11px] font-semibold text-[#FCA5A5] hover:text-white underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Search Filter when 3+ Cloud Versions exist */}
      {storageView === 'cloud' && isAuthenticated && cloudVersions.length >= 3 && (
        <div className="px-3.5 pt-2.5">
          <div className="relative">
            <Search
              className="w-3.5 h-3.5 text-[#6E788A] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter versions, notes, or brands..."
              aria-label="Filter saved versions"
              className="w-full h-8 pl-8 pr-2.5 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#222833] focus:border-[#22D3EE] rounded placeholder:text-[#6E788A]"
            />
          </div>
        </div>
      )}

      {/* Scrollable Version List */}
      <div className="p-3.5 space-y-2.5 overflow-y-auto lg:max-h-[calc(100vh-20rem)] flex-1">
        {storageView === 'cloud' ? (
          !isAuthenticated ? (
            <div className="p-4 bg-[#0B0D10] border border-[#1F2532] rounded-md space-y-3">
              <div className="space-y-1">
                <p className="text-xs font-semibold text-[#F5F7FA]">
                  Sign in to store version history
                </p>
                <p className="text-[11px] text-[#8C96A8] leading-relaxed">
                  Save named mockup iterations to your account database so you can compare palettes, headlines, and layouts or revert anytime.
                </p>
              </div>
              <button
                type="button"
                onClick={onSignIn}
                className="w-full h-8 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded transition-colors whitespace-nowrap cursor-pointer"
              >
                <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
                Sign in with Google
              </button>
            </div>
          ) : isLoadingCloud && cloudVersions.length === 0 ? (
            <div className="space-y-2" aria-busy="true" aria-label="Loading saved versions">
              {[0, 1, 2].map((idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-md bg-[#0B0D10] border border-[#1F2532] space-y-2 animate-pulse"
                >
                  <div className="h-2.5 w-24 bg-[#1C222E] rounded" />
                  <div className="h-3.5 w-40 bg-[#1C222E] rounded" />
                  <div className="h-2.5 w-full bg-[#161B24] rounded" />
                </div>
              ))}
            </div>
          ) : cloudVersions.length === 0 ? (
            <div className="p-4 bg-[#0B0D10] border border-[#1F2532] rounded-md space-y-2.5">
              <p className="text-xs font-semibold text-[#E4E9F1]">
                No saved iterations yet
              </p>
              <p className="text-[11px] text-[#8C96A8] leading-relaxed">
                Capture your first milestone above before experimenting with new brand colours, font pairings, or AI copy rewrites.
              </p>
            </div>
          ) : filteredCloudVersions.length === 0 ? (
            <div className="p-4 bg-[#0B0D10] border border-[#1F2532] rounded-md space-y-2 text-center">
              <p className="text-xs text-[#8C96A8]">
                No iterations match &ldquo;{searchQuery.trim()}&rdquo;.
              </p>
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-[11px] font-medium text-[#67E8F9] hover:underline cursor-pointer"
              >
                Clear filter
              </button>
            </div>
          ) : (
            <ol className="space-y-2" aria-label="Saved mockup iterations">
              {filteredCloudVersions.map((row) => {
                const isCurrent =
                  Boolean(activeContentHash) &&
                  Boolean(row.contentHash) &&
                  row.contentHash === activeContentHash;
                const isRevertingThis = revertingVersionId === row.id;
                const isEditingThis = editingId === row.id;
                const isConfirmingDelete = confirmDeleteId === row.id;
                const isDeletingThis = deletingId === row.id;

                return (
                  <li
                    key={row.id}
                    className={`p-3 rounded-md border transition-colors ${
                      isCurrent
                        ? 'bg-[#111B24] border-[#22D3EE]/60'
                        : 'bg-[#0B0D10] border-[#1F2532] hover:border-[#2A3342]'
                    }`}
                  >
                    {/* Metadata Line: vN · Timestamp · Current */}
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono text-[10px] text-[#8C96A8] tabular-nums truncate">
                        <span className="font-semibold text-[#67E8F9]">
                          v{row.versionNumber || 1}
                        </span>
                        {' · '}
                        {formatVersionTimestamp(row.updatedAt)}
                        {isCurrent && (
                          <>
                            {' · '}
                            <span className="text-[#34D399] font-semibold">Current</span>
                          </>
                        )}
                      </p>

                      {!isEditingThis && (
                        <button
                          type="button"
                          onClick={() => startEditingRow(row)}
                          aria-label={`Edit label or note for ${row.label}`}
                          title="Rename or edit note"
                          className="p-1 text-[#6E788A] hover:text-[#F5F7FA] rounded transition-colors cursor-pointer shrink-0"
                        >
                          <PenLine className="w-3 h-3" />
                        </button>
                      )}
                    </div>

                    {isEditingThis ? (
                      <form
                        onSubmit={(e) => void handleSaveMetaEdit(e, row.id)}
                        className="mt-2 space-y-1.5"
                      >
                        <input
                          type="text"
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          maxLength={120}
                          aria-label="Version label"
                          className="w-full h-7 px-2 text-xs text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/60 rounded"
                        />
                        <input
                          type="text"
                          value={editNote}
                          onChange={(e) => setEditNote(e.target.value)}
                          maxLength={240}
                          placeholder="Change note (optional)"
                          aria-label="Version change note"
                          className="w-full h-7 px-2 text-[11px] text-[#D5DCE6] bg-[#13161C] border border-[#2A3342] rounded"
                        />
                        <div className="flex items-center justify-end gap-1.5 pt-0.5">
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="h-6 px-2 text-[11px] text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            disabled={isUpdatingMeta || !editLabel.trim()}
                            className="h-6 px-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded whitespace-nowrap cursor-pointer"
                          >
                            {isUpdatingMeta ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        {/* Iteration Label */}
                        <p className="mt-1 text-xs font-semibold text-[#F5F7FA] leading-snug break-words">
                          {row.label}
                        </p>

                        {/* Brand & Palette Summary Strip */}
                        <div className="mt-1.5 flex items-center gap-2 min-w-0 text-[11px] text-[#A0AABB]">
                          <span
                            className="w-3.5 h-3.5 rounded-xs overflow-hidden inline-flex border border-white/15 shrink-0"
                            aria-hidden="true"
                          >
                            <span
                              className="w-1/2 h-full"
                              style={{ backgroundColor: row.primaryColor || '#1E3A5F' }}
                            />
                            <span
                              className="w-1/2 h-full"
                              style={{ backgroundColor: row.accentColor || '#22D3EE' }}
                            />
                          </span>
                          <span className="truncate font-mono text-[10px] tabular-nums text-[#8C96A8]">
                            {row.brandName || 'Untitled Brand'}
                            {' · '}
                            {row.canvasMode === 'dark' ? 'Dark' : 'Light'}
                            {row.assetCount > 0
                              ? ` · ${row.assetCount} ${
                                  row.assetCount === 1 ? 'asset' : 'assets'
                                }`
                              : ''}
                          </span>
                        </div>

                        {/* Change Note or Headline Excerpt */}
                        {(row.changeNote || row.headlinePreview) && (
                          <p className="mt-1.5 text-[11px] text-[#8C96A8] leading-relaxed line-clamp-2">
                            {row.changeNote || row.headlinePreview}
                          </p>
                        )}

                        {/* Action Bar */}
                        <div className="mt-2.5 pt-2 border-t border-[#1A202C] flex items-center justify-between gap-2">
                          {isConfirmingDelete ? (
                            <div className="flex items-center justify-between w-full gap-2">
                              <span className="text-[11px] text-[#FCA5A5]">
                                Delete v{row.versionNumber}?
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="h-6 px-2 text-[11px] text-[#8C96A8] hover:text-[#F5F7FA] whitespace-nowrap cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={isDeletingThis}
                                  onClick={() => void handleConfirmDelete(row.id)}
                                  className="h-6 px-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded whitespace-nowrap cursor-pointer"
                                >
                                  {isDeletingThis ? 'Deleting...' : 'Delete'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={isCurrent || revertingVersionId !== null}
                                onClick={() => void onRevertCloudVersion(row)}
                                className={`h-7 px-2.5 inline-flex items-center gap-1.5 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                  isCurrent
                                    ? 'bg-[#12221F] text-[#34D399] border border-[#34D399]/35 cursor-default'
                                    : 'bg-[#161D28] text-[#F5F7FA] hover:text-[#67E8F9] border border-[#2A3342] hover:border-[#22D3EE]/55 disabled:opacity-50'
                                }`}
                              >
                                {isRevertingThis ? (
                                  <>
                                    <Loader2
                                      className="w-3 h-3 animate-spin text-[#22D3EE]"
                                      aria-hidden="true"
                                    />
                                    Reverting...
                                  </>
                                ) : isCurrent ? (
                                  <>
                                    <Check className="w-3 h-3" aria-hidden="true" />
                                    Active Canvas
                                  </>
                                ) : (
                                  <>
                                    <RotateCcw
                                      className="w-3 h-3 text-[#22D3EE]"
                                      aria-hidden="true"
                                    />
                                    Revert to v{row.versionNumber || 1}
                                  </>
                                )}
                              </button>

                              <button
                                type="button"
                                aria-label={`Delete version ${row.label}`}
                                title="Delete version"
                                onClick={() => {
                                  setEditingId(null);
                                  setConfirmDeleteId(row.id);
                                }}
                                className="w-7 h-7 inline-flex items-center justify-center rounded text-[#6E788A] hover:text-[#FCA5A5] hover:bg-[#1E1418] transition-colors shrink-0 cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          )
        ) : localSnapshots.length === 0 ? (
          <div className="p-4 bg-[#0B0D10] border border-[#1F2532] rounded-md space-y-1.5">
            <p className="text-xs font-semibold text-[#E4E9F1]">
              No local session drafts
            </p>
            <p className="text-[11px] text-[#8C96A8] leading-relaxed">
              Quick drafts saved in this browser appear here for offline comparison.
            </p>
          </div>
        ) : (
          <ol className="space-y-2" aria-label="Local browser snapshots">
            {localSnapshots.map((snap, idx) => (
              <li
                key={snap.id}
                className="p-3 rounded-md bg-[#0B0D10] border border-[#1F2532] hover:border-[#2A3342] transition-colors"
              >
                <p className="font-mono text-[10px] text-[#8C96A8] tabular-nums">
                  Draft #{localSnapshots.length - idx} · {formatVersionTimestamp(snap.savedAt)}
                </p>
                <p className="mt-1 text-xs font-semibold text-[#F5F7FA] truncate">
                  {snap.label}
                </p>
                <p className="mt-1 text-[11px] font-mono text-[#8C96A8] truncate">
                  {snap.project.brand?.name || 'Mockup'} ·{' '}
                  {snap.project.brand?.palette?.canvasMode === 'dark' ? 'Dark' : 'Light'}
                </p>
                <div className="mt-2.5 pt-2 border-t border-[#1A202C] flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onRevertLocalSnapshot(snap)}
                    className="h-7 px-2.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#F5F7FA] hover:text-[#67E8F9] bg-[#161D28] border border-[#2A3342] hover:border-[#22D3EE]/55 rounded transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                    Revert Draft
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete local draft ${snap.label}`}
                    onClick={() => onDeleteLocalSnapshot(snap.id)}
                    className="w-7 h-7 inline-flex items-center justify-center rounded text-[#6E788A] hover:text-[#FCA5A5] hover:bg-[#1E1418] transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
