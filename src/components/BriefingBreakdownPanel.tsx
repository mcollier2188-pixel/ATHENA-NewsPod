import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  FileText,
  PieChart as PieChartIcon,
  SlidersHorizontal,
} from 'lucide-react';
import type { AudioBriefing, NewsArticle } from '../types';
import { formatClock } from '../utils/wavUtils';

type BreakdownTab = 'topics' | 'sources' | 'tone';

interface BriefingBreakdownPanelProps {
  briefing: AudioBriefing;
  sources?: NewsArticle[];
  onSelectChapterByIndex?: (segmentIndex: number, segmentId: string) => void;
}

const TOPIC_PALETTE = [
  '#22D3EE',
  '#38BDF8',
  '#34D399',
  '#F59E0B',
  '#A78BFA',
  '#FB7185',
];

const TOPIC_SWATCH_CLASSES = [
  'bg-[#22D3EE]',
  'bg-[#38BDF8]',
  'bg-[#34D399]',
  'bg-[#F59E0B]',
  'bg-[#A78BFA]',
  'bg-[#FB7185]',
];

const SENTIMENT_COLORS = {
  constructive: '#34D399',
  analytical: '#22D3EE',
  cautionary: '#F59E0B',
};

const CONSTRUCTIVE_TERMS = new Set([
  'growth',
  'gain',
  'gains',
  'surge',
  'record',
  'expand',
  'expansion',
  'expanded',
  'breakthrough',
  'improve',
  'improved',
  'improvement',
  'strong',
  'stronger',
  'boost',
  'boosted',
  'opportunity',
  'opportunities',
  'launch',
  'launched',
  'milestone',
  'resilient',
  'accelerate',
  'accelerated',
  'innovation',
  'innovative',
  'approve',
  'approved',
  'partnership',
  'profit',
  'profits',
  'efficiency',
  'upgrade',
  'success',
  'momentum',
  'bullish',
  'recovery',
  'advance',
  'advances',
  'optimistic',
  'leading',
  'outperform',
  'win',
  'benefit',
  'benefits',
]);

