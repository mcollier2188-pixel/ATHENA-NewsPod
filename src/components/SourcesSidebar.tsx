import { useMemo, useState, type DragEvent } from 'react';
import {
  ArrowUpLeft,
  Bookmark,
  BookOpen,
  Check,
  FileCode2,
  FileText,
  Globe,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { NewsArticle, SourceType } from '../types';

interface SourcesSidebarProps {
  sources: NewsArticle[];
  inspectedSourceId: string | null;
  isUploading: boolean;
  uploadStatus: string | null;
  isTagging: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onOpenAddModal: (tab?: 'upload' | 'url' | 'text') => void;
  onDropFiles: (files: FileList | File[]) => Promise<void>;
  onToggleSource: (id: string) => void;
  onToggleAll: (selected: boolean) => void;
  onToggleReadLater: (id: string) => void;
  onRestoreAllReadLater: () => void;
  onInspectSource: (sourceId: string) => void;
  onRemoveSource: (id: string) => void;
  onResetSamples: () => void;
  onAutoTagSources: () => Promise<void>;
}

function sourceTypeLabel(type?: SourceType): string {
  switch (type) {
    case 'pdf':
      return 'PDF';
    case 'docx':
      return 'DOCX';
    case 'markdown':
      return 'MD';
    case 'txt':
      return 'TXT';
    default:
      return 'Article';
  }
}

function SourceIcon({ type }: { type?: SourceType }) {
  if (type === 'pdf' || type === 'docx' || type === 'txt') {
    return <FileText className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />;
  }
  if (type === 'markdown') {
    return <FileCode2 className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />;
  }
  return <Globe className="w-3.5 h-3.5 text-[#67E8F9]/80 shrink-0" aria-hidden="true" />;
}

export function SourcesSidebar({
  sources,
  inspectedSourceId,
  isUploading,
  uploadStatus,
  isTagging,
  mobileOpen,
  onCloseMobile,
  onOpenAddModal,
  onDropFiles,
  onToggleSource,
  onToggleAll,
  onToggleReadLater,
  onRestoreAllReadLater,
  onInspectSource,
  onRemoveSource,
  onResetSamples,
  onAutoTagSources,
}: SourcesSidebarProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'notebook' | 'readLater'>('notebook');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const notebookSources = useMemo(
    () => sources.filter((s) => !s.readLater),
    [sources]
  );
  const readLaterSources = useMemo(
    () => sources.filter((s) => Boolean(s.readLater)),
    [sources]
  );

  const scopedSources = drawerTab === 'notebook' ? notebookSources : readLaterSources;
  const selectedCount = notebookSources.filter((s) => s.selected).length;
  const allSelected =
    notebookSources.length > 0 && selectedCount === notebookSources.length;

  // Build ordered frequency index of all unique context tags within the active sidebar tab
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const src of scopedSources) {
      const list = src.tags && src.tags.length > 0 ? src.tags : [];
      for (const t of list) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  }, [scopedSources]);

  const effectiveTag =
    activeTag && tagCounts.some(([tag]) => tag === activeTag) ? activeTag : null;

  const visibleSources = useMemo(() => {
    if (!effectiveTag) return scopedSources;
    return scopedSources.filter((src) => src.tags?.includes(effectiveTag));
  }, [scopedSources, effectiveTag]);

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setDrawerTab('notebook');
      await onDropFiles(e.dataTransfer.files);
    }
  }

  const sidebarContent = (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`h-full flex flex-col bg-[#11141A] border-r transition-colors ${
        isDragging ? 'border-[#22D3EE] bg-[#131B24]' : 'border-[#22D3EE]/25'
      }`}
    >
      {/* Sidebar Header */}
      <div className="px-4 pt-4 pb-3 border-b border-[#222833] flex items-center justify-between gap-2">
        <div>
          <h2 className="font-serif text-lg font-medium text-[#F5F7FA] leading-none">
            Sources
          </h2>
          <p className="mt-1 font-mono text-[11px] text-[#6E788A] tabular-nums">
            {selectedCount} of {notebookSources.length} active
            {readLaterSources.length > 0 ? ` · ${readLaterSources.length} saved` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close sources sidebar"
          className="lg:hidden w-8 h-8 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] rounded-md cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Notebook vs Read Later Switcher */}
      <div className="px-3.5 pt-3 pb-2.5 border-b border-[#222833] bg-[#0E1116]">
        <div
          role="tablist"
          aria-label="Sources workspace switcher"
          className="grid grid-cols-2 gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md"
        >
          <button
            type="button"
            role="tab"
            aria-selected={drawerTab === 'notebook'}
            onClick={() => {
              setDrawerTab('notebook');
              setActiveTag(null);
            }}
            className={`py-1.5 px-2 text-xs font-medium rounded transition-colors tabular-nums whitespace-nowrap cursor-pointer ${
              drawerTab === 'notebook'
                ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
            }`}
          >
            Notebook ({notebookSources.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={drawerTab === 'readLater'}
            onClick={() => {
              setDrawerTab('readLater');
              setActiveTag(null);
            }}
            className={`py-1.5 px-2 inline-flex items-center justify-center gap-1 text-xs font-medium rounded transition-colors tabular-nums whitespace-nowrap cursor-pointer ${
              drawerTab === 'readLater'
                ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/45'
                : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
            }`}
          >
            <Bookmark className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>Read Later ({readLaterSources.length})</span>
          </button>
        </div>
      </div>

      {/* Add Source Primary Action & Drop Cue (shown in Notebook tab) */}
      {drawerTab === 'notebook' && (
        <div className="p-3.5 space-y-2 border-b border-[#222833]">
          <button
            type="button"
            onClick={() => onOpenAddModal('upload')}
            disabled={isUploading}
            className="w-full h-9 px-3.5 inline-flex items-center justify-center gap-2 text-xs font-medium text-[#F5F7FA] bg-[#161B23] hover:bg-[#1B222D] border border-[#22D3EE]/45 hover:border-[#22D3EE] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE]" aria-hidden="true" />
                <span className="truncate">{uploadStatus || 'Adding source...'}</span>
              </>
            ) : (
              <>
                <Plus className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                <span>Add source</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => onOpenAddModal('upload')}
            className={`w-full py-1.5 px-3 rounded-md border border-dashed text-center transition-colors cursor-pointer ${
              isDragging
                ? 'border-[#22D3EE] bg-[#22D3EE]/10 text-[#67E8F9]'
                : 'border-[#273040] hover:border-[#22D3EE]/45 text-[#6E788A] hover:text-[#A0AABB]'
            }`}
          >
            <span className="inline-flex items-center justify-center gap-1.5 text-[11px]">
              <Upload className="w-3 h-3" aria-hidden="true" />
              Drop PDF, DOCX, TXT, or MD
            </span>
          </button>
        </div>
      )}

      {/* Contextual Action Bar */}
      {drawerTab === 'notebook' ? (
        <div className="px-4 py-2.5 border-b border-[#1C212B] flex items-center justify-between gap-2 text-xs">
          <button
            type="button"
            onClick={() => onToggleAll(!allSelected)}
            disabled={notebookSources.length === 0}
            className="inline-flex items-center gap-2 text-[#A0AABB] hover:text-[#F5F7FA] disabled:opacity-40 cursor-pointer"
          >
            <span
              className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                allSelected
                  ? 'bg-[#22D3EE] border-[#22D3EE] text-[#071318]'
                  : 'border-[#394457] bg-[#0B0D10]'
              }`}
            >
              {allSelected && <Check className="w-3 h-3" strokeWidth={2.75} />}
            </span>
            <span>Select all</span>
          </button>

          <div className="flex items-center gap-3">
            {notebookSources.length > 0 && (
              <button
                type="button"
                onClick={onAutoTagSources}
                disabled={isTagging}
                title="Refresh automatic context tags for all sources"
                className="inline-flex items-center gap-1 text-[11px] text-[#6E788A] hover:text-[#67E8F9] disabled:opacity-50 transition-colors cursor-pointer"
              >
                {isTagging ? (
                  <Loader2 className="w-3 h-3 animate-spin text-[#22D3EE]" aria-hidden="true" />
                ) : (
                  <Sparkles className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                )}
                <span>{isTagging ? 'Tagging' : 'Auto-tag'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onResetSamples}
              title="Load sample sources"
              className="inline-flex items-center gap-1 text-[11px] text-[#6E788A] hover:text-[#67E8F9] transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
              Samples
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 py-2.5 border-b border-[#1C212B] flex items-center justify-between gap-2 text-xs">
          <span className="text-[11px] text-[#8C96A8]">
            Excluded from briefings
          </span>
          {readLaterSources.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onRestoreAllReadLater();
                setDrawerTab('notebook');
              }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] hover:text-[#22D3EE] transition-colors whitespace-nowrap cursor-pointer"
            >
              <ArrowUpLeft className="w-3 h-3" aria-hidden="true" />
              Move all back
            </button>
          )}
        </div>
      )}

      {/* Interactive Tag Filter Bar */}
      {tagCounts.length > 0 && (
        <div
          role="region"
          aria-label="Filter sources by topic tag"
          className="px-3.5 py-2.5 border-b border-[#1C212B] bg-[#0E1116]/80"
        >
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[#6E788A]">
              <Tag className="w-2.5 h-2.5 text-[#22D3EE]" aria-hidden="true" />
              Topics
            </span>
            {effectiveTag && (
              <button
                type="button"
                onClick={() => setActiveTag(null)}
                className="font-mono text-[10px] text-[#67E8F9] hover:text-[#22D3EE] cursor-pointer"
              >
                Clear filter
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              aria-pressed={effectiveTag === null}
              className={`h-6 px-2 font-mono text-[10px] rounded border transition-colors whitespace-nowrap cursor-pointer ${
                effectiveTag === null
                  ? 'bg-[#16222E] text-[#67E8F9] border-[#22D3EE]/60'
                  : 'bg-[#12161D] text-[#848E9F] border-[#222833] hover:border-[#22D3EE]/40 hover:text-[#F5F7FA]'
              }`}
            >
              All ({scopedSources.length})
            </button>
            {tagCounts.map(([tag, count]) => {
              const isSelected = effectiveTag === tag;
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setActiveTag(isSelected ? null : tag)}
                  aria-pressed={isSelected}
                  className={`h-6 px-2 font-mono text-[10px] rounded border transition-colors whitespace-nowrap tabular-nums cursor-pointer ${
                    isSelected
                      ? 'bg-[#16222E] text-[#67E8F9] border-[#22D3EE]/60'
                      : 'bg-[#12161D] text-[#848E9F] border-[#222833] hover:border-[#22D3EE]/40 hover:text-[#F5F7FA]'
                  }`}
                >
                  {tag}
                  {count > 1 ? ` · ${count}` : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Scrollable Sources List */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {scopedSources.length === 0 ? (
          drawerTab === 'notebook' ? (
            <div className="px-3 py-10 text-center">
              <p className="text-sm font-medium text-[#F5F7FA]">Active notebook is clear</p>
              <p className="mt-1 text-xs text-[#6E788A] leading-relaxed">
                {readLaterSources.length > 0
                  ? `You have ${readLaterSources.length} ${readLaterSources.length === 1 ? 'source' : 'sources'} saved in Read Later, or you can upload new files.`
                  : 'Upload a PDF, Word document, Markdown file, or paste a news link to begin.'}
              </p>
              {readLaterSources.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDrawerTab('readLater')}
                  className="mt-3 font-mono text-[11px] text-[#22D3EE] hover:underline cursor-pointer"
                >
                  Open Read Later ({readLaterSources.length})
                </button>
              )}
            </div>
          ) : (
            <div className="px-3 py-10 text-center">
              <Bookmark className="w-5 h-5 mx-auto text-[#394457]" aria-hidden="true" />
              <p className="mt-2.5 text-sm font-medium text-[#F5F7FA]">Read Later is empty</p>
              <p className="mt-1 text-xs text-[#6E788A] leading-relaxed">
                Bookmark any source in your Notebook to shelve it here without deleting it.
              </p>
            </div>
          )
        ) : visibleSources.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-[#A0AABB]">
              No sources match <span className="text-[#67E8F9] font-mono">{effectiveTag}</span>.
            </p>
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="mt-2 font-mono text-[11px] text-[#22D3EE] hover:underline cursor-pointer"
            >
              Show all sources
            </button>
          </div>
        ) : (
          <ul className="space-y-1">
            {visibleSources.map((src) => {
              const isInspected = inspectedSourceId === src.id;
              const passageCount = src.passages?.length || 0;
              const sourceTags = src.tags && src.tags.length > 0 ? src.tags : [];

              return (
                <li
                  key={src.id}
                  className={`group rounded-md border transition-colors ${
                    isInspected
                      ? 'bg-[#161D27] border-[#22D3EE]/70'
                      : 'bg-transparent border-transparent hover:bg-[#151922] hover:border-[#222833]'
                  }`}
                >
                  <div className="p-2.5 flex items-start gap-2.5">
                    {drawerTab === 'notebook' ? (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={src.selected}
                        aria-label={`Include ${src.title}`}
                        onClick={() => onToggleSource(src.id)}
                        className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                          src.selected
                            ? 'bg-[#22D3EE] border-[#22D3EE] text-[#071318]'
                            : 'bg-[#0B0D10] border-[#394457] hover:border-[#22D3EE]/60'
                        }`}
                      >
                        {src.selected && <Check className="w-3 h-3" strokeWidth={2.75} />}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onToggleReadLater(src.id)}
                        title="Move back to Notebook"
                        aria-label={`Move ${src.title} back to Notebook`}
                        className="mt-0.5 w-5 h-5 rounded border border-[#22D3EE]/45 bg-[#12202B] text-[#67E8F9] hover:bg-[#22D3EE] hover:text-[#071318] flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                      >
                        <ArrowUpLeft className="w-3 h-3" />
                      </button>
                    )}

                    <div className="flex-1 min-w-0">
                      <button
                        type="button"
                        onClick={() => {
                          onInspectSource(src.id);
                          onCloseMobile();
                        }}
                        className="w-full text-left cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
                          <SourceIcon type={src.sourceType} />
                          <span className="text-[#67E8F9]">{sourceTypeLabel(src.sourceType)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{src.estimatedReadMinutes}m</span>
                          {passageCount > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{passageCount}p</span>
                            </>
                          )}
                        </div>
                        <p
                          className={`mt-1 text-xs font-medium leading-snug line-clamp-2 ${
                            drawerTab === 'readLater'
                              ? 'text-[#D5DCE6]'
                              : src.selected
                                ? 'text-[#F5F7FA]'
                                : 'text-[#848E9F]'
                          }`}
                        >
                          {src.title}
                        </p>
                      </button>

                      {/* Auto-generated Context Tags */}
                      {sourceTags.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {sourceTags.map((tag) => {
                            const isTagActive = effectiveTag === tag;
                            return (
                              <button
                                key={tag}
                                type="button"
                                onClick={() => setActiveTag(isTagActive ? null : tag)}
                                title={`Filter by ${tag}`}
                                className={`font-mono text-[10px] leading-tight transition-colors cursor-pointer ${
                                  isTagActive
                                    ? 'text-[#22D3EE] underline underline-offset-2'
                                    : 'text-[#67E8F9]/75 hover:text-[#22D3EE]'
                                }`}
                              >
                                #{tag}
                              </button>
                            );
                          })}
                        </div>
                      ) : isTagging ? (
                        <p className="mt-1 font-mono text-[10px] text-[#6E788A]">
                          Generating tags...
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-col gap-1 shrink-0 opacity-75 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => onToggleReadLater(src.id)}
                        title={
                          drawerTab === 'notebook'
                            ? 'Move to Read Later'
                            : 'Move back to Notebook'
                        }
                        aria-label={
                          drawerTab === 'notebook'
                            ? `Move ${src.title} to Read Later`
                            : `Move ${src.title} back to Notebook`
                        }
                        className="p-1 text-[#6E788A] hover:text-[#22D3EE] transition-colors cursor-pointer"
                      >
                        {drawerTab === 'notebook' ? (
                          <Bookmark className="w-3.5 h-3.5" />
                        ) : (
                          <ArrowUpLeft className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onInspectSource(src.id);
                          onCloseMobile();
                        }}
                        title="Open Source Guide"
                        aria-label={`Inspect ${src.title}`}
                        className="p-1 text-[#6E788A] hover:text-[#22D3EE] transition-colors cursor-pointer"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveSource(src.id)}
                        title="Delete permanently"
                        aria-label={`Remove ${src.title}`}
                        className="p-1 text-[#6E788A] hover:text-[#F87171] transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Persistent Desktop Sidebar */}
      <aside
        aria-label="Sources sidebar"
        className="hidden lg:block w-[280px] shrink-0 sticky top-16 h-[calc(100vh-4rem)]"
      >
        {sidebarContent}
      </aside>

      {/* Mobile Slide-Over Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            onClick={onCloseMobile}
            aria-hidden="true"
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
          />
          <aside
            aria-label="Sources drawer"
            className="relative z-10 w-[300px] max-w-[85vw] h-full shadow-2xl"
          >
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
