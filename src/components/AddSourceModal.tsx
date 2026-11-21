import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  FileText,
  Link2,
  Loader2,
  Plus,
  Upload,
  X,
} from 'lucide-react';

interface AddSourceModalProps {
  open: boolean;
  initialTab: 'upload' | 'url' | 'text';
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
  const [tab, setTab] = useState<'upload' | 'url' | 'text'>(initialTab);
  const [urlValue, setUrlValue] = useState('');
  const [rawTextValue, setRawTextValue] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    }
  }, [open, initialTab]);

  if (!open) return null;

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add source to notebook"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        onClick={isBusy ? undefined : onClose}
        aria-hidden="true"
        className="fixed inset-0 bg-black/75 backdrop-blur-xs"
      />

      <div className="relative z-10 w-full max-w-xl bg-[#13161C] border border-[#22D3EE]/45 rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#222833] flex items-center justify-between gap-4">
          <div>
            <h2 className="font-serif text-xl font-medium text-[#F5F7FA]">
              Add Source
            </h2>
            <p className="text-xs text-[#A0AABB] mt-0.5">
              Upload your own documents or queue web articles for cited briefings and Q&amp;A.
            </p>
          </div>
          <button
            type="button"
            disabled={isBusy}
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
            className="grid grid-cols-3 gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md"
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
                    handleFileSelection(e.target.files);
                    e.target.value = '';
                  }
                }}
                className="hidden"
              />

              {isBusy ? (
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
          ) : (
            <form onSubmit={handleSubmitUrlOrText} className="space-y-4">
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
                    disabled={isBusy}
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
                    disabled={isBusy}
                    placeholder="Paste content here to index passages and build a Source Guide..."
                    className="w-full p-3.5 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#273040] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE] leading-relaxed"
                  />
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={onClose}
                  className="h-10 px-4 text-sm font-medium text-[#A0AABB] hover:text-[#F5F7FA] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    isBusy ||
                    (tab === 'url' ? !urlValue.trim() : rawTextValue.trim().length < 30)
                  }
                  className="h-10 px-5 inline-flex items-center gap-2 text-sm font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors cursor-pointer"
                >
                  {isBusy ? (
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
