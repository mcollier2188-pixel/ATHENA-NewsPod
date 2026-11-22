import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  BookOpen,
  Check,
  Copy,
  FilePlus2,
  Highlighter,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import type { CitationRef, HighlightsMetaSummary } from '../types';
import {
  copyTextToClipboard,
  formatHighlightsMetaSummaryMarkdown,
} from '../utils/highlightMarkdown';

export type HighlightsSummaryScope = 'selected' | 'all';

interface HighlightsSummaryModalProps {
  open: boolean;
  summary: HighlightsMetaSummary | null;
  isLoading: boolean;
  errorMessage: string | null;
  scope: HighlightsSummaryScope;
  selectedStats: { sourceCount: number; highlightCount: number };
  allStats: { sourceCount: number; highlightCount: number };
  onScopeChange: (nextScope: HighlightsSummaryScope) => void;
  onRegenerate: (scopeOverride?: HighlightsSummaryScope) => void;
  onSelectCitation: (citation: CitationRef) => void;
  onSaveAsNotebookSource?: (summary: HighlightsMetaSummary) => void;
  onClose: () => void;
}

function renderTextWithCitationMarkers(
  text: string,
  citationMap: Map<number, CitationRef>,
  onSelectCitation: (citation: CitationRef) => void
): ReactNode {
  if (!text) return null;
  const parts = text.split(/(\[\d+\])/g);
  if (parts.length <= 1) return text;

  return parts.map((part, idx) => {
    const match = /^\[(\d+)\]$/.exec(part);
    if (!match) return part;
    const markerNum = Number(match[1]);
    const citation = citationMap.get(markerNum);
    if (!citation) {
      return (
        <span key={idx} className="font-mono text-[11px] text-[#67E8F9] tabular-nums">
          {part}
        </span>
      );
    }
    return (
      <button
        key={idx}
        type="button"
        onClick={() => onSelectCitation(citation)}
        title={`${citation.sourceTitle} · Passage ${citation.passageIndex}: "${citation.excerpt}"`}
        className="mx-0.5 px-1 py-0.5 font-mono text-[11px] font-medium text-[#67E8F9] hover:text-[#071318] bg-[#16222E] hover:bg-[#22D3EE] border border-[#22D3EE]/45 rounded-xs transition-colors tabular-nums cursor-pointer align-baseline"
      >
        [{markerNum}]
      </button>
    );
  });
}

