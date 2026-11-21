import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock,
  ExternalLink,
  FileAudio,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { AudioBriefing } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { GoogleSignInButton } from './GoogleSignInButton';
import {
  downloadDriveFileAsBrowserFile,
  DriveAuthExpiredError,
  ensureDispatchDriveFolder,
  fetchRecentDriveActivity,
  formatDriveBytes,
  formatDriveMimeLabel,
  isImportableDriveFile,
  listDriveFiles,
  moveDriveFilesToTrash,
  uploadBriefingDocToDrive,
  uploadWavEpisodeToDrive,
  type DriveActivityItem,
  type DriveFileFilter,
  type DriveFileItem,
} from '../services/googleDriveService';

interface GoogleDriveModalProps {
  open: boolean;
  initialTab?: 'browse' | 'export' | 'activity';
  briefing: AudioBriefing | null;
  onBuildStitchedWavBlob: () => Blob | null;
  onImportFilesToSources: (files: File[]) => Promise<boolean>;
  onClose: () => void;
}

type DriveConfirmationAction =
  | {
      kind: 'trash';
      files: DriveFileItem[];
    }
  | {
      kind: 'overwrite_doc';
      targetFile: DriveFileItem;
    }
  | {
      kind: 'overwrite_wav';
      targetFile: DriveFileItem;
    };

function formatShortDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function GoogleDriveModal({
  open,
  initialTab = 'browse',
  briefing,
  onBuildStitchedWavBlob,
  onImportFilesToSources,
  onClose,
}: GoogleDriveModalProps) {
  const {
    driveAccessToken,
    connectGoogleDrive,
    invalidateDriveAccessToken,
  } = useAuth();

  const [tab, setTab] = useState<'browse' | 'export' | 'activity'>(initialTab);
  const [isConnecting, setIsConnecting] = useState(false);

  // Browse state
  const [files, setFiles] = useState<DriveFileItem[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [filter, setFilter] = useState<DriveFileFilter>('importable');
  const [folderStack, setFolderStack] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Activity state
  const [activities, setActivities] = useState<DriveActivityItem[]>([]);
  const [isLoadingActivity, setIsLoadingActivity] = useState(false);

  // Export state
  const [useStudioFolder, setUseStudioFolder] = useState(true);
  const [overwriteTargetId, setOverwriteTargetId] = useState<string>('');
  const [isBusyMutation, setIsBusyMutation] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastSavedDriveItem, setLastSavedDriveItem] = useState<DriveFileItem | null>(null);

  // Mandatory explicit confirmation dialog state for destructive/mutating Drive actions
  const [pendingConfirmation, setPendingConfirmation] =
    useState<DriveConfirmationAction | null>(null);

  const currentFolder =
    folderStack.length > 0 ? folderStack[folderStack.length - 1] : null;

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setErrorMessage(null);
      setStatusMessage(null);
      setPendingConfirmation(null);
    }
  }, [open, initialTab]);

  const loadFiles = useCallback(
    async (token: string) => {
      setIsLoadingFiles(true);
      setErrorMessage(null);
      try {
        const result = await listDriveFiles({
          accessToken: token,
          searchQuery: appliedSearch,
          filter,
          folderId: currentFolder?.id ?? null,
          pageSize: 35,
        });
        setFiles(result);
        setSelectedIds((prev) => {
          const valid = new Set(result.map((f) => f.id));
          const next = new Set<string>();
          prev.forEach((id) => {
            if (valid.has(id)) next.add(id);
          });
          return next;
        });
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          invalidateDriveAccessToken();
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Could not load Google Drive files.'
          );
        }
      } finally {
        setIsLoadingFiles(false);
      }
    },
    [appliedSearch, currentFolder?.id, filter, invalidateDriveAccessToken]
  );

  const loadActivity = useCallback(
    async (token: string) => {
      setIsLoadingActivity(true);
      try {
        const list = await fetchRecentDriveActivity(token, 15);
        setActivities(list);
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          invalidateDriveAccessToken();
        }
      } finally {
        setIsLoadingActivity(false);
      }
    },
    [invalidateDriveAccessToken]
  );

  useEffect(() => {
    if (!open || !driveAccessToken) return;
    void loadFiles(driveAccessToken);
    if (tab === 'activity') {
      void loadActivity(driveAccessToken);
    }
  }, [open, driveAccessToken, tab, loadFiles, loadActivity]);

  const handleConnectDrive = async () => {
    setIsConnecting(true);
    setErrorMessage(null);
    try {
      await connectGoogleDrive();
    } finally {
      setIsConnecting(false);
    }
  };

  const selectedFiles = useMemo(
    () => files.filter((f) => selectedIds.has(f.id)),
    [files, selectedIds]
  );

  const selectedImportableFiles = useMemo(
    () => selectedFiles.filter(isImportableDriveFile),
    [selectedFiles]
  );

  const readyAudioChaptersCount = useMemo(
    () =>
      briefing
        ? briefing.segments.filter((s) => Boolean(s.audioBase64)).length
        : 0,
    [briefing]
  );

  if (!open) return null;

  const toggleSelectFile = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleImportSelected = async () => {
    if (!driveAccessToken || selectedImportableFiles.length === 0 || isBusyMutation) return;
    setIsBusyMutation(true);
    setErrorMessage(null);
    setStatusMessage(
      `Downloading ${selectedImportableFiles.length} file(s) from Google Drive...`
    );

    try {
      const browserFiles: File[] = [];
      for (const item of selectedImportableFiles) {
        const downloaded = await downloadDriveFileAsBrowserFile(driveAccessToken, item);
        browserFiles.push(downloaded);
      }
      setStatusMessage('Indexing Drive documents into Notebook Sources...');
      const ok = await onImportFilesToSources(browserFiles);
      if (ok) {
        setSelectedIds(new Set());
        onClose();
      } else {
        setStatusMessage(null);
      }
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to import from Google Drive.'
        );
      }
      setStatusMessage(null);
    } finally {
      setIsBusyMutation(false);
    }
  };

  const handleCreateStudioFolder = async () => {
    if (!driveAccessToken || isBusyMutation) return;
    setIsBusyMutation(true);
    setErrorMessage(null);
    try {
      const folder = await ensureDispatchDriveFolder(driveAccessToken, 'Dispatch Studio');
      setStatusMessage(`Folder "${folder.name}" is ready in Google Drive.`);
      await loadFiles(driveAccessToken);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not create Dispatch Studio folder.'
        );
      }
    } finally {
      setIsBusyMutation(false);
    }
  };

  const executeSaveDoc = async (confirmedOverwriteFileId?: string | null) => {
    if (!driveAccessToken || !briefing) return;
    setIsBusyMutation(true);
    setErrorMessage(null);
    setLastSavedDriveItem(null);
    setStatusMessage('Saving briefing script and takeaways to Google Drive...');

    try {
      let folderId: string | null = null;
      if (!confirmedOverwriteFileId && useStudioFolder) {
        const folder = await ensureDispatchDriveFolder(driveAccessToken, 'Dispatch Studio');
        folderId = folder.id;
      }

      const saved = await uploadBriefingDocToDrive({
        accessToken: driveAccessToken,
        briefing,
        parentFolderId: folderId,
        overwriteFileId: confirmedOverwriteFileId || null,
      });

      setLastSavedDriveItem(saved);
      setStatusMessage(
        confirmedOverwriteFileId
          ? `Updated "${saved.name}" in Google Drive.`
          : `Saved "${saved.name}" as a Google Doc in Drive.`
      );
      await loadFiles(driveAccessToken);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to save Google Doc to Drive.'
        );
      }
      setStatusMessage(null);
    } finally {
      setIsBusyMutation(false);
    }
  };

  const executeSaveWav = async (confirmedOverwriteFileId?: string | null) => {
    if (!driveAccessToken || !briefing) return;
    const wavBlob = onBuildStitchedWavBlob();
    if (!wavBlob) {
      setErrorMessage('Record at least one briefing chapter before exporting WAV audio.');
      return;
    }

    setIsBusyMutation(true);
    setErrorMessage(null);
    setLastSavedDriveItem(null);
    setStatusMessage('Uploading stitched WAV audio episode to Google Drive...');

    try {
      let folderId: string | null = null;
      if (!confirmedOverwriteFileId && useStudioFolder) {
        const folder = await ensureDispatchDriveFolder(driveAccessToken, 'Dispatch Studio');
        folderId = folder.id;
      }

      const safeSlug = briefing.editionTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);

      const saved = await uploadWavEpisodeToDrive({
        accessToken: driveAccessToken,
        fileName: `dispatch-${safeSlug || 'briefing'}.wav`,
        wavBlob,
        parentFolderId: folderId,
        overwriteFileId: confirmedOverwriteFileId || null,
      });

      setLastSavedDriveItem(saved);
      setStatusMessage(
        confirmedOverwriteFileId
          ? `Overwrote audio file "${saved.name}" in Google Drive.`
          : `Saved "${saved.name}" to Google Drive.`
      );
      await loadFiles(driveAccessToken);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to upload WAV audio to Drive.'
        );
      }
      setStatusMessage(null);
    } finally {
      setIsBusyMutation(false);
    }
  };

  const requestSaveBriefingDoc = () => {
    if (!briefing) return;
    if (overwriteTargetId) {
      const target = files.find((f) => f.id === overwriteTargetId);
      if (target) {
        setPendingConfirmation({ kind: 'overwrite_doc', targetFile: target });
        return;
      }
    }
    void executeSaveDoc(null);
  };

  const requestSaveBriefingWav = () => {
    if (!briefing) return;
    if (overwriteTargetId) {
      const target = files.find((f) => f.id === overwriteTargetId);
      if (target) {
        setPendingConfirmation({ kind: 'overwrite_wav', targetFile: target });
        return;
      }
    }
    void executeSaveWav(null);
  };

  const requestTrashSelected = () => {
    if (selectedFiles.length === 0) return;
    setPendingConfirmation({ kind: 'trash', files: selectedFiles });
  };

  const handleConfirmPendingAction = async () => {
    if (!pendingConfirmation || !driveAccessToken) return;
    const action = pendingConfirmation;
    setPendingConfirmation(null);

    if (action.kind === 'overwrite_doc') {
      await executeSaveDoc(action.targetFile.id);
      return;
    }

    if (action.kind === 'overwrite_wav') {
      await executeSaveWav(action.targetFile.id);
      return;
    }

    if (action.kind === 'trash') {
      setIsBusyMutation(true);
      setErrorMessage(null);
      setStatusMessage(
        `Moving ${action.files.length} file(s) to Google Drive Trash...`
      );
      try {
        await moveDriveFilesToTrash({
          accessToken: driveAccessToken,
          fileIds: action.files.map((f) => f.id),
        });
        setSelectedIds(new Set());
        setStatusMessage(
          `Moved ${action.files.length} ${action.files.length === 1 ? 'file' : 'files'} to Google Drive Trash.`
        );
        await loadFiles(driveAccessToken);
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          invalidateDriveAccessToken();
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Failed to move files to Trash.'
          );
        }
        setStatusMessage(null);
      } finally {
        setIsBusyMutation(false);
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Google Drive Workspace"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        onClick={isBusyMutation ? undefined : onClose}
        aria-hidden="true"
        className="fixed inset-0 bg-black/75 backdrop-blur-xs"
      />

      <div className="relative z-10 w-full max-w-3xl max-h-[88vh] flex flex-col bg-[#13161C] border border-[#22D3EE]/45 rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#222833] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <HardDrive className="w-5 h-5 text-[#22D3EE] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="font-serif text-xl font-medium text-[#F5F7FA] truncate">
                Google Drive Workspace
              </h2>
              <p className="text-xs text-[#A0AABB] mt-0.5">
                Import Docs, PDFs, and notes into your notebook or save briefings and WAV episodes to Drive.
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isBusyMutation}
            onClick={onClose}
            aria-label="Close Google Drive Workspace"
            className="w-9 h-9 inline-flex items-center justify-center rounded-md text-[#A0AABB] hover:text-[#F5F7FA] hover:bg-[#1C222D] disabled:opacity-40 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Tabs */}
        {driveAccessToken && (
          <div className="px-6 pt-4 pb-3 border-b border-[#222833] bg-[#0E1116] flex flex-wrap items-center justify-between gap-3 shrink-0">
            <div
              role="tablist"
              aria-label="Google Drive sections"
              className="inline-flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'browse'}
                onClick={() => setTab('browse')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  tab === 'browse'
                    ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                }`}
              >
                Browse &amp; Import
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'export'}
                onClick={() => setTab('export')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  tab === 'export'
                    ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                }`}
              >
                Save Briefing to Drive
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'activity'}
                onClick={() => setTab('activity')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  tab === 'activity'
                    ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                }`}
              >
                Recent Activity
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isBusyMutation || isLoadingFiles}
                onClick={() => void handleCreateStudioFolder()}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                Dispatch Studio Folder
              </button>
              <button
                type="button"
                disabled={isLoadingFiles || isLoadingActivity}
                onClick={() => {
                  if (!driveAccessToken) return;
                  if (tab === 'activity') {
                    void loadActivity(driveAccessToken);
                  } else {
                    void loadFiles(driveAccessToken);
                  }
                }}
                aria-label="Refresh Google Drive"
                className="h-8 w-8 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${
                    isLoadingFiles || isLoadingActivity ? 'animate-spin text-[#22D3EE]' : ''
                  }`}
                />
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {!driveAccessToken ? (
            <div className="py-10 px-6 bg-[#0E1116] border border-[#222833] rounded-lg text-center space-y-4">
              <HardDrive className="w-9 h-9 text-[#22D3EE] mx-auto" aria-hidden="true" />
              <div className="max-w-md mx-auto space-y-1.5">
                <h3 className="font-serif text-lg font-medium text-[#F5F7FA]">
                  Connect your Google Drive
                </h3>
                <p className="text-xs text-[#A0AABB] leading-relaxed">
                  Sign in with Google to browse your Drive documents, import Docs and PDFs directly into your cited research notebook, and save briefing scripts or stitched WAV episodes to your Drive.
                </p>
              </div>
              <div className="pt-2 flex justify-center">
                <GoogleSignInButton
                  onClick={() => void handleConnectDrive()}
                  disabled={isConnecting}
                  label={isConnecting ? 'Connecting Google Drive...' : 'Sign in with Google'}
                />
              </div>
            </div>
          ) : tab === 'browse' ? (
            <>
              {/* Search & Filter Controls */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setAppliedSearch(searchInput.trim());
                  }}
                  className="flex-1 flex items-center gap-2"
                >
                  <div className="relative flex-1">
                    <Search
                      className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      value={searchInput}
                      onChange={(e) => {
                        setSearchInput(e.target.value);
                        if (!e.target.value.trim()) {
                          setAppliedSearch('');
                        }
                      }}
                      placeholder="Search Google Drive by filename..."
                      className="w-full h-9 pl-9 pr-3 text-xs text-[#F5F7FA] bg-[#0E1116] border border-[#273040] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE]"
                    />
                  </div>
                  <button
                    type="submit"
                    className="h-9 px-3.5 text-xs font-medium text-[#F5F7FA] bg-[#18202B] hover:bg-[#1E2938] border border-[#2A3342] rounded-md whitespace-nowrap cursor-pointer"
                  >
                    Search
                  </button>
                </form>

                <div className="inline-flex items-center gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md self-start">
                  {(
                    [
                      { id: 'importable', label: 'Docs & PDFs' },
                      { id: 'audio', label: 'Audio' },
                      { id: 'folders', label: 'Folders' },
                      { id: 'all', label: 'All' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFilter(item.id)}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                        filter === item.id
                          ? 'bg-[#182430] text-[#67E8F9]'
                          : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Folder Breadcrumb */}
              {currentFolder && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[#0E1116] border border-[#222833] rounded-md text-xs">
                  <div className="flex items-center gap-2 min-w-0 text-[#A0AABB]">
                    <Folder className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      My Drive /{' '}
                      <strong className="text-[#F5F7FA] font-medium">
                        {folderStack.map((f) => f.name).join(' / ')}
                      </strong>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFolderStack((prev) => prev.slice(0, -1))}
                    className="inline-flex items-center gap-1 text-[#67E8F9] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <ArrowLeft className="w-3 h-3" aria-hidden="true" />
                    Up one folder
                  </button>
                </div>
              )}

              {/* File List */}
              {isLoadingFiles ? (
                <div className="py-12 flex flex-col items-center justify-center gap-2 text-xs text-[#8C96A8]">
                  <Loader2 className="w-6 h-6 animate-spin text-[#22D3EE]" />
                  <span>Loading files from Google Drive...</span>
                </div>
              ) : files.length === 0 ? (
                <div className="py-12 text-center bg-[#0E1116] border border-[#222833] rounded-lg">
                  <p className="text-sm font-medium text-[#F5F7FA]">
                    No matching Google Drive files found
                  </p>
                  <p className="text-xs text-[#8C96A8] mt-1">
                    Try clearing your search filter or switching to All files.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-[#1E2430] border border-[#222833] rounded-lg bg-[#0E1116]">
                  {files.map((file) => {
                    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                    const isChecked = selectedIds.has(file.id);
                    const importable = isImportableDriveFile(file);
                    const sizeText = formatDriveBytes(file.size);
                    const modifiedText = formatShortDate(file.modifiedTime);
                    const ownerName = file.owners?.[0]?.displayName || '';

                    return (
                      <li
                        key={file.id}
                        className={`px-4 py-3 flex items-center justify-between gap-3 transition-colors ${
                          isChecked ? 'bg-[#162230]' : 'hover:bg-[#131821]'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isChecked}
                            aria-label={`Select ${file.name}`}
                            onClick={() => toggleSelectFile(file.id)}
                            className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 cursor-pointer ${
                              isChecked
                                ? 'bg-[#22D3EE] border-[#22D3EE] text-[#071318]'
                                : 'border-[#394457] bg-[#0B0D10]'
                            }`}
                          >
                            {isChecked && <Check className="w-3 h-3" strokeWidth={2.75} />}
                          </button>

                          {isFolder ? (
                            <Folder
                              className="w-4 h-4 text-[#22D3EE] shrink-0"
                              aria-hidden="true"
                            />
                          ) : file.mimeType.startsWith('audio/') ? (
                            <FileAudio
                              className="w-4 h-4 text-[#67E8F9] shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <FileText
                              className="w-4 h-4 text-[#8C96A8] shrink-0"
                              aria-hidden="true"
                            />
                          )}

                          <div className="min-w-0 flex-1">
                            {isFolder ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setFolderStack((prev) => [
                                    ...prev,
                                    { id: file.id, name: file.name },
                                  ])
                                }
                                className="text-sm font-medium text-[#67E8F9] hover:underline truncate block max-w-full text-left cursor-pointer"
                              >
                                {file.name}
                              </button>
                            ) : (
                              <p className="text-sm font-medium text-[#F5F7FA] truncate">
                                {file.name}
                              </p>
                            )}

                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#8C96A8] tabular-nums">
                              <span>{formatDriveMimeLabel(file.mimeType, file.name)}</span>
                              {sizeText && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono">{sizeText}</span>
                                </>
                              )}
                              {modifiedText && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{modifiedText}</span>
                                </>
                              )}
                              {ownerName && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="truncate max-w-[140px]">{ownerName}</span>
                                </>
                              )}
                              {!isFolder && !importable && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-[#6E788A]">View / Manage only</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {file.webViewLink && (
                            <a
                              href={file.webViewLink}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open ${file.name} in Google Drive`}
                              className="h-8 px-2.5 inline-flex items-center gap-1 text-xs text-[#A0AABB] hover:text-[#67E8F9] rounded hover:bg-white/5 whitespace-nowrap"
                            >
                              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                              <span className="hidden sm:inline">Open</span>
                            </a>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : tab === 'export' ? (
            <div className="space-y-5">
              {!briefing ? (
                <div className="py-10 px-6 bg-[#0E1116] border border-[#222833] rounded-lg text-center">
                  <p className="font-serif text-lg text-[#F5F7FA]">
                    No active briefing generated yet
                  </p>
                  <p className="text-xs text-[#8C96A8] mt-1 max-w-md mx-auto">
                    Generate a briefing from your Studio Desk sources first, then save the full speaker script as a Google Doc or export your stitched WAV episode here.
                  </p>
                </div>
              ) : (
                <>
                  <div className="p-4 bg-[#0E1116] border border-[#222833] rounded-lg space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8] tabular-nums">
                      <span className="text-[#67E8F9] font-medium">Ready to Export</span>
                      <span aria-hidden="true">·</span>
                      <span>{briefing.segments.length} chapters</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {readyAudioChaptersCount}/{briefing.segments.length} audio chapters recorded
                      </span>
                    </div>
                    <h3 className="font-serif text-lg font-medium text-[#F5F7FA]">
                      {briefing.editionTitle}
                    </h3>
                    <p className="text-xs text-[#A0AABB] leading-relaxed">
                      {briefing.editionSubtitle}
                    </p>
                  </div>

                  {/* Destination Options */}
                  <div className="p-4 bg-[#0E1116] border border-[#222833] rounded-lg space-y-4">
                    <label className="flex items-center gap-2.5 text-xs text-[#E4E9F1] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useStudioFolder}
                        disabled={Boolean(overwriteTargetId)}
                        onChange={(e) => setUseStudioFolder(e.target.checked)}
                        className="accent-[#22D3EE] w-4 h-4 rounded"
                      />
                      <span>
                        Organize new exports inside my{' '}
                        <strong className="font-semibold text-[#F5F7FA]">
                          Dispatch Studio
                        </strong>{' '}
                        folder in Google Drive
                      </span>
                    </label>

                    <div>
                      <label
                        htmlFor="drive-overwrite-select"
                        className="block text-xs font-medium text-[#A0AABB] mb-1.5"
                      >
                        Create new file or update an existing Drive file
                      </label>
                      <select
                        id="drive-overwrite-select"
                        value={overwriteTargetId}
                        onChange={(e) => setOverwriteTargetId(e.target.value)}
                        className="w-full h-10 px-3 bg-[#13161C] border border-[#273040] rounded-md text-xs text-[#F5F7FA]"
                      >
                        <option value="">Create a new file in Google Drive</option>
                        {files
                          .filter((f) => f.mimeType !== 'application/vnd.google-apps.folder')
                          .map((f) => (
                            <option key={f.id} value={f.id}>
                              Overwrite existing: {f.name} ({formatDriveMimeLabel(f.mimeType, f.name)})
                            </option>
                          ))}
                      </select>
                    </div>

                    <div className="pt-1 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        disabled={isBusyMutation}
                        onClick={requestSaveBriefingDoc}
                        className="h-10 px-4 inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                      >
                        {isBusyMutation ? (
                          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <FileText className="w-4 h-4" aria-hidden="true" />
                        )}
                        {overwriteTargetId
                          ? 'Update Selected Google Doc'
                          : 'Save Transcript as Google Doc'}
                      </button>

                      <button
                        type="button"
                        disabled={isBusyMutation || readyAudioChaptersCount === 0}
                        onClick={requestSaveBriefingWav}
                        className="h-10 px-4 inline-flex items-center gap-2 text-xs sm:text-sm font-medium text-[#F5F7FA] bg-[#18202B] hover:bg-[#1F2A38] border border-[#2A3342] hover:border-[#22D3EE]/60 disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <Upload className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
                        {overwriteTargetId
                          ? 'Overwrite Selected Audio File (.WAV)'
                          : 'Save Audio Episode (.WAV) to Drive'}
                      </button>
                    </div>
                  </div>

                  {lastSavedDriveItem?.webViewLink && (
                    <div className="p-3.5 bg-[#11242B] border border-[#22D3EE]/45 rounded-md flex items-center justify-between gap-3 text-xs">
                      <span className="text-[#E6FAFE] truncate">
                        Saved <strong>{lastSavedDriveItem.name}</strong> to Google Drive.
                      </span>
                      <a
                        href={lastSavedDriveItem.webViewLink}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 font-semibold text-[#67E8F9] hover:underline whitespace-nowrap shrink-0"
                      >
                        Open in Drive
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      </a>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            /* Recent Drive Activity */
            <div>
              {isLoadingActivity ? (
                <div className="py-12 flex flex-col items-center justify-center gap-2 text-xs text-[#8C96A8]">
                  <Loader2 className="w-6 h-6 animate-spin text-[#22D3EE]" />
                  <span>Loading recent Google Drive activity...</span>
                </div>
              ) : activities.length === 0 ? (
                <div className="py-12 text-center bg-[#0E1116] border border-[#222833] rounded-lg">
                  <p className="text-sm font-medium text-[#F5F7FA]">
                    No recent Drive activity events returned
                  </p>
                  <p className="text-xs text-[#8C96A8] mt-1">
                    Recent edits, creations, and Drive file updates will appear here automatically.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-[#1E2430] border border-[#222833] rounded-lg bg-[#0E1116]">
                  {activities.map((act) => (
                    <li
                      key={act.id}
                      className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Clock className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[#F5F7FA] truncate">
                            {act.targetName}
                          </p>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#8C96A8] tabular-nums">
                            <span>{act.actionLabel}</span>
                            <span aria-hidden="true">·</span>
                            <span>{formatShortDate(act.timestamp)}</span>
                          </div>
                        </div>
                      </div>
                      {act.targetFileId && (
                        <a
                          href={`https://drive.google.com/open?id=${encodeURIComponent(act.targetFileId)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-[#A0AABB] hover:text-[#67E8F9] whitespace-nowrap shrink-0"
                        >
                          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                          Open
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {statusMessage && (
            <div className="px-3.5 py-2.5 bg-[#12202B] border border-[#22D3EE]/35 rounded-md flex items-center gap-2 text-xs text-[#CFFAFE]">
              {isBusyMutation && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE] shrink-0" />
              )}
              <span>{statusMessage}</span>
            </div>
          )}

          {errorMessage && (
            <p
              role="alert"
              className="text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3.5 py-2.5"
            >
              {errorMessage}
            </p>
          )}
        </div>

        {/* Footer Action Bar for Browse Mode */}
        {driveAccessToken && tab === 'browse' && (
          <div className="px-6 py-3.5 border-t border-[#222833] bg-[#0E1116] flex flex-wrap items-center justify-between gap-3 shrink-0">
            <span className="text-xs font-mono text-[#8C96A8] tabular-nums">
              {selectedFiles.length} selected
              {selectedImportableFiles.length > 0 &&
              selectedImportableFiles.length !== selectedFiles.length
                ? ` · ${selectedImportableFiles.length} importable`
                : ''}
            </span>

            <div className="flex items-center gap-2.5">
              {selectedFiles.length > 0 && (
                <button
                  type="button"
                  disabled={isBusyMutation}
                  onClick={requestTrashSelected}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#FCA5A5] hover:text-white bg-[#2C1419] hover:bg-[#3F1A22] border border-[#F87171]/35 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Move to Trash ({selectedFiles.length})
                </button>
              )}

              <button
                type="button"
                disabled={isBusyMutation || selectedImportableFiles.length === 0}
                onClick={() => void handleImportSelected()}
                className="h-9 px-4 inline-flex items-center gap-2 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-40 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                {isBusyMutation ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                    Import to Sources
                    {selectedImportableFiles.length > 0
                      ? ` (${selectedImportableFiles.length})`
                      : ''}
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Mandatory Explicit Confirmation Dialog for Mutating / Destructive Drive Actions */}
        {pendingConfirmation && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm Google Drive modification"
            className="absolute inset-0 z-20 bg-black/80 backdrop-blur-xs flex items-center justify-center p-6"
          >
            <div className="w-full max-w-md bg-[#161A22] border border-amber-400/45 rounded-lg shadow-2xl p-5 space-y-4">
              <div className="flex items-start gap-3">
                <AlertTriangle
                  className="w-5 h-5 text-amber-300 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="space-y-1.5 min-w-0">
                  <h3 className="font-serif text-lg font-medium text-[#F5F7FA]">
                    {pendingConfirmation.kind === 'trash'
                      ? `Move ${pendingConfirmation.files.length} ${
                          pendingConfirmation.files.length === 1 ? 'file' : 'files'
                        } to Google Drive Trash?`
                      : `Overwrite "${pendingConfirmation.targetFile.name}" in Google Drive?`}
                  </h3>
                  <p className="text-xs text-[#C7D0DF] leading-relaxed">
                    {pendingConfirmation.kind === 'trash'
                      ? 'The selected items will be moved to Trash in your Google Drive account:'
                      : `This will replace the existing contents of "${pendingConfirmation.targetFile.name}" in your Google Drive with the current Dispatch ${
                          pendingConfirmation.kind === 'overwrite_doc'
                            ? 'briefing transcript'
                            : 'WAV audio episode'
                        }.`}
                  </p>

                  {pendingConfirmation.kind === 'trash' && (
                    <ul className="mt-2 max-h-32 overflow-y-auto space-y-1 text-xs text-[#F5F7FA] bg-[#0E1116] border border-[#262E3D] rounded p-2.5">
                      {pendingConfirmation.files.map((item) => (
                        <li key={item.id} className="truncate">
                          • {item.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setPendingConfirmation(null)}
                  className="h-9 px-4 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmPendingAction()}
                  className={`h-9 px-4 text-xs font-semibold rounded-md cursor-pointer ${
                    pendingConfirmation.kind === 'trash'
                      ? 'text-white bg-red-600 hover:bg-red-500'
                      : 'text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9]'
                  }`}
                >
                  {pendingConfirmation.kind === 'trash'
                    ? 'Move to Trash'
                    : 'Confirm Overwrite'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
