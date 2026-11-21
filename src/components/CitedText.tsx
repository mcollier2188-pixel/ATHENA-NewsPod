import { Fragment } from 'react';
import type { CitationRef } from '../types';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function HighlightText({
  text,
  query,
  emphasized = false,
}: {
  text: string;
  query?: string;
  emphasized?: boolean;
}) {
  const trimmed = (query || '').trim();
  if (!trimmed) {
    return <>{text}</>;
  }

  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, 'gi');
  const parts = text.split(regex);
  if (parts.length === 1) {
    return <>{text}</>;
  }

  return (
    <>
      {parts.map((part, idx) =>
        idx % 2 === 1 ? (
          <mark
            key={idx}
            className={
              emphasized
                ? 'bg-[#22D3EE] text-[#071318] font-medium rounded-xs px-0.5'
                : 'bg-[#22D3EE]/25 text-[#F5F7FA] border-b border-[#22D3EE] rounded-xs px-0.5'
            }
          >
            {part}
          </mark>
        ) : (
          <Fragment key={idx}>{part}</Fragment>
        )
      )}
    </>
  );
}

interface CitedTextProps {
  text: string;
  citations?: CitationRef[];
  onSelectCitation: (citation: CitationRef) => void;
  highlightQuery?: string;
  emphasizedMatch?: boolean;
}

/**
 * Parses inline citation brackets such as [1] or [1, 2] and turns matched
 * references into clickable cyan triggers that jump to the exact source passage,
 * while optionally highlighting full-text search matches cleanly in prose.
 */
export function CitedText({
  text,
  citations,
  onSelectCitation,
  highlightQuery,
  emphasizedMatch = false,
}: CitedTextProps) {
  if (!citations || citations.length === 0) {
    return (
      <HighlightText
        text={text}
        query={highlightQuery}
        emphasized={emphasizedMatch}
      />
    );
  }

  const citationMap = new Map<number, CitationRef>();
  for (const c of citations) {
    citationMap.set(c.marker, c);
  }

  const tokenRegex = /(\[\d+(?:\s*,\s*\d+)*\])/g;
  const parts = text.split(tokenRegex);

  return (
    <>
      {parts.map((part, idx) => {
        const match = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
        if (!match) {
          return (
            <HighlightText
              key={idx}
              text={part}
              query={highlightQuery}
              emphasized={emphasizedMatch}
            />
          );
        }

        const nums = match[1]
          .split(',')
          .map((n) => Number(n.trim()))
          .filter((n) => Number.isInteger(n));

        const matchedRefs = nums
          .map((n) => citationMap.get(n))
          .filter((ref): ref is CitationRef => Boolean(ref));

        if (matchedRefs.length === 0) {
          return (
            <HighlightText
              key={idx}
              text={part}
              query={highlightQuery}
              emphasized={emphasizedMatch}
            />
          );
        }

        return (
          <span key={idx} className="inline-flex items-baseline gap-1 mx-0.5">
            {matchedRefs.map((ref) => (
              <button
                key={ref.marker}
                type="button"
                onClick={() => onSelectCitation(ref)}
                title={`${ref.sourceTitle} — Passage ${ref.passageIndex}: "${ref.excerpt.slice(0, 110)}"`}
                className="inline-flex items-center justify-center font-mono text-[11px] font-medium leading-none px-1.5 py-0.5 rounded text-[#67E8F9] bg-[#22D3EE]/10 border border-[#22D3EE]/40 hover:bg-[#22D3EE] hover:text-[#071318] hover:border-[#22D3EE] transition-colors cursor-pointer tabular-nums align-baseline"
              >
                {ref.marker}
              </button>
            ))}
          </span>
        );
      })}
    </>
  );
}

interface CitationListProps {
  citations?: CitationRef[];
  onSelectCitation: (citation: CitationRef) => void;
}

export function CitationList({ citations, onSelectCitation }: CitationListProps) {
  if (!citations || citations.length === 0) return null;

  return (
    <div className="mt-4 pt-3 border-t border-[#222833] flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <span className="font-mono text-[11px] text-[#6E788A]">Citations</span>
      {citations.map((c) => (
        <button
          key={c.marker}
          type="button"
          onClick={() => onSelectCitation(c)}
          className="inline-flex items-center gap-1.5 text-left text-[#A0AABB] hover:text-[#67E8F9] transition-colors cursor-pointer max-w-[260px]"
        >
          <span className="font-mono text-[11px] text-[#22D3EE] tabular-nums shrink-0">
            [{c.marker}]
          </span>
          <span className="truncate">{c.sourceTitle}</span>
          <span className="font-mono text-[10px] text-[#6E788A] tabular-nums shrink-0">
            P{c.passageIndex}
          </span>
        </button>
      ))}
    </div>
  );
}