export function HighlightsSummaryModal({
  open,
  summary,
  isLoading,
  errorMessage,
  scope,
  selectedStats,
  allStats,
  onScopeChange,
  onRegenerate,
  onSelectCitation,
  onSaveAsNotebookSource,
  onClose,
}: HighlightsSummaryModalProps) {
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [savedToNotebook, setSavedToNotebook] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCopiedMarkdown(false);
    setSavedToNotebook(false);
  }, [summary?.id, open]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const citationMap = useMemo(() => {
    const map = new Map<number, CitationRef>();
    (summary?.citations || []).forEach((c) => {
      map.set(c.marker, c);
    });
    return map;
  }, [summary?.citations]);

  if (!open) return null;

  const activeStats = scope === 'selected' ? selectedStats : allStats;
  const canSwitchScopes =
    selectedStats.highlightCount > 0 &&
    allStats.highlightCount > selectedStats.highlightCount;

  const overviewParagraphs = (summary?.executiveOverview || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const formattedGeneratedAt = summary?.createdAt
    ? new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(summary.createdAt))
    : null;

  const handleCopyMarkdown = async () => {
    if (!summary) return;
    const md = formatHighlightsMetaSummaryMarkdown(summary);
    const ok = await copyTextToClipboard(md);
    if (ok) {
      setCopiedMarkdown(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedMarkdown(false);
        copyTimerRef.current = null;
      }, 2200);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="highlights-meta-summary-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-40 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
    >
      <div className="w-full max-w-3xl max-h-[88vh] bg-[#11141A] border border-[#22D3EE]/40 rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[#222833] flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#67E8F9] tabular-nums">
              <Highlighter className="w-3.5 h-3.5 text-[#22D3EE] shrink-0" aria-hidden="true" />
              <span>Meta-Briefing Synthesis</span>
              {summary && !isLoading && (
                <>
                  <span aria-hidden="true" className="text-[#4B5565]">
                    ·
                  </span>
                  <span className="text-[#A0AABB]">
                    {summary.highlightCount}{' '}
                    {summary.highlightCount === 1 ? 'highlight' : 'highlights'}
                  </span>
                  <span aria-hidden="true" className="text-[#4B5565]">
                    ·
                  </span>
                  <span className="text-[#A0AABB]">
                    {summary.sourceCount}{' '}
                    {summary.sourceCount === 1 ? 'source' : 'sources'}
                  </span>
                  {formattedGeneratedAt && (
                    <>
                      <span aria-hidden="true" className="text-[#4B5565]">
                        ·
                      </span>
                      <span className="text-[#6E788A]">{formattedGeneratedAt}</span>
                    </>
                  )}
                </>
              )}
            </div>

            <h2
              id="highlights-meta-summary-title"
              className="mt-1.5 font-serif text-xl sm:text-2xl font-medium text-[#F5F7FA] leading-snug text-balance"
            >
              {isLoading
                ? 'Synthesizing Meta-Briefing from Highlights…'
                : summary
                  ? summary.title
                  : 'Generate Summary from Highlights'}
            </h2>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {canSwitchScopes && (
              <div
                role="group"
                aria-label="Highlight source scope"
                className="hidden sm:inline-flex items-center gap-1 p-0.5 bg-[#0B0D10] border border-[#252D3B] rounded-md"
              >
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    if (scope !== 'selected') {
                      onScopeChange('selected');
                      onRegenerate('selected');
                    }
                  }}
                  className={`h-7 px-2.5 text-xs font-medium rounded transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${
                    scope === 'selected'
                      ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/50'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                  }`}
                >
                  Selected ({selectedStats.highlightCount})
                </button>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    if (scope !== 'all') {
                      onScopeChange('all');
                      onRegenerate('all');
                    }
                  }}
                  className={`h-7 px-2.5 text-xs font-medium rounded transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${
                    scope === 'all'
                      ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/50'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                  }`}
                >
                  All Queue ({allStats.highlightCount})
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close meta-briefing summary modal"
              className="w-9 h-9 inline-flex items-center justify-center rounded-md text-[#A0AABB] hover:text-[#F5F7FA] hover:bg-[#1B222D] transition-colors shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Modal Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-7">
          {isLoading ? (
            <div className="py-16 text-center space-y-3">
              <Loader2
                className="w-7 h-7 mx-auto animate-spin text-[#22D3EE]"
                aria-hidden="true"
              />
              <p className="font-serif text-lg text-[#F5F7FA]">
                Connecting{' '}
                <span className="font-mono text-[#67E8F9] tabular-nums">
                  {activeStats.highlightCount}
                </span>{' '}
                highlighted{' '}
                {activeStats.highlightCount === 1 ? 'passage' : 'passages'} across{' '}
                <span className="font-mono text-[#67E8F9] tabular-nums">
                  {activeStats.sourceCount}
                </span>{' '}
                {activeStats.sourceCount === 1 ? 'article' : 'articles'}…
              </p>
              <p className="text-xs text-[#8C96A8] max-w-md mx-auto leading-relaxed">
                Weaving cross-article themes, executive takeaways, and clickable passage
                citations from your curated highlights.
              </p>
            </div>
          ) : errorMessage ? (
            <div
              role="alert"
              className="p-5 rounded-md bg-[#3B1219]/60 border border-[#F87171]/40 space-y-3"
            >
              <div className="flex items-start gap-2.5 text-sm text-[#FCA5A5]">
                <AlertCircle className="w-4 h-4 text-[#F87171] shrink-0 mt-0.5" aria-hidden="true" />
                <p className="leading-relaxed">{errorMessage}</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onRegenerate()}
                  className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  Try Again
                </button>
              </div>
            </div>
          ) : summary ? (
            <>
              {/* Thesis Subtitle */}
              <p className="text-base text-[#C7D0DF] leading-relaxed border-b border-[#1E2430] pb-5">
                {summary.subtitle}
              </p>

              {/* Executive Synthesis */}
              <section className="space-y-3">
                <h3 className="font-serif text-lg font-medium text-[#F5F7FA]">
                  Executive Synthesis
                </h3>
                <div className="space-y-3.5 text-sm text-[#D5DCE6] leading-[1.7] max-w-[68ch]">
                  {overviewParagraphs.map((para, idx) => (
                    <p key={idx}>
                      {renderTextWithCitationMarkers(
                        para,
                        citationMap,
                        onSelectCitation
                      )}
                    </p>
                  ))}
                </div>
              </section>

              {/* Cross-Source Themes */}
              {summary.themes.length > 0 && (
                <section className="pt-5 border-t border-[#1E2430] space-y-3.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-serif text-lg font-medium text-[#F5F7FA]">
                      Cross-Source Themes
                    </h3>
                    <span className="font-mono text-[11px] text-[#6E788A] tabular-nums">
                      {summary.themes.length}{' '}
                      {summary.themes.length === 1 ? 'thread' : 'threads'}
                    </span>
                  </div>

                  <div className="divide-y divide-[#1E2430]">
                    {summary.themes.map((theme, idx) => (
                      <div key={idx} className="py-4 first:pt-1 last:pb-0 space-y-1.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <h4 className="text-sm font-semibold text-[#F5F7FA]">
                            <span className="font-mono text-xs text-[#22D3EE] tabular-nums mr-2">
                              {String(idx + 1).padStart(2, '0')}.
                            </span>
                            {theme.heading}
                          </h4>
                          {theme.sourceTitles.length > 0 && (
                            <span className="text-xs text-[#8C96A8] truncate max-w-md">
                              {theme.sourceTitles.join(' · ')}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-[#C7D0DF] leading-relaxed max-w-[68ch]">
                          {renderTextWithCitationMarkers(
                            theme.synthesis,
                            citationMap,
                            onSelectCitation
                          )}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Key Takeaways */}
              {summary.keyTakeaways.length > 0 && (
                <section className="pt-5 border-t border-[#1E2430] space-y-3">
                  <h3 className="font-serif text-lg font-medium text-[#F5F7FA]">
                    Key Takeaways
                  </h3>
                  <ul className="space-y-2.5 text-sm text-[#D5DCE6] leading-relaxed">
                    {summary.keyTakeaways.map((takeaway, idx) => (
                      <li key={idx} className="flex items-start gap-2.5">
                        <span className="font-mono text-xs text-[#22D3EE] tabular-nums shrink-0 mt-0.5">
                          {idx + 1}.
                        </span>
                        <span className="max-w-[66ch]">
                          {renderTextWithCitationMarkers(
                            takeaway,
                            citationMap,
                            onSelectCitation
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Grounded Citations Index */}
              {summary.citations.length > 0 && (
                <section className="pt-5 border-t border-[#1E2430] space-y-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-xs font-semibold text-[#F5F7FA]">
                      Cited Highlight Passages
                    </h3>
                    <span className="font-mono text-[11px] text-[#6E788A] tabular-nums">
                      Click any citation to inspect source passage
                    </span>
                  </div>
                  <ul className="space-y-1.5 text-xs text-[#A0AABB]">
                    {summary.citations.map((cit) => (
                      <li key={cit.marker} className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() => onSelectCitation(cit)}
                          className="inline-flex items-center gap-1.5 text-left hover:text-[#67E8F9] transition-colors cursor-pointer group"
                        >
                          <span className="font-mono text-[11px] text-[#67E8F9] tabular-nums shrink-0">
                            [{cit.marker}]
                          </span>
                          <span className="font-medium text-[#E4E9F1] group-hover:text-[#67E8F9]">
                            {cit.sourceTitle}
                          </span>
                          <span aria-hidden="true" className="text-[#4B5565]">
                            ·
                          </span>
                          <span className="font-mono text-[11px] text-[#8C96A8] tabular-nums whitespace-nowrap shrink-0 inline-flex items-center gap-1">
                            <BookOpen className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                            Passage {cit.passageIndex}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : null}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 border-t border-[#222833] bg-[#0E1116] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2.5">
            {summary && !isLoading && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void handleCopyMarkdown();
                  }}
                  aria-live="polite"
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copiedMarkdown ? (
                    <>
                      <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Copied Markdown</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Copy Markdown</span>
                    </>
                  )}
                </button>

                {onSaveAsNotebookSource && (
                  <button
                    type="button"
                    disabled={savedToNotebook}
                    onClick={() => {
                      onSaveAsNotebookSource(summary);
                      setSavedToNotebook(true);
                    }}
                    className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#161B23] hover:bg-[#1E2633] disabled:opacity-60 border border-[#2A3342] hover:border-[#22D3EE]/55 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {savedToNotebook ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                        <span>Saved to Active Sources</span>
                      </>
                    ) : (
                      <>
                        <FilePlus2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                        <span>Add as Notebook Source</span>
                      </>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => onRegenerate()}
                  className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] border border-[#252D3B] hover:border-[#22D3EE]/45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  <span>Regenerate</span>
                </button>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] rounded-md hover:bg-[#181E27] transition-colors whitespace-nowrap shrink-0 cursor-pointer ml-auto"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
