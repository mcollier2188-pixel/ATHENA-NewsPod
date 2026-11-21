import { useEffect, useRef } from 'react';
import { Bookmark, BookmarkCheck, ExternalLink, X } from 'lucide-react';
import type { InspectedSourceTarget, NewsArticle } from '../types';
import { ensureArticlePassages } from '../utils/passages';

interface SourceInspectorDrawerProps {
  target: InspectedSourceTarget | null;
  sources: NewsArticle[];
  onClose: () => void;
  onToggleReadLater?: (sourceId: string) => void;
}

export function SourceInspectorDrawer({
  target,
  sources,
  onClose,
  onToggleReadLater,
}: SourceInspectorDrawerProps) {
  const highlightedPassageRef = useRef<HTMLDivElement | null>(null);

  const rawSource = target ? sources.find((s) => s.id === target.sourceId) : null;
  const source = rawSource ? ensureArticlePassages(rawSource) : null;

  useEffect(() => {
    if (target?.passageIndex && highlightedPassageRef.current) {
      highlightedPassageRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [target?.sourceId, target?.passageIndex]);

  if (!target || !source) return null;

  const passages = source.passages || [];

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={`Source Inspector: ${source.title}`}
      className="fixed inset-y-0 right-0 z-40 w-full sm:w-[440px] lg:w-[460px] bg-[#11141A] border-l border-[#22D3EE]/40 shadow-2xl flex flex-col"
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
                  <p className="text-sm text-[#E4E9F1] leading-[1.7]">{p.text}</p>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