const CAUTIONARY_TERMS = new Set([
  'risk',
  'risks',
  'decline',
  'declined',
  'drop',
  'dropped',
  'warn',
  'warning',
  'warned',
  'delay',
  'delayed',
  'delays',
  'deficit',
  'shortage',
  'shortages',
  'cut',
  'cuts',
  'volatility',
  'volatile',
  'probe',
  'lawsuit',
  'threat',
  'threats',
  'pressure',
  'pressures',
  'bottleneck',
  'bottlenecks',
  'downturn',
  'concern',
  'concerns',
  'dispute',
  'disputes',
  'loss',
  'losses',
  'slowdown',
  'headwind',
  'headwinds',
  'challenge',
  'challenges',
  'caution',
  'uncertainty',
  'uncertain',
  'penalty',
  'breach',
  'critical',
  'strain',
  'inflation',
  'tariff',
  'tariffs',
  'layoff',
  'layoffs',
]);

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function shortenLabel(label: string, max = 22): string {
  const clean = label.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function scoreSegmentSentiment(text: string): {
  constructivePct: number;
  analyticalPct: number;
  cautionaryPct: number;
  dominant: 'Constructive' | 'Analytical' | 'Cautionary';
} {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let constructiveHits = 0;
  let cautionaryHits = 0;

  for (const token of tokens) {
    if (CONSTRUCTIVE_TERMS.has(token)) constructiveHits += 1;
    else if (CAUTIONARY_TERMS.has(token)) cautionaryHits += 1;
  }

  const totalWords = Math.max(1, tokens.length);
  // Normalize lexicon density into realistic proportional editorial shares summing to 100%
  const rawConstructive = Math.min(0.62, (constructiveHits / totalWords) * 14);
  const rawCautionary = Math.min(0.62, (cautionaryHits / totalWords) * 14);
  const combinedDirectional = rawConstructive + rawCautionary;

  let constructivePct: number;
  let cautionaryPct: number;
  let analyticalPct: number;

  if (combinedDirectional > 0.78) {
    const scale = 0.78 / combinedDirectional;
    constructivePct = Math.round(rawConstructive * scale * 100);
    cautionaryPct = Math.round(rawCautionary * scale * 100);
    analyticalPct = Math.max(0, 100 - constructivePct - cautionaryPct);
  } else {
    constructivePct = Math.round(rawConstructive * 100);
    cautionaryPct = Math.round(rawCautionary * 100);
    analyticalPct = Math.max(0, 100 - constructivePct - cautionaryPct);
  }

  let dominant: 'Constructive' | 'Analytical' | 'Cautionary' = 'Analytical';
  if (constructivePct >= cautionaryPct + 8 && constructivePct >= 28) {
    dominant = 'Constructive';
  } else if (cautionaryPct >= constructivePct + 8 && cautionaryPct >= 28) {
    dominant = 'Cautionary';
  }

  return { constructivePct, analyticalPct, cautionaryPct, dominant };
}

export function BriefingBreakdownPanel({
  briefing,
  sources = [],
  onSelectChapterByIndex,
}: BriefingBreakdownPanelProps) {
  const [activeTab, setActiveTab] = useState<BreakdownTab>('topics');
  const [expanded, setExpanded] = useState(true);

  const analytics = useMemo(() => {
    const sourceLookup = new Map<string, NewsArticle>();
    for (const src of sources) {
      sourceLookup.set(src.id, src);
      sourceLookup.set(src.title.toLowerCase(), src);
    }

    const topicMap = new Map<
      string,
      {
        category: string;
        shortCategory: string;
        words: number;
        durationSec: number;
        chapters: number;
        citations: number;
        firstSegmentIndex: number;
        firstSegmentId: string;
      }
    >();

    const sourceMap = new Map<
      string,
      {
        name: string;
        shortName: string;
        mentions: number;
        citations: number;
        wordsAttributed: number;
      }
    >();

    const chapterToneRows: Array<{
      chapterLabel: string;
      title: string;
      segmentIndex: number;
      segmentId: string;
      constructive: number;
      analytical: number;
      cautionary: number;
      dominant: 'Constructive' | 'Analytical' | 'Cautionary';
    }> = [];

    let totalWords = 0;
    let totalCitations = briefing.takeawayCitations?.length ?? 0;

    briefing.segments.forEach((seg, idx) => {
      const segText = seg.lines.map((l) => l.text).join(' ');
      const words = countWords(segText);
      const dur = Math.max(15, seg.audioDurationSeconds || seg.estimatedSeconds || 60);
      const citeCount = seg.citations?.length ?? 0;

      totalWords += words;
      totalCitations += citeCount;

      // 1. Topic Coverage Aggregation
      const cat = (seg.category || 'General').trim();
      const existingTopic = topicMap.get(cat);
      if (existingTopic) {
        existingTopic.words += words;
        existingTopic.durationSec += dur;
        existingTopic.chapters += 1;
        existingTopic.citations += citeCount;
      } else {
        topicMap.set(cat, {
          category: cat,
          shortCategory: shortenLabel(cat, 18),
          words,
          durationSec: dur,
          chapters: 1,
          citations: citeCount,
          firstSegmentIndex: idx,
          firstSegmentId: seg.id,
        });
      }

      // 2. Source Distribution Aggregation
      const citedSourceNames = new Set<string>();
      for (const cite of seg.citations || []) {
        const matched =
          sourceLookup.get(cite.sourceId) ||
          sourceLookup.get(cite.sourceTitle.toLowerCase());
        const resolvedName = matched?.source?.trim() || cite.sourceTitle.trim() || 'Briefing Source';
        citedSourceNames.add(resolvedName);

        const prev = sourceMap.get(resolvedName) || {
          name: resolvedName,
          shortName: shortenLabel(resolvedName, 24),
          mentions: 0,
          citations: 0,
          wordsAttributed: 0,
        };
        prev.citations += 1;
        sourceMap.set(resolvedName, prev);
      }

      const chapterSources =
        seg.sourceTitles.length > 0
          ? seg.sourceTitles.map((st) => {
              const matched = sourceLookup.get(st.toLowerCase());
              return matched?.source?.trim() || st.trim();
            })
          : Array.from(citedSourceNames);

      const uniqueChapterSources = Array.from(
        new Set(chapterSources.filter(Boolean))
      );
      const shareWords =
        uniqueChapterSources.length > 0
          ? Math.round(words / uniqueChapterSources.length)
          : 0;

      for (const srcName of uniqueChapterSources) {
        const prev = sourceMap.get(srcName) || {
          name: srcName,
          shortName: shortenLabel(srcName, 24),
          mentions: 0,
          citations: 0,
          wordsAttributed: 0,
        };
        prev.mentions += 1;
        prev.wordsAttributed += shareWords;
        sourceMap.set(srcName, prev);
      }

      // 3. Tone & Sentiment Arc per Chapter
      const sentiment = scoreSegmentSentiment(`${seg.title} ${seg.keyPoint} ${segText}`);
      chapterToneRows.push({
        chapterLabel: `Ch ${String(idx + 1).padStart(2, '0')}`,
        title: seg.title,
        segmentIndex: idx,
        segmentId: seg.id,
        constructive: sentiment.constructivePct,
        analytical: sentiment.analyticalPct,
        cautionary: sentiment.cautionaryPct,
        dominant: sentiment.dominant,
      });
    });

    // Fallback if segments had no explicit sourceTitles/citations
    if (sourceMap.size === 0 && briefing.articleTitles.length > 0) {
      const perSourceWords = Math.round(
        totalWords / Math.max(1, briefing.articleTitles.length)
      );
      for (const title of briefing.articleTitles) {
        const matched = sourceLookup.get(title.toLowerCase());
        const resolvedName = matched?.source?.trim() || title.trim();
        const prev = sourceMap.get(resolvedName) || {
          name: resolvedName,
          shortName: shortenLabel(resolvedName, 24),
          mentions: 0,
          citations: 0,
          wordsAttributed: 0,
        };
        prev.mentions += 1;
        prev.wordsAttributed += perSourceWords;
        sourceMap.set(resolvedName, prev);
      }
    }

    const topicRows = Array.from(topicMap.values()).sort(
      (a, b) => b.durationSec - a.durationSec
    );

    const rawSources = Array.from(sourceMap.values()).sort(
      (a, b) =>
        b.wordsAttributed + b.citations * 40 - (a.wordsAttributed + a.citations * 40)
    );
    const totalSourceWeight = Math.max(
      1,
      rawSources.reduce((acc, s) => acc + Math.max(1, s.wordsAttributed), 0)
    );
    const sourceRows = rawSources.map((s, idx) => ({
      ...s,
      value: Math.max(1, s.wordsAttributed),
      sharePct: Math.round((Math.max(1, s.wordsAttributed) / totalSourceWeight) * 100),
      color: TOPIC_PALETTE[idx % TOPIC_PALETTE.length],
      swatchClass: TOPIC_SWATCH_CLASSES[idx % TOPIC_SWATCH_CLASSES.length],
    }));

    const avgConstructive =
      chapterToneRows.length > 0
        ? Math.round(
            chapterToneRows.reduce((sum, r) => sum + r.constructive, 0) /
              chapterToneRows.length
          )
        : 0;
    const avgCautionary =
      chapterToneRows.length > 0
        ? Math.round(
            chapterToneRows.reduce((sum, r) => sum + r.cautionary, 0) /
              chapterToneRows.length
          )
        : 0;
    const avgAnalytical = Math.max(0, 100 - avgConstructive - avgCautionary);

    return {
      totalWords,
      totalCitations,
      topicRows,
      sourceRows,
      chapterToneRows,
      avgConstructive,
      avgAnalytical,
      avgCautionary,
    };
  }, [briefing, sources]);

  if (briefing.segments.length === 0) return null;

  return (
    <section
      aria-label="Briefing content breakdown"
      className="bg-[#13161C] border border-[#222833] rounded-lg p-5 sm:p-6"
    >
      {/* Panel Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-[#222833]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-serif text-lg font-medium text-[#F5F7FA]">
              Editorial Content Breakdown
            </h2>
            <span className="text-xs text-[#8C96A8] font-mono tabular-nums">
              {analytics.totalWords.toLocaleString()} words · {analytics.sourceRows.length}{' '}
              {analytics.sourceRows.length === 1 ? 'source' : 'sources'} ·{' '}
              {analytics.totalCitations}{' '}
              {analytics.totalCitations === 1 ? 'citation' : 'citations'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {/* Segmented Tab Controls */}
          <div
            role="tablist"
            aria-label="Briefing breakdown chart view"
            className="inline-flex items-center gap-1 p-1 bg-[#0E1116] border border-[#273040] rounded-md"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'topics'}
              onClick={() => {
                setActiveTab('topics');
                setExpanded(true);
              }}
              className={`h-7 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'topics'
                  ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                  : 'text-[#A0AABB] hover:text-[#F5F7FA]'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Topic Coverage</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'sources'}
              onClick={() => {
                setActiveTab('sources');
                setExpanded(true);
              }}
              className={`h-7 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'sources'
                  ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                  : 'text-[#A0AABB] hover:text-[#F5F7FA]'
              }`}
            >
              <PieChartIcon className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Source Mix</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'tone'}
              onClick={() => {
                setActiveTab('tone');
                setExpanded(true);
              }}
              className={`h-7 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'tone'
                  ? 'bg-[#22D3EE] text-[#071318] font-semibold'
                  : 'text-[#A0AABB] hover:text-[#F5F7FA]'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Tone &amp; Sentiment</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse breakdown charts' : 'Expand breakdown charts'}
            className="h-9 w-9 inline-flex items-center justify-center rounded-md bg-[#0E1116] border border-[#273040] text-[#A0AABB] hover:text-[#F5F7FA] hover:border-[#22D3EE]/50 transition-colors cursor-pointer shrink-0"
          >
            {expanded ? (
              <ChevronUp className="w-4 h-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="pt-5">
          {/* TAB 1: TOPIC COVERAGE (Recharts BarChart) */}
          {activeTab === 'topics' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
              <div className="lg:col-span-8 h-[230px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={analytics.topicRows}
                    margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                  >
                    <CartesianGrid
                      stroke="#222833"
                      strokeDasharray="3 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="shortCategory"
                      tick={{ fill: '#A0AABB', fontSize: 11 }}
                      axisLine={{ stroke: '#273040' }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: '#8C96A8', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      unit="s"
                      width={42}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(34, 211, 238, 0.08)' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const row = payload[0]
                          .payload as (typeof analytics.topicRows)[number];
                        return (
                          <div className="bg-[#0B0E14] border border-[#22D3EE]/45 rounded-md px-3 py-2 text-xs shadow-xl">
                            <p className="font-semibold text-[#F5F7FA]">
                              {row.category}
                            </p>
                            <div className="mt-1 space-y-0.5 font-mono text-[11px] text-[#A0AABB] tabular-nums">
                              <p>
                                Runtime:{' '}
                                <span className="text-[#67E8F9]">
                                  {formatClock(row.durationSec)}
                                </span>
                              </p>
                              <p>
                                Script:{' '}
                                <span className="text-[#F5F7FA]">
                                  {row.words} words
                                </span>
                              </p>
                              <p>
                                Chapters: {row.chapters} · Citations:{' '}
                                {row.citations}
                              </p>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar
                      dataKey="durationSec"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={48}
                      onClick={(entry) => {
                        const row = entry as unknown as (typeof analytics.topicRows)[number];
                        if (row && onSelectChapterByIndex) {
                          onSelectChapterByIndex(
                            row.firstSegmentIndex,
                            row.firstSegmentId
                          );
                        }
                      }}
                    >
                      {analytics.topicRows.map((entry, idx) => (
                        <Cell
                          key={entry.category}
                          fill={TOPIC_PALETTE[idx % TOPIC_PALETTE.length]}
                          className="cursor-pointer"
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="lg:col-span-4 space-y-2.5">
                <p className="text-xs font-medium text-[#A0AABB]">
                  Runtime &amp; depth by topic
                </p>
                <ul className="divide-y divide-[#222833]">
                  {analytics.topicRows.map((row, idx) => (
                    <li
                      key={row.category}
                      className="py-2 flex items-center justify-between gap-2 text-xs"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          onSelectChapterByIndex?.(
                            row.firstSegmentIndex,
                            row.firstSegmentId
                          )
                        }
                        className="min-w-0 flex items-center gap-2 text-left text-[#E4E9F1] hover:text-[#67E8F9] transition-colors cursor-pointer"
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-xs shrink-0 ${
                            TOPIC_SWATCH_CLASSES[idx % TOPIC_SWATCH_CLASSES.length]
                          }`}
                          aria-hidden="true"
                        />
                        <span className="truncate font-medium">
                          {row.category}
                        </span>
                      </button>
                      <span className="font-mono text-[11px] text-[#8C96A8] tabular-nums whitespace-nowrap shrink-0">
                        {formatClock(row.durationSec)} · {row.words}w
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* TAB 2: SOURCE DISTRIBUTION (Recharts Donut PieChart) */}
          {activeTab === 'sources' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
              <div className="lg:col-span-5 h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={analytics.sourceRows}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={56}
                      outerRadius={86}
                      paddingAngle={2}
                      stroke="#13161C"
                      strokeWidth={2}
                    >
                      {analytics.sourceRows.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const row = payload[0]
                          .payload as (typeof analytics.sourceRows)[number];
                        return (
                          <div className="bg-[#0B0E14] border border-[#22D3EE]/45 rounded-md px-3 py-2 text-xs shadow-xl max-w-[240px]">
                            <p className="font-semibold text-[#F5F7FA] truncate">
                              {row.name}
                            </p>
                            <div className="mt-1 space-y-0.5 font-mono text-[11px] text-[#A0AABB] tabular-nums">
                              <p>
                                Share:{' '}
                                <span className="text-[#67E8F9]">
                                  {row.sharePct}%
                                </span>
                              </p>
                              <p>
                                Chapters: {row.mentions} · Citations:{' '}
                                {row.citations}
                              </p>
                            </div>
                          </div>
                        );
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="lg:col-span-7">
                <div className="flex items-center justify-between text-xs text-[#8C96A8] pb-2 border-b border-[#222833]">
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#A0AABB]">
                    <FileText className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    Attributed Briefing Sources
                  </span>
                  <span className="font-mono text-[11px]">Share · Citations</span>
                </div>
                <ul className="divide-y divide-[#222833] max-h-[190px] overflow-y-auto pr-1">
                  {analytics.sourceRows.map((row) => (
                    <li
                      key={row.name}
                      className="py-2.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0 flex items-center gap-2.5">
                        <span
                          className={`w-2.5 h-2.5 rounded-xs shrink-0 ${row.swatchClass}`}
                          aria-hidden="true"
                        />
                        <span
                          title={row.name}
                          className="text-[#E4E9F1] font-medium truncate"
                        >
                          {row.name}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-[#A0AABB] tabular-nums whitespace-nowrap shrink-0">
                        <span className="text-[#F5F7FA] font-semibold">
                          {row.sharePct}%
                        </span>{' '}
                        · {row.citations}{' '}
                        {row.citations === 1 ? 'cite' : 'cites'}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* TAB 3: TONE & SENTIMENT PROFILE (Recharts Stacked BarChart) */}
          {activeTab === 'tone' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-3 text-[#A0AABB]">
                  <span>
                    Target tone:{' '}
                    <strong className="capitalize text-[#F5F7FA] font-medium">
                      {briefing.preferences.tone}
                    </strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Voice cadence:{' '}
                    <strong className="capitalize text-[#F5F7FA] font-medium">
                      {briefing.preferences.voiceTone || 'professional'}
                    </strong>
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] tabular-nums">
                  <span className="inline-flex items-center gap-1.5 text-[#34D399]">
                    <span
                      className="w-2.5 h-2.5 rounded-xs bg-[#34D399]"
                      aria-hidden="true"
                    />
                    Constructive {analytics.avgConstructive}%
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-[#22D3EE]">
                    <span
                      className="w-2.5 h-2.5 rounded-xs bg-[#22D3EE]"
                      aria-hidden="true"
                    />
                    Analytical {analytics.avgAnalytical}%
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-[#F59E0B]">
                    <span
                      className="w-2.5 h-2.5 rounded-xs bg-[#F59E0B]"
                      aria-hidden="true"
                    />
                    Cautionary {analytics.avgCautionary}%
                  </span>
                </div>
              </div>

              <div className="h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={analytics.chapterToneRows}
                    layout="vertical"
                    margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
                  >
                    <CartesianGrid
                      stroke="#222833"
                      strokeDasharray="3 3"
                      horizontal={false}
                    />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      unit="%"
                      tick={{ fill: '#8C96A8', fontSize: 11 }}
                      axisLine={{ stroke: '#273040' }}
                      tickLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="chapterLabel"
                      tick={{ fill: '#C4CDD9', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={46}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(255, 255, 255, 0.04)' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const row = payload[0]
                          .payload as (typeof analytics.chapterToneRows)[number];
                        return (
                          <div className="bg-[#0B0E14] border border-[#22D3EE]/45 rounded-md px-3 py-2 text-xs shadow-xl max-w-[260px]">
                            <p className="font-semibold text-[#F5F7FA] truncate">
                              {row.chapterLabel} · {row.title}
                            </p>
                            <div className="mt-1 space-y-0.5 font-mono text-[11px] tabular-nums">
                              <p className="text-[#34D399]">
                                Constructive: {row.constructive}%
                              </p>
                              <p className="text-[#22D3EE]">
                                Analytical: {row.analytical}%
                              </p>
                              <p className="text-[#F59E0B]">
                                Cautionary / Risk: {row.cautionary}%
                              </p>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Bar
                      dataKey="constructive"
                      stackId="tone"
                      fill={SENTIMENT_COLORS.constructive}
                      barSize={18}
                      onClick={(entry) => {
                        const row = entry as unknown as (typeof analytics.chapterToneRows)[number];
                        if (row && onSelectChapterByIndex) {
                          onSelectChapterByIndex(row.segmentIndex, row.segmentId);
                        }
                      }}
                      className="cursor-pointer"
                    />
                    <Bar
                      dataKey="analytical"
                      stackId="tone"
                      fill={SENTIMENT_COLORS.analytical}
                      barSize={18}
                      onClick={(entry) => {
                        const row = entry as unknown as (typeof analytics.chapterToneRows)[number];
                        if (row && onSelectChapterByIndex) {
                          onSelectChapterByIndex(row.segmentIndex, row.segmentId);
                        }
                      }}
                      className="cursor-pointer"
                    />
                    <Bar
                      dataKey="cautionary"
                      stackId="tone"
                      fill={SENTIMENT_COLORS.cautionary}
                      radius={[0, 4, 4, 0]}
                      barSize={18}
                      onClick={(entry) => {
                        const row = entry as unknown as (typeof analytics.chapterToneRows)[number];
                        if (row && onSelectChapterByIndex) {
                          onSelectChapterByIndex(row.segmentIndex, row.segmentId);
                        }
                      }}
                      className="cursor-pointer"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
