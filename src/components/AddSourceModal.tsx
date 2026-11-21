import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  Check,
  FileText,
  HardDrive,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { GoogleSignInButton } from './GoogleSignInButton';
import {
  downloadDriveFileAsBrowserFile,
  DriveAuthExpiredError,
  formatDriveBytes,
  formatDriveMimeLabel,
  isImportableDriveFile,
  listDriveFiles,
  type DriveFileItem,
} from '../services/googleDriveService';

export type AddSourceTab = 'upload' | 'drive' | 'url' | 'text';

interface AddSourceModalProps {
  open: boolean;
  initialTab: AddSourceTab;
  isBusy: boolean;
  statusMessage: string | null;
  errorMessage: string | null;
  onClose: () => void;
  onUploadFiles: (files: FileList | File[]) => Promise<boolean>;
  onIngestUrlOrText: (payload: { url?: string; rawText?: string }) => Promise<boolean>;
}

export function AddSourceModal({
  open,
  initialTab,
  isBusy,
  statusMessage,
  errorMessage,
  onClose,
  onUploadFiles,
  onIngestUrlOrText,
}: AddSourceModalProps) {
  const {
    driveAccessToken,
    connectGoogleDrive,
    invalidateDriveAccessToken,
  } = useAuth();

  const [tab, setTab] = useState<AddSourceTab>(initialTab);
  const [urlValue, setUrlValue] = useState('');
  const [rawTextValue, setRawTextValue] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Google Drive picker tab state
  const [driveFiles, setDriveFiles] = useState<DriveFileItem[]>([]);
  const [driveSearch, setDriveSearch] = useState('');
  const [isLoadingDrive, setIsLoadingDrive] = useState(false);
  const [isConnectingDrive, setIsConnectingDrive] = useState(false);
  const [isDownloadingDrive, setIsDownloadingDrive] = useState(false);
  const [selectedDriveIds, setSelectedDriveIds] = useState<Set<string>>(new Set());
  const [driveError, setDriveError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setDriveError(null);
    }
  }, [open, initialTab]);

  const loadDrivePickerFiles = useCallback(
    async (token: string, query = '') => {
      setIsLoadingDrive(true);
      setDriveError(null);
      try {
        const items = await listDriveFiles({
          accessToken: token,
          searchQuery: query,
          filter: 'importable',
          pageSize: 25,
        });
        setDriveFiles(items.filter(isImportableDriveFile));
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          invalidateDriveAccessToken();
        } else {
          setDriveError(
            err instanceof Error ? err.message : 'Could not load Google Drive documents.'
          );
        }
      } finally {
        setIsLoadingDrive(false);
      }
    },
    [invalidateDriveAccessToken]
  );

  useEffect(() => {
    if (open && tab === 'drive' && driveAccessToken) {
      void loadDrivePickerFiles(driveAccessToken, '');
    }
  }, [open, tab, driveAccessToken, loadDrivePickerFiles]);

  if (!open) return null;

  const combinedBusy = isBusy || isDownloadingDrive;

  async function handleFileSelection(files: FileList | File[]) {
    if (!files || files.length === 0) return;
    const ok = await onUploadFiles(files);
    if (ok) {
      onClose();
    }
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFileSelection(e.dataTransfer.files);
    }
  }

  async function handleSubmitUrlOrText(e: FormEvent) {
    e.preventDefault();
    if (tab === 'url') {
      if (!urlValue.trim()) return;
      const ok = await onIngestUrlOrText({ url: urlValue.trim() });
      if (ok) {
        setUrlValue('');
        onClose();
      }
    } else if (tab === 'text') {
      if (!rawTextValue.trim()) return;
      const ok = await onIngestUrlOrText({ rawText: rawTextValue.trim() });
      if (ok) {
        setRawTextValue('');
        onClose();
      }
    }
  }

  async function handleConnectDrive() {
    setIsConnectingDrive(true);
    setDriveError(null);
    try {
      await connectGoogleDrive();
    } finally {
      setIsConnectingDrive(false);
    }
  }

  function toggleDriveSelection(id: string) {
    setSelectedDriveIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleImportSelectedDriveDocs() {
    if (!driveAccessToken || selectedDriveIds.size === 0 || combinedBusy) return;
    const chosen = driveFiles.filter((f) => selectedDriveIds.has(f.id));
    if (chosen.length === 0) return;

    setIsDownloadingDrive(true);
    setDriveError(null);
    try {
      const downloadedFiles: File[] = [];
      for (const item of chosen) {
        const fileObj = await downloadDriveFileAsBrowserFile(driveAccessToken, item);
        downloadedFiles.push(fileObj);
      }
      const ok = await onUploadFiles(downloadedFiles);
      if (ok) {
        setSelectedDriveIds(new Set());
        onClose();
      }
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setDriveError(
          err instanceof Error ? err.message : 'Could not import selected Drive files.'
        );
      }
    } finally {
      setIsDownloadingDrive(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add source to notebook"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        onClick={combinedBusy ? undefined : onClose}
        aria-hidden="true"
        className="fixed inset-0 bg-black/75 backdrop-blur-xs"
      />

      <div className="relative z-10 w-full max-w-2xl bg-[#13161C] border border-[#22D3EE]/45 rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#222833] flex items-center justify-between gap-4">
          <div>
            <h2 className="font-serif text-xl font-medium text-[#F5F7FA]">
              Add Source
            </h2>
            <p className="text-xs text-[#A0AABB] mt-0.5">
              Upload files, import directly from Google Drive, or queue web articles for cited briefings.
            </p>
          </div>
          <button
            type="button"
            disabled={combinedBusy}
            onClick={onClose}
            aria-label="Close modal"
            className="w-9 h-9 inline-flex items-center justify-center rounded-md text-[#A0AABB] hover:text-[#F5F7FA] hover:bg-[#1C222D] disabled:opacity-40 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="px-6 pt-5">
          <div
            role="tablist"
            aria-label="Source input type"
            className="grid grid-cols-2 sm:grid-cols-4 gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'upload'}
              onClick={() => setTab('upload')}
              className={`py-2 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                tab === 'upload'
                  ? 'bg-[#18202B] text-[#67E8F9] border border-[#22D3EE]/40'
                  : 'text-[#A0AABB] hover:text-[#F5F7FA]'
              }`}
            >
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              Upload File
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'drive'}
              onClick={() => setTab('drive')}
              className={`py-2 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                tab === 'drive'
                  ? 'bg-[#18202B] text-[#67E8F9] border border-[#22D3EE]/40'
                  : 'text-[#A0AABB] hover:text-[#F5F7FA]'
              }`}
            >
              <HardDrive className="w-3.5 h-3.5" aria-hidden="true" />
              Google Drive
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'url'}
              onClick={() => setTab('url')}
              className={`py-2 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                tab === 'url'
                  ? 'bg-[#18202B] text-[#67E8F9] border border-[#22D3EE]/40'
                  : 'text-[#A0AABB] hover:text-[#F5F7FA]'
              }`}
            >
              <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
              Article URL
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'text'}
              onClick={() => setTab('text')}
              className={`py-2 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                tab === 'text'
                  ? 'bg-[#18202B] text-[#67E8F9] border border-[#22D3EE]/40'
                  : 'text-[#A0AABB] hover:text-[#F5F7FA]'
              }`}
            >
              <FileText className="w-3.5 h-3.5" aria-hidden="true" />
              Paste Text
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6">
          {tab === 'upload' ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                setIsDragging(false);
              }}
              onDrop={handleDrop}
              className={`p-8 rounded-lg border border-dashed text-center transition-colors ${
                isDragging
                  ? 'border-[#22D3EE] bg-[#22D3EE]/10'
                  : 'border-[#2D3849] bg-[#0E1116] hover:border-[#22D3EE]/55'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
                onChange={(e) => {
                  if (e.target.files) {
                    void handleFileSelection(e.target.files);
                    e.target.value = '';
                  }
                }}
                className="hidden"
              />

              {combinedBusy ? (
                <div className="py-4 flex flex-col items-center gap-3">
                  <Loader2 className="w-7 h-7 animate-spin text-[#22D3EE]" />
                  <p className="text-sm font-medium text-[#F5F7FA]">
                    {statusMessage || 'Extracting document and indexing passages...'}
                  </p>
                  <p className="text-xs text-[#6E788A]">
                    Building Source Guide for clickable citations
                  </p>
                </div>
              ) : (
                <>
                  <Upload className="w-7 h-7 mx-auto text-[#22D3EE]" aria-hidden="true" />
                  <p className="mt-3 text-sm font-medium text-[#F5F7FA]">
                    Drag &amp; drop your documents here
                  </p>
                  <p className="mt-1 font-mono text-xs text-[#6E788A]">
                    PDF · Word (DOCX) · TXT · Markdown · up to 15 MB
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-5 h-10 px-5 inline-flex items-center gap-2 text-sm font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
                  >
                    Choose Files
                  </button>
                </>
              )}
            </div>
          ) : tab === 'drive' ? (
            !driveAccessToken ? (
              <div className="p-8 bg-[#0E1116] border border-[#222833] rounded-lg text-center space-y-4">
                <HardDrive className="w-8 h-8 text-[#22D3EE] mx-auto" aria-hidden="true" />
                <div className="space-y-1 max-w-md mx-auto">
                  <p className="text-sm font-medium text-[#F5F7FA]">
                    Sign in with Google to browse your Drive
                  </p>
                  <p className="text-xs text-[#A0AABB] leading-relaxed">
                    Import Google Docs, Slides, Sheets, PDFs, Word files, and Markdown notes directly into your notebook with cited passages.
                  </p>
                </div>
                <div className="pt-1 flex justify-center">
                  <GoogleSignInButton
                    onClick={() => void handleConnectDrive()}
                    disabled={isConnectingDrive}
                    label={
                      isConnectingDrive ? 'Connecting Google Drive...' : 'Sign in with Google'
                    }
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3.5">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void loadDrivePickerFiles(driveAccessToken, driveSearch);
                  }}
                  className="flex items-center gap-2"
                >
                  <div className="relative flex-1">
                    <Search
                      className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      value={driveSearch}
                      onChange={(e) => {
                        setDriveSearch(e.target.value);
                        if (!e.target.value.trim()) {
                          void loadDrivePickerFiles(driveAccessToken, '');
                        }
                      }}
                      placeholder="Search Google Docs, PDFs, DOCX, or notes in Drive..."
                      className="w-full h-9 pl-9 pr-3 text-xs text-[#F5F7FA] bg-[#0E1116] border border-[#273040] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoadingDrive}
                    className="h-9 px-3 text-xs font-medium text-[#F5F7FA] bg-[#18202B] hover:bg-[#1F2A38] border border-[#2A3342] rounded-md whitespace-nowrap cursor-pointer"
                  >
                    Search
                  </button>
                  <button
                    type="button"
                    disabled={isLoadingDrive}
                    onClick={() => void loadDrivePickerFiles(driveAccessToken, driveSearch)}
                    aria-label="Refresh Drive list"
                    className="h-9 w-9 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#273040] rounded-md cursor-pointer"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isLoadingDrive ? 'animate-spin text-[#22D3EE]' : ''}`}
                    />
                  </button>
                </form>

                {isLoadingDrive ? (
                  <div className="py-10 flex flex-col items-center gap-2 text-xs text-[#8C96A8]">
                    <Loader2 className="w-6 h-6 animate-spin text-[#22D3EE]" />
                    <span>Loading documents from Google Drive...</span>
                  </div>
                ) : driveFiles.length === 0 ? (
                  <div className="py-10 text-center bg-[#0E1116] border border-[#222833] rounded-lg">
                    <p className="text-sm font-medium text-[#F5F7FA]">
                      No matching documents in Google Drive
                    </p>
                    <p className="text-xs text-[#8C96A8] mt-1">
                      Supported formats: Google Docs, Slides, Sheets, PDF, DOCX, TXT, and Markdown.
                    </p>
                  </div>
                ) : (
                  <ul className="max-h-64 overflow-y-auto divide-y divide-[#1E2430] border border-[#222833] rounded-lg bg-[#0E1116]">
                    {driveFiles.map((item) => {
                      const checked = selectedDriveIds.has(item.id);
                      const sizeLabel = formatDriveBytes(item.size);
                      return (
                        <li
                          key={item.id}
                          onClick={() => toggleDriveSelection(item.id)}
                          className={`px-3.5 py-2.5 flex items-center gap-3 cursor-pointer transition-colors ${
                            checked ? 'bg-[#162230]' : 'hover:bg-[#131821]'
                          }`}
                        >
                          <span
                            role="checkbox"
                            aria-checked={checked}
                            className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                              checked
                                ? 'bg-[#22D3EE] border-[#22D3EE] text-[#071318]'
                                : 'border-[#394457] bg-[#0B0D10]'
                            }`}
                          >
                            {checked && <Check className="w-3 h-3" strokeWidth={2.75} />}
                          </span>
                          <FileText
                            className="w-4 h-4 text-[#22D3EE] shrink-0"
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs sm:text-sm font-medium text-[#F5F7FA] truncate">
                              {item.name}
                            </p>
                            <div className="flex items-center gap-1.5 text-[11px] text-[#8C96A8] tabular-nums">
                              <span>{formatDriveMimeLabel(item.mimeType, item.name)}</span>
                              {sizeLabel && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono">{sizeLabel}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {driveError && (
                  <p className="text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3 py-2">
                    {driveError}
                  </p>
                )}

                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-xs font-mono text-[#8C96A8] tabular-nums">
                    {selectedDriveIds.size} selected
                  </span>
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      disabled={combinedBusy}
                      onClick={onClose}
                      className="h-9 px-3.5 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={combinedBusy || selectedDriveIds.size === 0}
                      onClick={() => void handleImportSelectedDriveDocs()}
                      className="h-9 px-4 inline-flex items-center gap-2 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                    >
                      {combinedBusy ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          {statusMessage || 'Importing from Drive...'}
                        </>
                      ) : (
                        <>
                          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                          Import to Sources
                          {selectedDriveIds.size > 0 ? ` (${selectedDriveIds.size})` : ''}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            <form onSubmit={(e) => void handleSubmitUrlOrText(e)} className="space-y-4">
              {tab === 'url' ? (
                <div>
                  <label
                    htmlFor="modal-url-input"
                    className="block text-xs font-medium text-[#A0AABB] mb-2"
                  >
                    News article or web page URL
                  </label>
                  <input
                    id="modal-url-input"
                    type="url"
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    disabled={combinedBusy}
                    placeholder="https://www.bbc.com/news/articles/..."
                    className="w-full h-11 px-3.5 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#273040] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE]"
                  />
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="modal-text-input"
                    className="block text-xs font-medium text-[#A0AABB] mb-2"
                  >
                    Paste article text, meeting notes, or research excerpt
                  </label>
                  <textarea
                    id="modal-text-input"
                    rows={6}
                    value={rawTextValue}
                    onChange={(e) => setRawTextValue(e.target.value)}
                    disabled={combinedBusy}
                    placeholder="Paste content here to index passages and build a Source Guide..."
                    className="w-full p-3.5 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#273040] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE] leading-relaxed"
                  />
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  disabled={combinedBusy}
                  onClick={onClose}
                  className="h-10 px-4 text-sm font-medium text-[#A0AABB] hover:text-[#F5F7FA] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    combinedBusy ||
                    (tab === 'url' ? !urlValue.trim() : rawTextValue.trim().length < 30)
                  }
                  className="h-10 px-5 inline-flex items-center gap-2 text-sm font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors cursor-pointer"
                >
                  {combinedBusy ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      Indexing...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" aria-hidden="true" />
                      Add to Sources
                    </>
                  )}
                </button>
              </div>
            </form>
          )}

          {errorMessage && (
            <p
              role="alert"
              className="mt-4 text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3.5 py-2.5"
            >
              {errorMessage}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
