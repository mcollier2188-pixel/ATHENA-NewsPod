import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bookmark,
  BookmarkCheck,
  Check,
  Copy,
  ExternalLink,
  Highlighter,
  X,
} from 'lucide-react';
import type { ArticleHighlight, InspectedSourceTarget, NewsArticle } from '../types';
import { ensureArticlePassages } from '../utils/passages';
import {
  copyTextToClipboard,
  formatArticleHighlightsMarkdown,
} from '../utils/highlightMarkdown';

interface SourceInspectorDrawerProps {
  target: InspectedSourceTarget | null;
  sources: NewsArticle[];
  onClose: () => void;
  onToggleReadLater?: (sourceId: string) => void;
  onRemoveHighlight?: (sourceId: string, highlightId?: string) => void;
  onSelectHighlightPassage?: (
    sourceId: string,
    passageIndex: number,
    excerpt: string
  ) => void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderPassageWithHighlights(
  text: string,
  highlights?: ArticleHighlight[]
): ReactNode {
  const validPhrases = Array.from(
    new Set(
      (highlights || [])
        .map((h) => h.text.replace(/\s+/g, ' ').trim())
        .filter((p) => p.length >= 2)
    )
  ).sort((a, b) => b.length - a.length);

  if (validPhrases.length === 0 || !text) return text;

  const pattern = new RegExp(
    `(${validPhrases.map((p) => escapeRegExp(p).replace(/\s+/g, '\\s+')).join('|')})`,
    'gi'
  );
  const parts = text.split(pattern);
  if (parts.length <= 1) return text;

  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <mark
        key={idx}
        className="bg-[#22D3EE]/20 text-[#ECFEFF] border-b border-[#22D3EE]/70 rounded-xs px-0.5"
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export function SourceInspectorDrawer({
  target,
  sources,
  onClose,
  onToggleReadLater,
  onRemoveHighlight,
  onSelectHighlightPassage,
}: SourceInspectorDrawerProps) {
  const highlightedPassageRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [copiedHighlights, setCopiedHighlights] = useState(false);

  const rawSource = target ? sources.find((s) => s.id === target.sourceId) : null;
  const source = rawSource ? ensureArticlePassages(rawSource) : null;

  useEffect(() => {
    setCopiedHighlights(false);
    if (target?.passageIndex && highlightedPassageRef.current) {
      highlightedPassageRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [target?.sourceId, target?.passageIndex]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  if (!target || !source) return null;

  const passages = source.passages || [];
  const highlights = source.highlights || [];

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={`Source Inspector: ${source.title}`}
      className="fixed inset-y-0 right-0 z-50 w-full sm:w-[440px] lg:w-[460px] bg-[#11141A] border-l border-[#22D3EE]/40 shadow-2xl flex flex-col"
    >
      {/* Inspector Header */}
      <div className="px-6 py-4 border-b border-[#222833] flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-[#6E788A] tabular-nums">
            <span className="text-[#22D3EE] uppercase">
              {source.sourceType || 'article'}
            </span>
            {source.readLater && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[#FBBF24]">Read Later</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="truncate max-w-[180px]">{source.source}</span>
            {source.fileSizeLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span>{source.fileSizeLabel}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{source.estimatedReadMinutes} min read</span>
          </div>
          <h2 className="mt-1.5 font-serif text-xl font-medium text-[#F5F7FA] leading-snug">
            {source.title}
          </h2>
          {source.tags && source.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-[#67E8F9]">
              {source.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-4">
            {onToggleReadLater && (
              <button
                type="button"
                onClick={() => onToggleReadLater(source.id)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[#A0AABB] hover:text-[#67E8F9] transition-colors cursor-pointer"
              >
                {source.readLater ? (
                  <>
                    <BookmarkCheck className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    Move back to Notebook
                  </>
                ) : (
                  <>
                    <Bookmark className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    Move to Read Later
                  </>
                )}
              </button>
            )}
            {source.url && (
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-[#67E8F9] hover:underline"
              >
                Open original link
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close source inspector"
          className="w-9 h-9 inline-flex items-center justify-center rounded-md text-[#A0AABB] hover:text-[#F5F7FA] hover:bg-[#1B222D] transition-colors shrink-0 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Body: Source Guide + Indexed Passages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Source Guide */}
        <section className="p-4 rounded-lg bg-[#0E1116] border border-[#22D3EE]/30 space-y-3">
          <p className="font-mono text-[11px] text-[#22D3EE]">Source Guide</p>
          <p className="text-sm text-[#D5DCE6] leading-relaxed">{source.summary}</p>
          {source.keyFacts.length > 0 && (
            <div className="pt-2 border-t border-[#1E2430]">
              <p className="text-xs font-medium text-[#F5F7FA] mb-2">Key Facts</p>
              <ul className="space-y-1.5 text-xs text-[#A0AABB] leading-relaxed">
                {source.keyFacts.map((fact, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="font-mono text-[11px] text-[#22D3EE] tabular-nums shrink-0">
                      {idx + 1}.
                    </span>
                    <span>{fact}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {highlights.length > 0 && (
            <div className="pt-2.5 border-t border-[#1E2430] space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA]">
                  <Highlighter className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  <span>Saved Highlights</span>
                  <span aria-hidden="true" className="text-[#4B5565]">
                    ·
                  </span>
                  <span className="font-mono text-[11px] text-[#67E8F9] tabular-nums">
                    {highlights.length}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    onClick={async () => {
                      const md = formatArticleHighlightsMarkdown(source);
                      if (!md) return;
                      const ok = await copyTextToClipboard(md);
                      if (ok) {
                        setCopiedHighlights(true);
                        if (copyTimerRef.current !== null) {
                          window.clearTimeout(copyTimerRef.current);
                        }
                        copyTimerRef.current = window.setTimeout(() => {
                          setCopiedHighlights(false);
                          copyTimerRef.current = null;
                        }, 2200);
                      }
                    }}
                    aria-live="polite"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] hover:text-[#22D3EE] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copiedHighlights ? (
                      <>
                        <Check className="w-3 h-3" aria-hidden="true" />
                        <span>Copied Markdown</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" aria-hidden="true" />
                        <span>Copy to Clipboard</span>
                      </>
                    )}
                  </button>
                  {onRemoveHighlight && (
                    <button
                      type="button"
                      onClick={() => onRemoveHighlight(source.id)}
                      className="text-[11px] text-[#8C96A8] hover:text-[#F87171] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              </div>
              <ul className="space-y-2 text-xs text-[#D5DCE6] leading-relaxed">
                {highlights.map((hl) => (
                  <li
                    key={hl.id}
                    className="flex items-start justify-between gap-2 pt-1.5 first:pt-0 border-t first:border-t-0 border-[#1A202B]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[#E4E9F1]">“{hl.text}”</p>
                      {hl.passageIndex > 0 && onSelectHighlightPassage && (
                        <button
                          type="button"
                          onClick={() =>
                            onSelectHighlightPassage(source.id, hl.passageIndex, hl.text)
                          }
                          className="mt-0.5 font-mono text-[11px] text-[#67E8F9] hover:text-[#22D3EE] hover:underline tabular-nums whitespace-nowrap cursor-pointer"
                        >
                          Jump to Passage {hl.passageIndex}
                        </button>
                      )}
                    </div>
                    {onRemoveHighlight && (
                      <button
                        type="button"
                        onClick={() => onRemoveHighlight(source.id, hl.id)}
                        aria-label={`Remove highlight "${hl.text.slice(0, 40)}"`}
                        className="p-1 text-[#6E788A] hover:text-[#F87171] rounded transition-colors shrink-0 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Indexed Passages */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="font-serif text-base font-medium text-[#F5F7FA]">
              Source Passages
            </h3>
            <span className="font-mono text-[11px] text-[#6E788A] tabular-nums">
              {passages.length} indexed {passages.length === 1 ? 'passage' : 'passages'}
            </span>
          </div>

          <div className="space-y-3">
            {passages.map((p) => {
              const isHighlighted = target.passageIndex === p.index;
              return (
                <div
                  key={p.id}
                  ref={isHighlighted ? highlightedPassageRef : null}
                  className={`p-4 rounded-lg border transition-colors ${
                    isHighlighted
                      ? 'bg-[#22D3EE]/[0.08] border-[#22D3EE] cyan-rim-strong'
                      : 'bg-[#13161C] border-[#222833]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span
                      className={`font-mono text-[11px] tabular-nums ${
                        isHighlighted ? 'text-[#22D3EE] font-medium' : 'text-[#6E788A]'
                      }`}
                    >
                      Passage {p.index}
                    </span>
                    {isHighlighted && (
                      <span className="font-mono text-[11px] text-[#67E8F9]">
                        Cited passage
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-[#E4E9F1] leading-[1.7]">
                    {renderPassageWithHighlights(p.text, highlights)}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
