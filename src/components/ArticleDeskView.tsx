import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  ArrowUpLeft,
  Bookmark,
  BookOpen,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileText,
  HardDrive,
  Headphones,
  Highlighter,
  Link2,
  Loader2,
  Minus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  VOICE_OPTIONS,
  type ArticleHighlight,
  type BriefingPreferences,
  type BriefingTone,
  type BroadcastFormat,
  type CommuteDuration,
  type NewsArticle,
  type SourceType,
  type VoiceName,
  type VoiceTone,
} from '../types';
import { EDITION_COVER_IMAGE } from '../data/sampleArticles';
import {
  copyTextToClipboard,
  formatArticleHighlightsMarkdown,
} from '../utils/highlightMarkdown';

interface ArticleDeskViewProps {
  articles: NewsArticle[];
  readLaterArticles: NewsArticle[];
  queueTab?: 'active' | 'readLater';
  onQueueTabChange?: (tab: 'active' | 'readLater') => void;
  preferences: BriefingPreferences;
  onPreferencesChange: (next: BriefingPreferences) => void;
  onOpenAddModal: (tab: 'upload' | 'drive' | 'url' | 'text') => void;
  onInspectSource: (sourceId: string) => void;
  onInspectHighlight?: (
    sourceId: string,
    passageIndex: number,
    excerpt: string
  ) => void;
  onAddHighlight?: (articleId: string, phrase: string) => void;
  onRemoveHighlight?: (articleId: string, highlightId?: string) => void;
  onToggleArticle: (id: string) => void;
  onToggleAll: (selected: boolean) => void;
  onBulkToggleCategory: (category: string, selected: boolean) => void;
  onToggleReadLater: (id: string) => void;
  onRestoreAllReadLater: () => void;
  onRemoveArticle: (id: string) => void;
  onResetSamples: () => void;
  onRefreshAllArticles: () => Promise<void>;
  isRefreshingArticles: boolean;
  refreshArticlesStatus: string | null;
  refreshArticlesError: string | null;
  onDismissRefreshError: () => void;
  onGenerateHighlightsSummary?: (scope?: 'selected' | 'all') => Promise<void> | void;
  isGeneratingHighlightsSummary?: boolean;
  hasSavedHighlightsSummary?: boolean;
  onOpenSavedHighlightsSummary?: () => void;
  onBuildBriefing: (autoSynthesize: boolean) => Promise<void>;
  isGenerating: boolean;
  generationStatus: string | null;
  generationError: string | null;
  onProjectArticleTo3D?: (article: NewsArticle) => void;
}

const DURATION_OPTIONS: Array<{ value: CommuteDuration; label: string; note: string }> = [
  { value: 3, label: '3 min', note: 'Express' },
  { value: 5, label: '5 min', note: 'Standard' },
  { value: 10, label: '10 min', note: 'Deep Dive' },
];

const FORMAT_OPTIONS: Array<{ value: BroadcastFormat; label: string; desc: string }> = [
  { value: 'solo', label: 'Solo Anchor', desc: 'Single studio voice, crisp radio pace' },
  { value: 'podcast', label: 'Two-Host Podcast', desc: 'Alex & Sam dialogue with natural banter' },
];

const TONE_OPTIONS: Array<{ value: BriefingTone; label: string }> = [
  { value: 'executive', label: 'Executive' },
  { value: 'conversational', label: 'Conversational' },
  { value: 'analytical', label: 'Analytical' },
  { value: 'upbeat', label: 'Upbeat' },
];

const VOICE_TONE_OPTIONS: Array<{
  value: VoiceTone;
  label: string;
  desc: string;
}> = [
  { value: 'professional', label: 'Professional', desc: 'Crisp, composed newsroom' },
  { value: 'casual', label: 'Casual', desc: 'Relaxed, friendly cadence' },
  { value: 'energetic', label: 'Energetic', desc: 'Upbeat, dynamic pace' },
  { value: 'soothing', label: 'Soothing', desc: 'Calm, gentle delivery' },
];

function formatSourceType(type?: SourceType): string {
  switch (type) {
    case 'pdf':
      return 'PDF Document';
    case 'docx':
      return 'Word (DOCX)';
    case 'markdown':
      return 'Markdown';
    case 'txt':
      return 'Text Note';
    default:
      return 'News Article';
  }
}

function formatShelvedDate(iso?: string): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(parsed);
}

interface ArticleSnippetData {
  previewText: string;
  expandedParagraphs: string[];
  totalWords: number;
  isExpandable: boolean;
  hasMoreInGuide: boolean;
}

function buildArticleSnippetData(article: NewsArticle): ArticleSnippetData | null {
  const rawBody =
    (article.content || '').trim() ||
    (article.passages || [])
      .map((p) => p.text)
      .join('\n\n')
      .trim();

  if (!rawBody) return null;

  const normalizedSummary = (article.summary || '').replace(/\s+/g, ' ').trim();
  let workingBody = rawBody.replace(/\r\n/g, '\n').trim();

  if (normalizedSummary.length >= 24) {
    const flatBody = workingBody.replace(/\s+/g, ' ').trim();
    if (flatBody.toLowerCase() === normalizedSummary.toLowerCase()) {
      return null;
    }
    if (flatBody.toLowerCase().startsWith(normalizedSummary.toLowerCase())) {
      workingBody = flatBody
        .slice(normalizedSummary.length)
        .replace(/^[\s.:;,-]+/, '')
        .trim();
    }
  }

  if (workingBody.length < 30) {
    return null;
  }

  const totalWords = rawBody.split(/\s+/).filter(Boolean).length;
  const paragraphs = workingBody
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return null;

  const previewText = paragraphs.join(' ');
  const CLAMP_CHAR_THRESHOLD = 210;
  const MAX_EXPANDED_CHARS = 880;
  const isExpandable =
    previewText.length > CLAMP_CHAR_THRESHOLD || paragraphs.length > 1;

  const expandedParagraphs: string[] = [];
  let usedChars = 0;
  let truncated = false;

  for (const para of paragraphs) {
    if (
      usedChars + para.length <= MAX_EXPANDED_CHARS ||
      expandedParagraphs.length === 0
    ) {
      if (para.length > MAX_EXPANDED_CHARS && expandedParagraphs.length === 0) {
        const slice = para.slice(0, MAX_EXPANDED_CHARS);
        const lastSentenceEnd = Math.max(
          slice.lastIndexOf('. '),
          slice.lastIndexOf('! '),
          slice.lastIndexOf('? ')
        );
        const cut =
          lastSentenceEnd > 240
            ? slice.slice(0, lastSentenceEnd + 1).trim()
            : `${slice.replace(/\s+\S*$/, '').trim()}…`;
        expandedParagraphs.push(cut);
        usedChars += cut.length;
        truncated = true;
        break;
      }
      expandedParagraphs.push(para);
      usedChars += para.length;
    } else {
      const remaining = MAX_EXPANDED_CHARS - usedChars;
      if (remaining >= 140) {
        const slice = para.slice(0, remaining);
        const lastSentenceEnd = Math.max(
          slice.lastIndexOf('. '),
          slice.lastIndexOf('! '),
          slice.lastIndexOf('? ')
        );
        const cut =
          lastSentenceEnd > 90
            ? slice.slice(0, lastSentenceEnd + 1).trim()
            : `${slice.replace(/\s+\S*$/, '').trim()}…`;
        expandedParagraphs.push(cut);
      }
      truncated = true;
      break;
    }
  }

  const hasMoreInGuide = truncated || usedChars < workingBody.length - 20;

  return {
    previewText,
    expandedParagraphs,
    totalWords,
    isExpandable,
    hasMoreInGuide,
  };
}

function escapeSnippetRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedSnippetText(
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
    `(${validPhrases
      .map((p) => escapeSnippetRegExp(p).replace(/\s+/g, '\\s+'))
      .join('|')})`,
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

function ArticleSnippetPreview({
  article,
  isExpanded,
  onToggleExpand,
  onInspectSource,
  onInspectHighlight,
  onAddHighlight,
  onRemoveHighlight,
}: {
  article: NewsArticle;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onInspectSource: () => void;
  onInspectHighlight?: (passageIndex: number, excerpt: string) => void;
  onAddHighlight?: (phrase: string) => void;
  onRemoveHighlight?: (highlightId?: string) => void;
}) {
  const snippet = useMemo(() => buildArticleSnippetData(article), [article]);
  const snippetBodyRef = useRef<HTMLDivElement | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);

  const highlights = article.highlights || [];

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleCopyHighlightsMarkdown = async () => {
    const markdown = formatArticleHighlightsMarkdown(article);
    if (!markdown) return;
    const ok = await copyTextToClipboard(markdown);
    if (ok) {
      setCopiedMarkdown(true);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedMarkdown(false);
        copyResetTimerRef.current = null;
      }, 2200);
    }
  };

  const captureSnippetSelection = useCallback(() => {
    if (!onAddHighlight || typeof window === 'undefined') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setPendingSelection(null);
      return;
    }
    const container = snippetBodyRef.current;
    if (!container) return;

    const anchorInside = sel.anchorNode ? container.contains(sel.anchorNode) : false;
    const focusInside = sel.focusNode ? container.contains(sel.focusNode) : false;
    if (!anchorInside || !focusInside) {
      setPendingSelection(null);
      return;
    }

    const normalized = sel.toString().replace(/\s+/g, ' ').trim();
    if (normalized.length >= 2) {
      setPendingSelection(normalized.slice(0, 600));
    } else {
      setPendingSelection(null);
    }
  }, [onAddHighlight]);

  const handleConfirmHighlight = () => {
    if (!pendingSelection || !onAddHighlight) return;
    onAddHighlight(pendingSelection);
    setPendingSelection(null);
    if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges();
    }
  };

  const handleDismissSelection = () => {
    setPendingSelection(null);
    if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges();
    }
  };

  if (!snippet && highlights.length === 0) return null;

  const isAlreadyHighlighted = pendingSelection
    ? highlights.some(
        (h) => h.text.toLowerCase() === pendingSelection.toLowerCase()
      )
    : false;
  const atHighlightCap = highlights.length >= 20 && !isAlreadyHighlighted;

  return (
    <div className="mt-2.5 pt-2.5 border-t border-[#1C222D] max-w-2xl">
      {snippet && (
        <>
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-[#6E788A] tabular-nums">
              <span>Content Snippet</span>
              <span aria-hidden="true">·</span>
              <span>{snippet.totalWords} words</span>
              {onAddHighlight && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-[#8C96A8]">
                    {highlights.length > 0
                      ? `${highlights.length} highlighted`
                      : 'Select phrase to highlight'}
                  </span>
                </>
              )}
            </div>

            {snippet.isExpandable && (
              <button
                type="button"
                onClick={() => {
                  setPendingSelection(null);
                  onToggleExpand();
                }}
                aria-expanded={isExpanded}
                aria-label={
                  isExpanded
                    ? `Show less of snippet for ${article.title}`
                    : `Show more of snippet for ${article.title}`
                }
                className="inline-flex items-center gap-1 text-xs font-medium text-[#67E8F9] hover:text-[#22D3EE] transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>{isExpanded ? 'Show less' : 'Show more'}</span>
                {isExpanded ? (
                  <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>
            )}
          </div>

          <div
            ref={snippetBodyRef}
            onMouseUp={captureSnippetSelection}
            onKeyUp={captureSnippetSelection}
            onTouchEnd={captureSnippetSelection}
            className="select-text selection:bg-[#22D3EE]/30 selection:text-[#F5F7FA]"
          >
            {!isExpanded ? (
              <p className="text-[13px] text-[#8C96A8] leading-relaxed line-clamp-3">
                {renderHighlightedSnippetText(snippet.previewText, highlights)}
              </p>
            ) : (
              <div className="space-y-2 text-[13px] text-[#C7D0DF] leading-relaxed">
                {snippet.expandedParagraphs.map((para, idx) => (
                  <p key={idx}>{renderHighlightedSnippetText(para, highlights)}</p>
                ))}
                {snippet.hasMoreInGuide && (
                  <p className="pt-0.5 text-xs text-[#6E788A] select-none">
                    Continues in full text <span aria-hidden="true">·</span>{' '}
                    <button
                      type="button"
                      onClick={onInspectSource}
                      className="font-medium text-[#67E8F9] hover:text-[#22D3EE] hover:underline whitespace-nowrap cursor-pointer"
                    >
                      Read all passages in Source Guide
                    </button>
                  </p>
                )}
              </div>
            )}
          </div>

          {pendingSelection && onAddHighlight && (
            <div
              role="region"
              aria-label="Save selected phrase highlight"
              className="mt-2 px-3 py-2 rounded-md bg-[#101822] border border-[#22D3EE]/55 flex flex-wrap items-center justify-between gap-2.5"
            >
              <p className="text-xs text-[#D5DCE6] min-w-0 flex-1 truncate">
                <span className="font-mono text-[11px] text-[#67E8F9] mr-1.5">
                  Selected:
                </span>
                “{pendingSelection}”
              </p>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={isAlreadyHighlighted}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleConfirmHighlight}
                  className="h-7 px-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 disabled:cursor-default rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Highlighter className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {isAlreadyHighlighted
                      ? 'Already Highlighted'
                      : atHighlightCap
                        ? 'Save Highlight (replaces oldest)'
                        : 'Save Highlight'}
                  </span>
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleDismissSelection}
                  className="h-7 px-2 text-xs text-[#8C96A8] hover:text-[#F5F7FA] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {highlights.length > 0 && (
        <div
          className={`${
            snippet ? 'mt-2.5 pt-2 border-t border-[#1A202B]' : ''
          } space-y-1.5`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
            <div className="flex items-center gap-1.5 text-[#67E8F9]">
              <Highlighter className="w-3 h-3 text-[#22D3EE] shrink-0" aria-hidden="true" />
              <span>Saved for Briefing</span>
              <span aria-hidden="true" className="text-[#4B5565]">
                ·
              </span>
              <span>
                {highlights.length} {highlights.length === 1 ? 'phrase' : 'phrases'}
              </span>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => {
                  void handleCopyHighlightsMarkdown();
                }}
                aria-live="polite"
                aria-label={`Copy ${highlights.length} highlighted ${
                  highlights.length === 1 ? 'passage' : 'passages'
                } and source citations to clipboard as Markdown`}
                title="Copy highlighted passages with source citations as Markdown"
                className={`h-6 px-2 inline-flex items-center gap-1.5 font-sans text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  copiedMarkdown
                    ? 'bg-[#132630] text-[#67E8F9] border-[#22D3EE]/65'
                    : 'bg-[#121720] text-[#D5DCE6] border-[#273142] hover:border-[#22D3EE]/55 hover:text-[#67E8F9]'
                }`}
              >
                {copiedMarkdown ? (
                  <>
                    <Check className="w-3 h-3 text-[#22D3EE] shrink-0" aria-hidden="true" />
                    <span>Copied Markdown</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 text-[#22D3EE] shrink-0" aria-hidden="true" />
                    <span>Copy to Clipboard</span>
                  </>
                )}
              </button>

              {onRemoveHighlight && highlights.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveHighlight()}
                  className="text-[#6E788A] hover:text-[#F87171] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>

          <ul className="space-y-1.5">
            {highlights.map((hl) => (
              <li
                key={hl.id}
                className="flex items-start justify-between gap-2.5 text-xs text-[#D5DCE6] leading-snug"
              >
                <div className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[#E4E9F1]">“{hl.text}”</span>
                  {hl.passageIndex > 0 && onInspectHighlight && (
                    <button
                      type="button"
                      onClick={() => onInspectHighlight(hl.passageIndex, hl.text)}
                      className="font-mono text-[11px] text-[#67E8F9] hover:text-[#22D3EE] hover:underline tabular-nums whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Passage {hl.passageIndex}
                    </button>
                  )}
                </div>
                {onRemoveHighlight && (
                  <button
                    type="button"
                    onClick={() => onRemoveHighlight(hl.id)}
                    aria-label={`Remove highlight "${hl.text.slice(0, 40)}"`}
                    className="p-0.5 text-[#6E788A] hover:text-[#F87171] rounded transition-colors shrink-0 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ArticleDeskView({
  articles,
  readLaterArticles,
  queueTab,
  onQueueTabChange,
  preferences,
  onPreferencesChange,
  onOpenAddModal,
  onInspectSource,
  onInspectHighlight,
  onAddHighlight,
  onRemoveHighlight,
  onToggleArticle,
  onToggleAll,
  onBulkToggleCategory,
  onToggleReadLater,
  onRestoreAllReadLater,
  onRemoveArticle,
  onResetSamples,
  onRefreshAllArticles,
  isRefreshingArticles,
  refreshArticlesStatus,
  refreshArticlesError,
  onDismissRefreshError,
  onGenerateHighlightsSummary,
  isGeneratingHighlightsSummary = false,
  hasSavedHighlightsSummary = false,
  onOpenSavedHighlightsSummary,
  onBuildBriefing,
  isGenerating,
  generationStatus,
  generationError,
  onProjectArticleTo3D,
}: ArticleDeskViewProps) {
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  const [internalDeskTab, setInternalDeskTab] = useState<'active' | 'readLater'>(
    'active'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [readLaterCategoryFilter, setReadLaterCategoryFilter] = useState<string | null>(
    null
  );
  const [expandedSnippets, setExpandedSnippets] = useState<Record<string, boolean>>(
    {}
  );

  const deskTab: 'active' | 'readLater' = queueTab ?? internalDeskTab;

  const setDeskTab = (next: 'active' | 'readLater') => {
    setInternalDeskTab(next);
    onQueueTabChange?.(next);
  };

  const toggleSnippet = (articleId: string) => {
    setExpandedSnippets((prev) => ({
      ...prev,
      [articleId]: !prev[articleId],
    }));
  };

  const selectedArticles = articles.filter((a) => a.selected);
  const selectedHighlightCount = selectedArticles.reduce(
    (sum, a) => sum + (a.highlights?.length || 0),
    0
  );
  const selectedHighlightedSourceCount = selectedArticles.filter(
    (a) => (a.highlights?.length || 0) > 0
  ).length;
  const allDeskArticles = useMemo(
    () => [...articles, ...readLaterArticles],
    [articles, readLaterArticles]
  );
  const totalHighlightCount = useMemo(
    () =>
      allDeskArticles.reduce((sum, a) => sum + (a.highlights?.length || 0), 0),
    [allDeskArticles]
  );
  const totalHighlightedSourceCount = useMemo(
    () => allDeskArticles.filter((a) => (a.highlights?.length || 0) > 0).length,
    [allDeskArticles]
  );
  const totalReadMinutes = selectedArticles.reduce(
    (sum, a) => sum + (a.estimatedReadMinutes || 3),
    0
  );
  const readLaterReadMinutes = readLaterArticles.reduce(
    (sum, a) => sum + (a.estimatedReadMinutes || 3),
    0
  );
  const totalSourcesCount = articles.length + readLaterArticles.length;
  const urlSourcesCount = allDeskArticles.filter((a) => {
    if (a.driveFileId) return false;
    const rawUrl = a.url?.trim();
    return Boolean(rawUrl && /^https?:\/\//i.test(rawUrl));
  }).length;

  const categoryGroups = useMemo(() => {
    const groups = new Map<
      string,
      { label: string; total: number; selected: number }
    >();
    for (const article of articles) {
      const label = (article.category || '').trim() || 'General';
      const key = label.toLowerCase();
      const existing = groups.get(key);
      if (existing) {
        existing.total += 1;
        if (article.selected) existing.selected += 1;
      } else {
        groups.set(key, {
          label,
          total: 1,
          selected: article.selected ? 1 : 0,
        });
      }
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.label.localeCompare(b.label);
    });
  }, [articles]);

  const readLaterCategoryGroups = useMemo(() => {
    const groups = new Map<string, { label: string; count: number }>();
    for (const article of readLaterArticles) {
      const label = (article.category || '').trim() || 'General';
      const key = label.toLowerCase();
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(key, { label, count: 1 });
      }
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
  }, [readLaterArticles]);

  const effectiveReadLaterCategory =
    readLaterCategoryFilter &&
    readLaterCategoryGroups.some(
      (g) => g.label.toLowerCase() === readLaterCategoryFilter.toLowerCase()
    )
      ? readLaterCategoryFilter
      : null;

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredActiveArticles = useMemo(() => {
    if (!normalizedQuery) return articles;
    return articles.filter((a) => {
      const highlightHay = (a.highlights || []).map((h) => h.text).join(' ');
      const hay = `${a.title} ${a.source} ${a.category} ${a.summary} ${(a.tags || []).join(' ')} ${highlightHay}`.toLowerCase();
      return hay.includes(normalizedQuery);
    });
  }, [articles, normalizedQuery]);

  const filteredReadLaterArticles = useMemo(() => {
    return readLaterArticles.filter((a) => {
      if (effectiveReadLaterCategory) {
        const label = ((a.category || '').trim() || 'General').toLowerCase();
        if (label !== effectiveReadLaterCategory.toLowerCase()) return false;
      }
      if (!normalizedQuery) return true;
      const highlightHay = (a.highlights || []).map((h) => h.text).join(' ');
      const hay = `${a.title} ${a.source} ${a.category} ${a.summary} ${(a.tags || []).join(' ')} ${highlightHay}`.toLowerCase();
      return hay.includes(normalizedQuery);
    });
  }, [readLaterArticles, effectiveReadLaterCategory, normalizedQuery]);

  const todayFormatted = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date());

  return (
    <div className="max-w-[1180px] mx-auto px-5 sm:px-8 py-7 sm:py-9">
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
        {/* Left Main Editorial Desk (7 cols) */}
        <div className="xl:col-span-7 space-y-7">
          {/* Editorial Marquee Banner */}
          <section className="relative overflow-hidden rounded-lg border border-[#22D3EE]/30 bg-[#13161C]">
            <div className="relative aspect-[16/7] w-full">
              {!failedImages['cover'] ? (
                <img
                  src={EDITION_COVER_IMAGE}
                  alt="Morning commuter train window overlooking a city skyline at dawn"
                  referrerPolicy="no-referrer"
                  onError={() => setFailedImages((prev) => ({ ...prev, cover: true }))}
                  className="w-full h-full object-cover opacity-80"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-[#161D28] via-[#10141B] to-[#0B0D10]" />
              )}
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-[#0B0D10] via-[#0B0D10]/55 to-transparent"
              />
              <div className="absolute inset-x-0 bottom-0 p-6 sm:p-7 flex flex-col justify-end">
                <p className="font-mono text-xs tracking-wider text-[#67E8F9] tabular-nums">
                  {todayFormatted} · Audio Research Notebook
                </p>
                <h1 className="mt-2 font-serif text-2xl sm:text-3xl font-medium text-[#F5F7FA] leading-tight max-w-xl">
                  Turn your documents and news queue into a cited audio briefing.
                </h1>
              </div>
            </div>
          </section>

          {/* Quick Add Sources Strip */}
          <section
            aria-label="Add documents or articles"
            className="bg-[#13161C] border border-[#22D3EE]/30 rounded-lg p-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="font-serif text-lg font-medium text-[#F5F7FA]">
                  Add your own sources
                </h2>
                <p className="text-xs text-[#A0AABB] mt-0.5">
                  Upload PDF, Word (DOCX), TXT, or Markdown files—or queue any news link.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onOpenAddModal('upload')}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                  Upload File
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAddModal('drive')}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#181D26] hover:bg-[#1F2734] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <HardDrive className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Google Drive
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAddModal('url')}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#181D26] hover:bg-[#1F2734] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Link2 className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Add URL
                </button>
                <button
                  type="button"
                  onClick={() => onOpenAddModal('text')}
                  className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#181D26] hover:bg-[#1F2734] border border-[#2A3342] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Paste Text
                </button>
              </div>
            </div>
          </section>

          {/* Active Sources & Read Later Workspace Overview */}
          <section aria-label="Queued sources">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-[#22D3EE]/35">
              <div className="flex flex-wrap items-center gap-4">
                <div
                  role="tablist"
                  aria-label="Toggle between Active Sources and Read Later queues"
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                      e.preventDefault();
                      setDeskTab(deskTab === 'active' ? 'readLater' : 'active');
                    }
                  }}
                  className="inline-flex items-center gap-1 p-1 bg-[#13161C] border border-[#273040] rounded-md"
                >
                  <button
                    id="studio-desk-tab-active"
                    type="button"
                    role="tab"
                    aria-selected={deskTab === 'active'}
                    aria-controls="studio-desk-panel-active"
                    onClick={() => setDeskTab('active')}
                    className={`h-8 px-3.5 inline-flex items-center gap-2 text-xs font-semibold rounded transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${
                      deskTab === 'active'
                        ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/55'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    <span>Active Sources</span>
                    <span className="font-mono text-[11px] opacity-90">
                      ({articles.length})
                    </span>
                  </button>
                  <button
                    id="studio-desk-tab-read-later"
                    type="button"
                    role="tab"
                    aria-selected={deskTab === 'readLater'}
                    aria-controls="studio-desk-panel-read-later"
                    onClick={() => setDeskTab('readLater')}
                    className={`h-8 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold rounded transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${
                      deskTab === 'readLater'
                        ? 'bg-[#182430] text-[#67E8F9] border border-[#22D3EE]/55'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    <Bookmark className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Read Later</span>
                    <span className="font-mono text-[11px] opacity-90">
                      ({readLaterArticles.length})
                    </span>
                  </button>
                </div>

                {deskTab === 'active' ? (
                  <span className="text-xs font-mono text-[#8C96A8] tabular-nums">
                    {selectedArticles.length} selected · {totalReadMinutes} min source read
                  </span>
                ) : (
                  <span className="text-xs font-mono text-[#8C96A8] tabular-nums">
                    {readLaterArticles.length}{' '}
                    {readLaterArticles.length === 1 ? 'article' : 'articles'} shelved ·{' '}
                    {readLaterReadMinutes} min saved read
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs font-medium">
                {onGenerateHighlightsSummary && (
                  <button
                    type="button"
                    onClick={() => {
                      void onGenerateHighlightsSummary();
                    }}
                    disabled={totalHighlightCount === 0 || isGeneratingHighlightsSummary}
                    title={
                      totalHighlightCount > 0
                        ? `Synthesize a meta-briefing summary from ${totalHighlightCount} ${
                            totalHighlightCount === 1 ? 'highlight' : 'highlights'
                          } across ${totalHighlightedSourceCount} ${
                            totalHighlightedSourceCount === 1 ? 'source' : 'sources'
                          }`
                        : 'Select phrases inside any article snippet first to generate a meta-briefing summary'
                    }
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#131F2B] hover:bg-[#182938] border border-[#22D3EE]/50 hover:border-[#67E8F9] disabled:opacity-45 disabled:pointer-events-none rounded-md transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {isGeneratingHighlightsSummary ? (
                      <Loader2
                        className="w-3.5 h-3.5 text-[#22D3EE] animate-spin shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <Highlighter
                        className="w-3.5 h-3.5 text-[#22D3EE] shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      {isGeneratingHighlightsSummary
                        ? 'Synthesizing Highlights...'
                        : totalHighlightCount > 0
                          ? `Generate Summary from Highlights (${totalHighlightCount})`
                          : 'Generate Summary from Highlights'}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    void onRefreshAllArticles();
                  }}
                  disabled={totalSourcesCount === 0 || isRefreshingArticles}
                  title={
                    urlSourcesCount > 0
                      ? `Re-fetch ${urlSourcesCount} URL ${
                          urlSourcesCount === 1 ? 'source' : 'sources'
                        } and regenerate automatic tags`
                      : 'Regenerate automatic tags for current sources'
                  }
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#161B23] hover:bg-[#1D2532] border border-[#2A3342] hover:border-[#22D3EE]/60 disabled:opacity-45 disabled:pointer-events-none rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 text-[#22D3EE] shrink-0 ${
                      isRefreshingArticles ? 'animate-spin' : ''
                    }`}
                    aria-hidden="true"
                  />
                  <span>
                    {isRefreshingArticles
                      ? 'Refreshing Articles...'
                      : 'Refresh All Articles'}
                  </span>
                </button>

                {deskTab === 'active' ? (
                  <>
                    {articles.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          onToggleAll(selectedArticles.length !== articles.length)
                        }
                        className="text-[#67E8F9] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {selectedArticles.length === articles.length
                          ? 'Deselect all'
                          : 'Select all'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onResetSamples}
                      className="inline-flex items-center gap-1 text-[#8C96A8] hover:text-[#F5F7FA] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                      Load samples
                    </button>
                  </>
                ) : (
                  readLaterArticles.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        onRestoreAllReadLater();
                        setDeskTab('active');
                      }}
                      className="inline-flex items-center gap-1.5 text-[#67E8F9] hover:text-[#22D3EE] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <ArrowUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
                      Move all to Active Sources
                    </button>
                  )
                )}
              </div>
            </div>

            {totalSourcesCount > 0 && (
              <div className="py-3 border-b border-[#1E2430] flex items-center gap-2.5">
                <div className="relative flex-1">
                  <Search
                    className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={
                      deskTab === 'active'
                        ? 'Filter Active Sources by title, topic, or publication...'
                        : 'Filter Read Later articles by title, topic, or publication...'
                    }
                    aria-label={
                      deskTab === 'active'
                        ? 'Filter Active Sources'
                        : 'Filter Read Later articles'
                    }
                    className="w-full h-9 pl-9 pr-8 text-xs text-[#F5F7FA] placeholder:text-[#6E788A] bg-[#0E1116] border border-[#222833] focus:border-[#22D3EE]/60 rounded-md outline-none transition-colors"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      aria-label="Clear filter query"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6E788A] hover:text-[#F5F7FA] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {isRefreshingArticles && refreshArticlesStatus && (
              <div
                role="status"
                aria-live="polite"
                className="mt-3 px-3.5 py-2.5 rounded-md border border-[#22D3EE]/35 bg-[#121A24] flex items-center gap-2.5 text-xs text-[#67E8F9]"
              >
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE] shrink-0" aria-hidden="true" />
                <span className="font-mono tabular-nums truncate">
                  {refreshArticlesStatus}
                </span>
              </div>
            )}

            {!isRefreshingArticles && refreshArticlesError && (
              <div
                role="alert"
                className="mt-3 px-3.5 py-2.5 rounded-md border border-amber-500/35 bg-amber-950/25 flex items-start justify-between gap-3 text-xs text-amber-200"
              >
                <div className="flex items-start gap-2 min-w-0">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <span className="leading-relaxed">{refreshArticlesError}</span>
                </div>
                <button
                  type="button"
                  onClick={onDismissRefreshError}
                  aria-label="Dismiss refresh notice"
                  className="p-0.5 text-amber-300/80 hover:text-amber-100 rounded cursor-pointer shrink-0"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            )}

            {deskTab === 'active' ? (
              <div
                id="studio-desk-panel-active"
                role="tabpanel"
                aria-labelledby="studio-desk-tab-active"
              >
                {articles.length === 0 ? (
                <div className="py-14 text-center border-b border-[#222833]">
                  <p className="font-serif text-lg text-[#F5F7FA]">
                    Active workspace is clear
                  </p>
                  <p className="mt-1.5 text-sm text-[#A0AABB] max-w-md mx-auto">
                    {readLaterArticles.length > 0
                      ? `You have ${readLaterArticles.length} ${readLaterArticles.length === 1 ? 'article' : 'articles'} saved in your Read Later queue. Restore them anytime or upload fresh sources.`
                      : 'Upload a PDF, Word document, Markdown note, or paste a news article URL—or load sample stories to try Dispatch immediately.'}
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                    {readLaterArticles.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setDeskTab('readLater')}
                        className="px-4 py-2 inline-flex items-center gap-1.5 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors cursor-pointer"
                      >
                        <Bookmark className="w-4 h-4" aria-hidden="true" />
                        View Read Later ({readLaterArticles.length})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenAddModal('upload')}
                      className={`px-4 py-2 text-sm font-semibold rounded-md transition-colors cursor-pointer ${
                        readLaterArticles.length > 0
                          ? 'text-[#F5F7FA] border border-[#2C3546] hover:border-[#22D3EE]/60'
                          : 'text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9]'
                      }`}
                    >
                      Upload Document
                    </button>
                    <button
                      type="button"
                      onClick={onResetSamples}
                      className="px-4 py-2 text-sm font-medium text-[#F5F7FA] border border-[#2C3546] hover:border-[#22D3EE]/60 rounded-md transition-colors cursor-pointer"
                    >
                      Load 3 Samples
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {categoryGroups.length > 0 && (
                    <div
                      role="region"
                      aria-label="Bulk Toggle by Source Category"
                      className="py-3.5 border-b border-[#1E2430] space-y-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold text-[#F5F7FA]">
                            Bulk Toggle
                          </span>
                          <span aria-hidden="true" className="text-[#4B5565]">
                            ·
                          </span>
                          <span className="text-[#8C96A8]">
                            Click a source category to select or deselect matching articles
                          </span>
                        </div>
                        <span className="font-mono text-[11px] text-[#6E788A] tabular-nums">
                          {categoryGroups.length}{' '}
                          {categoryGroups.length === 1 ? 'category' : 'categories'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {categoryGroups.map((group) => {
                          const allInCategorySelected =
                            group.total > 0 && group.selected === group.total;
                          const someInCategorySelected =
                            group.selected > 0 && group.selected < group.total;

                          return (
                            <button
                              key={group.label.toLowerCase()}
                              type="button"
                              role="checkbox"
                              aria-checked={
                                allInCategorySelected
                                  ? true
                                  : someInCategorySelected
                                    ? 'mixed'
                                    : false
                              }
                              aria-label={`${
                                allInCategorySelected ? 'Deselect' : 'Select'
                              } all ${group.label} articles (${group.selected} of ${
                                group.total
                              } selected)`}
                              onClick={() =>
                                onBulkToggleCategory(
                                  group.label,
                                  !allInCategorySelected
                                )
                              }
                              className={`h-8 px-2.5 inline-flex items-center gap-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                allInCategorySelected
                                  ? 'bg-[#16222E] text-[#F5F7FA] border-[#22D3EE]/60 hover:border-[#67E8F9]'
                                  : someInCategorySelected
                                    ? 'bg-[#131C26] text-[#D5DCE6] border-[#22D3EE]/35 hover:border-[#22D3EE]/65'
                                    : 'bg-[#11151C] text-[#8C96A8] border-[#222833] hover:border-[#22D3EE]/45 hover:text-[#F5F7FA]'
                              }`}
                            >
                              <span
                                aria-hidden="true"
                                className={`w-3.5 h-3.5 rounded-xs border flex items-center justify-center shrink-0 transition-colors ${
                                  allInCategorySelected
                                    ? 'bg-[#22D3EE] border-[#22D3EE] text-[#071318]'
                                    : someInCategorySelected
                                      ? 'bg-[#182430] border-[#22D3EE] text-[#67E8F9]'
                                      : 'bg-[#0B0D10] border-[#394457]'
                                }`}
                              >
                                {allInCategorySelected ? (
                                  <Check className="w-2.5 h-2.5" strokeWidth={3} />
                                ) : someInCategorySelected ? (
                                  <Minus className="w-2.5 h-2.5" strokeWidth={3} />
                                ) : null}
                              </span>
                              <span>{group.label}</span>
                              <span className="font-mono text-[11px] text-[#67E8F9]/85 tabular-nums">
                                {group.selected}/{group.total}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {filteredActiveArticles.length === 0 ? (
                    <div className="py-10 text-center border-b border-[#222833]">
                      <p className="text-sm text-[#A0AABB]">
                        No Active Sources match{' '}
                        <span className="font-mono text-[#67E8F9]">
                          "{searchQuery.trim()}"
                        </span>
                        .
                      </p>
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="mt-2.5 text-xs font-medium text-[#22D3EE] hover:underline cursor-pointer"
                      >
                        Clear search filter
                      </button>
                    </div>
                  ) : (
                    <ul className="divide-y divide-[#1E2430]">
                      {filteredActiveArticles.map((article, index) => {
                        const hasWorkingImg =
                          Boolean(article.imageUrl) && !failedImages[article.id];
                        const passageCount = article.passages?.length || 0;

                    return (
                      <li
                        key={article.id}
                        className={`py-5 transition-opacity duration-150 ${
                          article.selected ? 'opacity-100' : 'opacity-50'
                        }`}
                      >
                        <div className="flex items-start gap-4">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={article.selected}
                            aria-label={`Include "${article.title}" in briefing`}
                            onClick={() => onToggleArticle(article.id)}
                            className={`mt-1 w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                              article.selected
                                ? 'bg-[#22D3EE] border-[#22D3EE] text-[#071318]'
                                : 'bg-[#0E1116] border-[#394457] hover:border-[#22D3EE]'
                            }`}
                          >
                            {article.selected && <Check className="w-3.5 h-3.5" strokeWidth={2.75} />}
                          </button>

                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8]">
                              <span className="font-mono tabular-nums text-[#6E788A]">
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-medium text-[#22D3EE]">
                                {formatSourceType(article.sourceType)}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{article.category}</span>
                              <span aria-hidden="true">·</span>
                              <span className="truncate max-w-[180px]">{article.source}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {article.estimatedReadMinutes} min
                                {passageCount > 0 ? ` · ${passageCount} passages` : ''}
                              </span>
                              {(article.highlights?.length ?? 0) > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono tabular-nums text-[#67E8F9]">
                                    {article.highlights!.length} highlighted
                                  </span>
                                </>
                              )}
                            </div>

                            <button
                              type="button"
                              onClick={() => onInspectSource(article.id)}
                              className="mt-1.5 text-left font-serif text-lg font-medium text-[#F5F7FA] hover:text-[#67E8F9] transition-colors leading-snug cursor-pointer"
                            >
                              {article.title}
                            </button>

                            <p className="mt-2 text-sm text-[#A0AABB] leading-relaxed max-w-2xl">
                              {article.summary}
                            </p>

                            <ArticleSnippetPreview
                              article={article}
                              isExpanded={Boolean(expandedSnippets[article.id])}
                              onToggleExpand={() => toggleSnippet(article.id)}
                              onInspectSource={() => onInspectSource(article.id)}
                              onInspectHighlight={
                                onInspectHighlight
                                  ? (passageIndex, excerpt) =>
                                      onInspectHighlight(article.id, passageIndex, excerpt)
                                  : undefined
                              }
                              onAddHighlight={
                                onAddHighlight
                                  ? (phrase) => onAddHighlight(article.id, phrase)
                                  : undefined
                              }
                              onRemoveHighlight={
                                onRemoveHighlight
                                  ? (highlightId) =>
                                      onRemoveHighlight(article.id, highlightId)
                                  : undefined
                              }
                            />

                            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
                              <button
                                type="button"
                                onClick={() => onInspectSource(article.id)}
                                className="inline-flex items-center gap-1.5 font-medium text-[#67E8F9] hover:text-[#22D3EE] transition-colors cursor-pointer"
                              >
                                <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                                Open Source Guide
                              </button>

                              <button
                                type="button"
                                onClick={() => onToggleReadLater(article.id)}
                                className="inline-flex items-center gap-1.5 text-[#A0AABB] hover:text-[#67E8F9] transition-colors cursor-pointer"
                              >
                                <Bookmark className="w-3.5 h-3.5" aria-hidden="true" />
                                Read Later
                              </button>

                              {onProjectArticleTo3D && (
                                <button
                                  type="button"
                                  onClick={() => onProjectArticleTo3D(article)}
                                  className="inline-flex items-center gap-1.5 text-[#A0AABB] hover:text-[#67E8F9] transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  <Box className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                                  3D Foil Card
                                </button>
                              )}

                              {article.driveWebViewLink ? (
                                <a
                                  href={article.driveWebViewLink}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[#8C96A8] hover:text-[#67E8F9] transition-colors whitespace-nowrap"
                                >
                                  Open in Drive
                                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                                </a>
                              ) : article.url ? (
                                <a
                                  href={article.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[#8C96A8] hover:text-[#F5F7FA] transition-colors whitespace-nowrap"
                                >
                                  Source link
                                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                                </a>
                              ) : null}

                              <button
                                type="button"
                                onClick={() => onRemoveArticle(article.id)}
                                className="inline-flex items-center gap-1 text-[#6E788A] hover:text-[#F87171] transition-colors cursor-pointer ml-auto"
                              >
                                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                Remove
                              </button>
                            </div>
                          </div>

                          {article.imageUrl && (
                            <div className="hidden sm:block w-24 aspect-[4/3] rounded overflow-hidden border border-[#222833] bg-[#0E1116] shrink-0">
                              {hasWorkingImg ? (
                                <img
                                  src={article.imageUrl}
                                  alt={article.title}
                                  referrerPolicy="no-referrer"
                                  onError={() =>
                                    setFailedImages((prev) => ({
                                      ...prev,
                                      [article.id]: true,
                                    }))
                                  }
                                  className="w-full h-full object-cover opacity-90"
                                />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center font-serif text-lg text-[#6E788A]">
                                  {article.category.slice(0, 1)}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                    </ul>
                  )}
                </>
                )}
              </div>
            ) : (
              <div
                id="studio-desk-panel-read-later"
                role="tabpanel"
                aria-labelledby="studio-desk-tab-read-later"
              >
                {readLaterArticles.length === 0 ? (
                  <div className="py-14 text-center border-b border-[#222833]">
                    <Bookmark className="w-6 h-6 mx-auto text-[#394457]" aria-hidden="true" />
                    <p className="mt-3 font-serif text-lg text-[#F5F7FA]">
                      Your Read Later queue is empty
                    </p>
                    <p className="mt-1.5 text-sm text-[#A0AABB] max-w-md mx-auto">
                      Click <span className="text-[#67E8F9]">Read Later</span> on any article in Active Sources or the sidebar to shelve it out of audio briefings for later reading.
                    </p>
                    {articles.length > 0 && (
                      <div className="mt-5 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setDeskTab('active')}
                          className="px-4 py-2 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors tabular-nums whitespace-nowrap cursor-pointer"
                        >
                          Browse Active Sources ({articles.length})
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {readLaterCategoryGroups.length > 1 && (
                      <div
                        role="region"
                        aria-label="Filter Read Later articles by category"
                        className="py-3 border-b border-[#1E2430] flex flex-wrap items-center gap-2"
                      >
                        <span className="text-xs font-semibold text-[#F5F7FA] mr-1">
                          Category
                        </span>
                        <button
                          type="button"
                          onClick={() => setReadLaterCategoryFilter(null)}
                          aria-pressed={effectiveReadLaterCategory === null}
                          className={`h-7 px-2.5 font-mono text-[11px] rounded border transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${
                            effectiveReadLaterCategory === null
                              ? 'bg-[#16222E] text-[#67E8F9] border-[#22D3EE]/60'
                              : 'bg-[#11151C] text-[#8C96A8] border-[#222833] hover:border-[#22D3EE]/40 hover:text-[#F5F7FA]'
                          }`}
                        >
                          All ({readLaterArticles.length})
                        </button>
                        {readLaterCategoryGroups.map((group) => {
                          const isSelected =
                            effectiveReadLaterCategory?.toLowerCase() ===
                            group.label.toLowerCase();
                          return (
                            <button
                              key={group.label.toLowerCase()}
                              type="button"
                              onClick={() =>
                                setReadLaterCategoryFilter(
                                  isSelected ? null : group.label
                                )
                              }
                              aria-pressed={isSelected}
                              className={`h-7 px-2.5 font-mono text-[11px] rounded border transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${
                                isSelected
                                  ? 'bg-[#16222E] text-[#67E8F9] border-[#22D3EE]/60'
                                  : 'bg-[#11151C] text-[#8C96A8] border-[#222833] hover:border-[#22D3EE]/40 hover:text-[#F5F7FA]'
                              }`}
                            >
                              {group.label} · {group.count}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {filteredReadLaterArticles.length === 0 ? (
                      <div className="py-10 text-center border-b border-[#222833]">
                        <p className="text-sm text-[#A0AABB]">
                          No Read Later articles match your current filter.
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setReadLaterCategoryFilter(null);
                          }}
                          className="mt-2.5 text-xs font-medium text-[#22D3EE] hover:underline cursor-pointer"
                        >
                          Reset Read Later filters
                        </button>
                      </div>
                    ) : (
                      <ul className="divide-y divide-[#1E2430]">
                        {filteredReadLaterArticles.map((article, index) => {
                          const passageCount = article.passages?.length || 0;
                          const shelvedLabel = formatShelvedDate(article.shelvedAt);
                          const hasWorkingImg =
                            Boolean(article.imageUrl) && !failedImages[article.id];

                          return (
                            <li key={article.id} className="py-5">
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C96A8]">
                                    <span className="font-mono tabular-nums text-[#6E788A]">
                                      {String(index + 1).padStart(2, '0')}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-medium text-[#22D3EE]">
                                      {formatSourceType(article.sourceType)}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span>{article.category}</span>
                                    <span aria-hidden="true">·</span>
                                    <span className="truncate max-w-[180px]">
                                      {article.source}
                                    </span>
                                    <span aria-hidden="true">·</span>
                                    <span className="font-mono tabular-nums">
                                      {article.estimatedReadMinutes} min
                                      {passageCount > 0
                                        ? ` · ${passageCount} passages`
                                        : ''}
                                    </span>
                                    {(article.highlights?.length ?? 0) > 0 && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span className="font-mono tabular-nums text-[#67E8F9]">
                                          {article.highlights!.length} highlighted
                                        </span>
                                      </>
                                    )}
                                    {shelvedLabel && (
                                      <>
                                        <span aria-hidden="true">·</span>
                                        <span className="font-mono tabular-nums text-[#67E8F9]/80">
                                          Shelved {shelvedLabel}
                                        </span>
                                      </>
                                    )}
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => onInspectSource(article.id)}
                                    className="mt-1.5 text-left font-serif text-lg font-medium text-[#F5F7FA] hover:text-[#67E8F9] transition-colors leading-snug cursor-pointer"
                                  >
                                    {article.title}
                                  </button>

                                  <p className="mt-2 text-sm text-[#A0AABB] leading-relaxed max-w-2xl">
                                    {article.summary}
                                  </p>

                                  <ArticleSnippetPreview
                                    article={article}
                                    isExpanded={Boolean(expandedSnippets[article.id])}
                                    onToggleExpand={() => toggleSnippet(article.id)}
                                    onInspectSource={() => onInspectSource(article.id)}
                                    onInspectHighlight={
                                      onInspectHighlight
                                        ? (passageIndex, excerpt) =>
                                            onInspectHighlight(
                                              article.id,
                                              passageIndex,
                                              excerpt
                                            )
                                        : undefined
                                    }
                                    onAddHighlight={
                                      onAddHighlight
                                        ? (phrase) => onAddHighlight(article.id, phrase)
                                        : undefined
                                    }
                                    onRemoveHighlight={
                                      onRemoveHighlight
                                        ? (highlightId) =>
                                            onRemoveHighlight(article.id, highlightId)
                                        : undefined
                                    }
                                  />

                                  <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
                                    <button
                                      type="button"
                                      onClick={() => onToggleReadLater(article.id)}
                                      className="inline-flex items-center gap-1.5 font-medium text-[#22D3EE] hover:text-[#67E8F9] transition-colors whitespace-nowrap cursor-pointer"
                                    >
                                      <ArrowUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
                                      Move to Active Sources
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => onInspectSource(article.id)}
                                      className="inline-flex items-center gap-1.5 text-[#A0AABB] hover:text-[#F5F7FA] transition-colors whitespace-nowrap cursor-pointer"
                                    >
                                      <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                                      Open Source Guide
                                    </button>

                                    {onProjectArticleTo3D && (
                                      <button
                                        type="button"
                                        onClick={() => onProjectArticleTo3D(article)}
                                        className="inline-flex items-center gap-1.5 text-[#A0AABB] hover:text-[#67E8F9] transition-colors cursor-pointer whitespace-nowrap"
                                      >
                                        <Box className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                                        3D Foil Card
                                      </button>
                                    )}

                                    {article.driveWebViewLink ? (
                                      <a
                                        href={article.driveWebViewLink}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-[#8C96A8] hover:text-[#67E8F9] transition-colors whitespace-nowrap"
                                      >
                                        Open in Drive
                                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                                      </a>
                                    ) : article.url ? (
                                      <a
                                        href={article.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-[#8C96A8] hover:text-[#F5F7FA] transition-colors whitespace-nowrap"
                                      >
                                        Source link
                                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                                      </a>
                                    ) : null}

                                    <button
                                      type="button"
                                      onClick={() => onRemoveArticle(article.id)}
                                      className="inline-flex items-center gap-1 text-[#6E788A] hover:text-[#F87171] transition-colors cursor-pointer ml-auto"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                      Delete
                                    </button>
                                  </div>
                                </div>

                                {article.imageUrl && (
                                  <div className="hidden sm:block w-24 aspect-[4/3] rounded overflow-hidden border border-[#222833] bg-[#0E1116] shrink-0">
                                    {hasWorkingImg ? (
                                      <img
                                        src={article.imageUrl}
                                        alt={article.title}
                                        referrerPolicy="no-referrer"
                                        onError={() =>
                                          setFailedImages((prev) => ({
                                            ...prev,
                                            [article.id]: true,
                                          }))
                                        }
                                        className="w-full h-full object-cover opacity-90"
                                      />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center font-serif text-lg text-[#6E788A]">
                                        {article.category.slice(0, 1)}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Right Personalization Studio Panel (5 cols) */}
        <aside className="xl:col-span-5 xl:sticky xl:top-24 bg-[#13161C] border border-[#22D3EE]/35 rounded-lg p-6 space-y-6">
          <div className="pb-4 border-b border-[#222833]">
            <h2 className="font-serif text-xl font-medium text-[#F5F7FA]">
              Briefing Studio
            </h2>
            <p className="text-sm text-[#A0AABB] mt-1">
              Tailor length, voice cast, and angle for your active sources.
            </p>
          </div>

          {/* Commute Duration */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-[#F5F7FA]">
                Commute Length
              </label>
              <span className="text-xs font-mono text-[#67E8F9] tabular-nums">
                ~{preferences.durationMinutes} min audio
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#0E1116] border border-[#222833] rounded-md">
              {DURATION_OPTIONS.map((opt) => {
                const active = preferences.durationMinutes === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      onPreferencesChange({ ...preferences, durationMinutes: opt.value })
                    }
                    className={`py-2 px-2 rounded text-center transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#18212E] text-[#F5F7FA] border border-[#22D3EE]/55'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    <span className="block text-sm font-semibold tabular-nums whitespace-nowrap">
                      {opt.label}
                    </span>
                    <span className="block text-[11px] text-[#6E788A] whitespace-nowrap">
                      {opt.note}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Broadcast Format */}
          <div>
            <label className="block text-xs font-semibold text-[#F5F7FA] mb-2">
              Broadcast Format
            </label>
            <div className="grid grid-cols-2 gap-2">
              {FORMAT_OPTIONS.map((opt) => {
                const active = preferences.format === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      onPreferencesChange({ ...preferences, format: opt.value })
                    }
                    className={`p-3 text-left rounded-md border transition-colors cursor-pointer ${
                      active
                        ? 'border-[#22D3EE]/70 bg-[#22D3EE]/[0.08]'
                        : 'border-[#222833] bg-[#0E1116] hover:border-[#394457]'
                    }`}
                  >
                    <span className="block text-sm font-medium text-[#F5F7FA] whitespace-nowrap">
                      {opt.label}
                    </span>
                    <span className="block text-xs text-[#8C96A8] mt-0.5 leading-snug">
                      {opt.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Editorial Tone */}
          <div>
            <label className="block text-xs font-semibold text-[#F5F7FA] mb-2">
              Editorial Tone
            </label>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#0E1116] border border-[#222833] rounded-md">
              {TONE_OPTIONS.map((opt) => {
                const active = preferences.tone === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      onPreferencesChange({ ...preferences, tone: opt.value })
                    }
                    className={`py-2 px-3 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Voice Tone */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="block text-xs font-semibold text-[#F5F7FA]">
                Voice Tone
              </label>
              <span className="font-mono text-[11px] text-[#67E8F9] capitalize">
                {preferences.voiceTone || 'professional'}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="Voice Tone"
              className="grid grid-cols-2 gap-2"
            >
              {VOICE_TONE_OPTIONS.map((opt) => {
                const active = (preferences.voiceTone || 'professional') === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      onPreferencesChange({ ...preferences, voiceTone: opt.value })
                    }
                    className={`px-3 py-2.5 text-left rounded-md border transition-colors cursor-pointer ${
                      active
                        ? 'border-[#22D3EE]/70 bg-[#22D3EE]/[0.08]'
                        : 'border-[#222833] bg-[#0E1116] hover:border-[#394457]'
                    }`}
                  >
                    <span
                      className={`block text-xs font-semibold whitespace-nowrap ${
                        active ? 'text-[#67E8F9]' : 'text-[#F5F7FA]'
                      }`}
                    >
                      {opt.label}
                    </span>
                    <span className="block text-[11px] text-[#8C96A8] mt-0.5 leading-snug">
                      {opt.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Voice Cast + Newsroom Panel */}
          <div className="space-y-3.5">
            <div>
              <label
                htmlFor="lead-voice-select"
                className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
              >
                {preferences.format === 'podcast' ? 'Lead Host Voice (Alex)' : 'Anchor Voice'}
              </label>
              <select
                id="lead-voice-select"
                value={preferences.voiceName}
                onChange={(e) =>
                  onPreferencesChange({
                    ...preferences,
                    voiceName: e.target.value as VoiceName,
                  })
                }
                className="w-full h-10 px-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md focus:border-[#22D3EE]"
              >
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} — {v.descriptor}
                  </option>
                ))}
              </select>
            </div>

            {preferences.format === 'podcast' && (() => {
              const availableCoHosts = VOICE_OPTIONS.filter(
                (v) => v.name !== preferences.voiceName
              );

              const getAssignedVoice = (articleId: string, index: number): VoiceName => {
                const chosen = preferences.segmentCoHostVoices?.[articleId];
                if (chosen && chosen !== preferences.voiceName) {
                  return chosen;
                }
                return availableCoHosts[index % availableCoHosts.length].name;
              };

              const handleToggleDynamicPanel = (enable: boolean) => {
                if (!enable) {
                  onPreferencesChange({ ...preferences, dynamicPanel: false });
                  return;
                }
                const nextMap: Record<string, VoiceName> = {
                  ...(preferences.segmentCoHostVoices || {}),
                };
                selectedArticles.forEach((art, idx) => {
                  if (!nextMap[art.id] || nextMap[art.id] === preferences.voiceName) {
                    nextMap[art.id] = availableCoHosts[idx % availableCoHosts.length].name;
                  }
                });
                onPreferencesChange({
                  ...preferences,
                  dynamicPanel: true,
                  segmentCoHostVoices: nextMap,
                });
              };

              const handleAutoAssignUnique = () => {
                const nextMap: Record<string, VoiceName> = {
                  ...(preferences.segmentCoHostVoices || {}),
                };
                selectedArticles.forEach((art, idx) => {
                  nextMap[art.id] = availableCoHosts[idx % availableCoHosts.length].name;
                });
                onPreferencesChange({
                  ...preferences,
                  dynamicPanel: true,
                  segmentCoHostVoices: nextMap,
                });
              };

              const assignedSet = new Set(
                selectedArticles.map((art, idx) => getAssignedVoice(art.id, idx))
              );

              return (
                <div className="space-y-3 pt-1">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-[#F5F7FA]">
                        Co-Host Casting
                      </span>
                      {preferences.dynamicPanel && selectedArticles.length > 0 && (
                        <span className="font-mono text-[11px] text-[#67E8F9] tabular-nums">
                          {assignedSet.size} unique {assignedSet.size === 1 ? 'voice' : 'voices'}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md">
                      <button
                        type="button"
                        onClick={() => handleToggleDynamicPanel(false)}
                        className={`py-1.5 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                          !preferences.dynamicPanel
                            ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                            : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                        }`}
                      >
                        Single Co-Host
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleDynamicPanel(true)}
                        className={`py-1.5 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                          preferences.dynamicPanel
                            ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]/50'
                            : 'text-[#8C96A8] hover:text-[#F5F7FA] border border-transparent'
                        }`}
                      >
                        Newsroom Panel
                      </button>
                    </div>
                  </div>

                  {!preferences.dynamicPanel ? (
                    <div>
                      <label
                        htmlFor="cohost-voice-select"
                        className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
                      >
                        Co-Host Voice (Sam)
                      </label>
                      <select
                        id="cohost-voice-select"
                        value={preferences.coHostVoiceName}
                        onChange={(e) =>
                          onPreferencesChange({
                            ...preferences,
                            coHostVoiceName: e.target.value as VoiceName,
                          })
                        }
                        className="w-full h-10 px-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md focus:border-[#22D3EE]"
                      >
                        {availableCoHosts.map((v) => (
                          <option key={v.name} value={v.name}>
                            {v.name} — {v.descriptor}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-[#A0AABB]">
                          Assign a correspondent voice per segment
                        </p>
                        {selectedArticles.length > 1 && (
                          <button
                            type="button"
                            onClick={handleAutoAssignUnique}
                            className="text-xs font-medium text-[#67E8F9] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Rotate voices
                          </button>
                        )}
                      </div>

                      {selectedArticles.length === 0 ? (
                        <p className="text-xs text-[#6E788A] py-2 border-t border-[#222833]">
                          Select sources in the sidebar to cast segment co-hosts.
                        </p>
                      ) : (
                        <ul className="divide-y divide-[#1F2532] border-t border-b border-[#222833]">
                          {selectedArticles.map((art, idx) => {
                            const currentVoice = getAssignedVoice(art.id, idx);
                            return (
                              <li
                                key={art.id}
                                className="py-2.5 flex items-center justify-between gap-3"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="font-mono text-[11px] text-[#6E788A] tabular-nums truncate">
                                    Seg {String(idx + 1).padStart(2, '0')} · {art.category}
                                  </p>
                                  <p
                                    className="text-xs font-medium text-[#F5F7FA] truncate"
                                    title={art.title}
                                  >
                                    {art.title}
                                  </p>
                                </div>
                                <label
                                  htmlFor={`panel-voice-${art.id}`}
                                  className="sr-only"
                                >
                                  Co-host voice for segment {idx + 1}: {art.title}
                                </label>
                                <select
                                  id={`panel-voice-${art.id}`}
                                  value={currentVoice}
                                  onChange={(e) => {
                                    const voice = e.target.value as VoiceName;
                                    onPreferencesChange({
                                      ...preferences,
                                      segmentCoHostVoices: {
                                        ...(preferences.segmentCoHostVoices || {}),
                                        [art.id]: voice,
                                      },
                                    });
                                  }}
                                  className="h-8 px-2 text-xs font-medium text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded focus:border-[#22D3EE] shrink-0"
                                >
                                  {availableCoHosts.map((v) => (
                                    <option key={v.name} value={v.name}>
                                      {v.name} ({v.register})
                                    </option>
                                  ))}
                                </select>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Personalized Introduction (Optional Custom Opening) */}
          <div>
            <label
              htmlFor="personalized-intro-input"
              className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
            >
              Personalized Introduction (optional)
            </label>
            <textarea
              id="personalized-intro-input"
              rows={2}
              value={preferences.personalizedIntroduction ?? ''}
              onChange={(e) =>
                onPreferencesChange({
                  ...preferences,
                  personalizedIntroduction: e.target.value,
                })
              }
              placeholder="e.g., Good morning — here is today's briefing tailored for our regional client review."
              className="w-full p-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE] leading-snug"
            />
          </div>

          {/* Listener Personalization Focus */}
          <div>
            <label
              htmlFor="listener-focus-input"
              className="block text-xs font-semibold text-[#F5F7FA] mb-1.5"
            >
              Personal Angle (optional)
            </label>
            <textarea
              id="listener-focus-input"
              rows={2}
              value={preferences.listenerFocus}
              onChange={(e) =>
                onPreferencesChange({
                  ...preferences,
                  listenerFocus: e.target.value,
                })
              }
              placeholder="e.g., Focus on financial risks, compare my uploaded PDF against the news stories."
              className="w-full p-3 text-sm text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE] leading-snug"
            />
          </div>

          {/* Primary Action & Progress */}
          <div className="pt-2 space-y-2.5">
            {totalHighlightCount > 0 && (
              <div className="pb-2 mb-1 border-b border-[#222833] space-y-2">
                <div className="flex items-start gap-2 text-xs text-[#C7D0DF] leading-snug">
                  <Highlighter
                    className="w-3.5 h-3.5 text-[#22D3EE] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span className="tabular-nums">
                    {selectedHighlightCount > 0 ? (
                      <>
                        <span className="font-mono font-medium text-[#67E8F9]">
                          {selectedHighlightCount}
                        </span>{' '}
                        highlighted{' '}
                        {selectedHighlightCount === 1 ? 'phrase' : 'phrases'} across{' '}
                        <span className="font-mono text-[#F5F7FA]">
                          {selectedHighlightedSourceCount}
                        </span>{' '}
                        selected{' '}
                        {selectedHighlightedSourceCount === 1 ? 'source' : 'sources'}{' '}
                        will be prioritized and cited in your briefing.
                      </>
                    ) : (
                      <>
                        <span className="font-mono font-medium text-[#67E8F9]">
                          {totalHighlightCount}
                        </span>{' '}
                        highlighted{' '}
                        {totalHighlightCount === 1 ? 'phrase' : 'phrases'} saved across{' '}
                        <span className="font-mono text-[#F5F7FA]">
                          {totalHighlightedSourceCount}
                        </span>{' '}
                        queued{' '}
                        {totalHighlightedSourceCount === 1 ? 'source' : 'sources'}.
                      </>
                    )}
                  </span>
                </div>

                {onGenerateHighlightsSummary && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isGeneratingHighlightsSummary}
                      onClick={() => {
                        void onGenerateHighlightsSummary(
                          selectedHighlightCount > 0 ? 'selected' : 'all'
                        );
                      }}
                      className="flex-1 h-9 px-3 inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#67E8F9] bg-[#131F2B] hover:bg-[#182938] border border-[#22D3EE]/55 hover:border-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {isGeneratingHighlightsSummary ? (
                        <>
                          <Loader2
                            className="w-3.5 h-3.5 animate-spin text-[#22D3EE]"
                            aria-hidden="true"
                          />
                          <span>Synthesizing Meta-Briefing...</span>
                        </>
                      ) : (
                        <>
                          <Highlighter
                            className="w-3.5 h-3.5 text-[#22D3EE]"
                            aria-hidden="true"
                          />
                          <span>Generate Summary from Highlights</span>
                        </>
                      )}
                    </button>

                    {hasSavedHighlightsSummary &&
                      onOpenSavedHighlightsSummary &&
                      !isGeneratingHighlightsSummary && (
                        <button
                          type="button"
                          onClick={onOpenSavedHighlightsSummary}
                          className="h-9 px-3 text-xs font-medium text-[#A0AABB] hover:text-[#67E8F9] border border-[#252D3B] hover:border-[#22D3EE]/45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          View Last Summary
                        </button>
                      )}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              disabled={isGenerating || selectedArticles.length === 0}
              onClick={() => onBuildBriefing(true)}
              className="w-full h-12 px-5 inline-flex items-center justify-center gap-2 text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 disabled:cursor-not-allowed rounded-md transition-colors cursor-pointer"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>{generationStatus || 'Building briefing...'}</span>
                </>
              ) : (
                <>
                  <Headphones className="w-4 h-4" aria-hidden="true" />
                  <span>Generate Audio Briefing</span>
                </>
              )}
            </button>

            <button
              type="button"
              disabled={isGenerating || selectedArticles.length === 0}
              onClick={() => onBuildBriefing(false)}
              className="w-full py-2 text-xs font-medium text-[#A0AABB] hover:text-[#67E8F9] disabled:opacity-40 transition-colors cursor-pointer"
            >
              Draft script first so I can review before recording
            </button>

            {generationError && (
              <p
                role="alert"
                className="text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3 py-2.5 leading-relaxed"
              >
                {generationError}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
