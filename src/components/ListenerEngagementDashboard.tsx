import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  ArrowLeftRight,
  CheckCircle2,
  Clock,
  GitCompare,
  Headphones,
  Sparkles,
} from 'lucide-react';
import type {
  AudioBriefing,
  BriefingSegment,
  BriefingTone,
  PlaybackPosition,
} from '../types';
import { formatClock } from '../utils/wavUtils';

export type EngagementRangeMode = '7d' | '30d' | 'all' | 'editions';

interface ListenerEngagementDashboardProps {
  archive: AudioBriefing[];
  playbackPositions: Record<string, PlaybackPosition>;
  onOpenBriefing: (briefing: AudioBriefing) => void;
}

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

const TONE_PRESET_BASELINE: Record<BriefingTone, number> = {
  upbeat: 78,
  conversational: 68,
  executive: 56,
  analytical: 50,
};

const TONE_PRESET_LABEL: Record<BriefingTone, string> = {
  executive: 'Executive',
  conversational: 'Conversational',
  analytical: 'Analytical',
  upbeat: 'Upbeat',
};

// Discrete Tailwind width utility classes mapped cleanly from 0..100% (5% steps) so no inline style attributes are used
const PERCENT_WIDTH_CLASSES: readonly string[] = [
  'w-0',
  'w-[5%]',
  'w-[10%]',
  'w-[15%]',
  'w-[20%]',
  'w-[25%]',
  'w-[30%]',
  'w-[35%]',
  'w-[40%]',
  'w-[45%]',
  'w-[50%]',
  'w-[55%]',
  'w-[60%]',
  'w-[65%]',
  'w-[70%]',
  'w-[75%]',
  'w-[80%]',
  'w-[85%]',
  'w-[90%]',
  'w-[95%]',
  'w-full',
];

function getPctWidthClass(pct: number): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const idx = Math.round(clamped / 5);
  return PERCENT_WIDTH_CLASSES[idx] || 'w-0';
}

function quantizeThreeWayIndices(
  cPct: number,
  bPct: number,
  wPct: number
): [number, number, number] {
  const totalSlots = 20;
  const rawC = (Math.max(0, cPct) / 100) * totalSlots;
  const rawB = (Math.max(0, bPct) / 100) * totalSlots;
  let iC = Math.round(rawC);
  let iB = Math.round(rawB);
  if (iC + iB > totalSlots) {
    if (iC >= iB) iC = totalSlots - iB;
    else iB = totalSlots - iC;
  }
  const iW = Math.max(0, totalSlots - iC - iB);
  if (wPct > 0 && iW === 0 && (iC > 1 || iB > 1)) {
    if (iC >= iB) return [iC - 1, iB, 1];
    return [iC, iB - 1, 1];
  }
  return [iC, iB, iW];
}

function formatBroadcastFormat(briefing: AudioBriefing): string {
  if (briefing.preferences.format === 'podcast') {
    return briefing.preferences.dynamicPanel
      ? 'Dynamic Panel'
      : 'Two-Host Podcast';
  }
  return 'Solo Anchor';
}

export interface ToneSentimentBreakdown {
  score: number;
  register: 'Constructive' | 'Balanced' | 'Cautionary';
  constructivePct: number;
  balancedPct: number;
  cautionaryPct: number;
}

export function scoreTextToneSentiment(
  text: string,
  tonePreset: BriefingTone = 'executive'
): ToneSentimentBreakdown {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let constructiveHits = 0;
  let cautionaryHits = 0;
  for (const tok of tokens) {
    if (CONSTRUCTIVE_TERMS.has(tok)) constructiveHits += 1;
    else if (CAUTIONARY_TERMS.has(tok)) cautionaryHits += 1;
  }

  const totalWords = Math.max(1, tokens.length);
  const netRatio = (constructiveHits - cautionaryHits) / totalWords;

  // Normalize lexicon density into 3-way Constructive / Balanced / Cautionary shares summing to 100%
  const presetBoostConstructive =
    tonePreset === 'upbeat' ? 0.1 : tonePreset === 'conversational' ? 0.05 : 0;
  const presetBoostCautionary = tonePreset === 'analytical' ? 0.03 : 0;

  const rawConstructive = Math.min(
    0.66,
    (constructiveHits / totalWords) * 14 + 0.14 + presetBoostConstructive
  );
  const rawCautionary = Math.min(
    0.62,
    (cautionaryHits / totalWords) * 14 + 0.1 + presetBoostCautionary
  );
  const combinedDirectional = rawConstructive + rawCautionary;

  let constructivePct: number;
  let cautionaryPct: number;
  let balancedPct: number;

  if (combinedDirectional > 0.82) {
    const scale = 0.82 / combinedDirectional;
    constructivePct = Math.round(rawConstructive * scale * 100);
    cautionaryPct = Math.round(rawCautionary * scale * 100);
    balancedPct = Math.max(0, 100 - constructivePct - cautionaryPct);
  } else {
    constructivePct = Math.round(rawConstructive * 100);
    cautionaryPct = Math.round(rawCautionary * 100);
    balancedPct = Math.max(0, 100 - constructivePct - cautionaryPct);
  }

  // Composite score (0-100) plotted on the ComposedChart right axis
  const lexicalScore = Math.max(
    18,
    Math.min(94, Math.round(54 + netRatio * 480))
  );
  const presetBase = TONE_PRESET_BASELINE[tonePreset] ?? 58;
  const blended = Math.max(
    15,
    Math.min(98, Math.round(presetBase * 0.45 + lexicalScore * 0.55))
  );

  const register: 'Constructive' | 'Balanced' | 'Cautionary' =
    blended >= 64
      ? 'Constructive'
      : blended <= 46
        ? 'Cautionary'
        : 'Balanced';

  return {
    score: blended,
    register,
    constructivePct,
    balancedPct,
    cautionaryPct,
  };
}

function scoreSegmentToneSentiment(
  seg: BriefingSegment,
  tonePreset: BriefingTone
): ToneSentimentBreakdown {
  const combinedText = [
    seg.title,
    seg.keyPoint,
    ...seg.lines.map((l) => l.text),
  ].join(' ');
  return scoreTextToneSentiment(combinedText, tonePreset);
}

interface ChapterEngagementMetrics {
  chapterIndex: number;
  chapterNumber: number;
  title: string;
  category: string;
  totalSeconds: number;
  listenedSeconds: number;
  totalMinutes: number;
  listenedMinutes: number;
  completionRate: number;
  targetDeltaPct: number;
  toneSentimentScore: number;
  toneRegister: 'Constructive' | 'Balanced' | 'Cautionary';
  constructivePct: number;
  balancedPct: number;
  cautionaryPct: number;
}

interface BriefingEngagementMetrics {
  briefing: AudioBriefing;
  briefingId: string;
  title: string;
  shortTitle: string;
  dateKey: string;
  dateLabel: string;
  shortDateLabel: string;
  totalSeconds: number;
  listenedSeconds: number;
  remainingSeconds: number;
  totalMinutes: number;
  listenedMinutes: number;
  remainingMinutes: number;
  completionRate: number;
  targetDeltaPct: number;
  toneSentimentScore: number;
  toneRegister: 'Constructive' | 'Balanced' | 'Cautionary';
  constructivePct: number;
  balancedPct: number;
  cautionaryPct: number;
  tonePresetLabel: string;
  formatLabel: string;
  chaptersCompleted: number;
  totalChapters: number;
  chapters: ChapterEngagementMetrics[];
  status: 'completed' | 'in_progress' | 'unplayed';
}

interface TooltipChapterPreviewItem {
  label: string;
  title: string;
  completionRate: number;
  toneSentimentScore: number;
  listenedSeconds: number;
  totalSeconds: number;
}

interface EngagementChartPoint {
  key: string;
  axisLabel: string;
  tooltipTitle: string;
  tooltipSubtitle: string;
  listenedMinutes: number;
  remainingMinutes: number;
  totalMinutes: number;
  listenedSeconds: number;
  totalSeconds: number;
  completionRate: number;
  targetDeltaPct: number;
  toneSentimentScore: number;
  toneRegister: 'Constructive' | 'Balanced' | 'Cautionary';
  tonePresetLabel: string;
  formatLabel: string;
  constructivePct: number;
  balancedPct: number;
  cautionaryPct: number;
  editionsCount: number;
  completedCount: number;
  inProgressCount: number;
  chaptersSummary: string;
  chapterPreviewList: TooltipChapterPreviewItem[];
  targetBriefing: AudioBriefing | null;
}

interface CompareChapterChartPoint {
  key: string;
  axisLabel: string;
  chapterNumber: number;
  titleA: string;
  categoryA: string;
  titleB: string;
  categoryB: string;
  listenedMinutesA: number;
  totalMinutesA: number;
  listenedSecondsA: number;
  totalSecondsA: number;
  completionRateA: number;
  targetDeltaA: number;
  toneSentimentA: number;
  toneRegisterA: 'Constructive' | 'Balanced' | 'Cautionary';
  constructivePctA: number;
  balancedPctA: number;
  cautionaryPctA: number;
  hasChapterA: boolean;
  listenedMinutesB: number;
  totalMinutesB: number;
  listenedSecondsB: number;
  totalSecondsB: number;
  completionRateB: number;
  targetDeltaB: number;
  toneSentimentB: number;
  toneRegisterB: 'Constructive' | 'Balanced' | 'Cautionary';
  constructivePctB: number;
  balancedPctB: number;
  cautionaryPctB: number;
  hasChapterB: boolean;
}

function toLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDurationCompact(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  if (safe === 0) return '0m';
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  if (mins > 0) {
    return secs >= 10 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${secs}s`;
}

function formatSignedDurationDelta(deltaSeconds: number): string {
  const rounded = Math.round(deltaSeconds);
  if (rounded === 0) return '0s (even)';
  const sign = rounded > 0 ? '+' : '-';
  return `${sign}${formatDurationCompact(Math.abs(rounded))}`;
}

function formatSignedPctDelta(deltaPct: number): string {
  const rounded = Math.round(deltaPct);
  if (rounded === 0) return '0% pts (even)';
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded}% pts`;
}

function formatTarget80Delta(deltaPct: number): string {
  const rounded = Math.round(deltaPct);
  if (rounded === 0) return 'On 80% target';
  if (rounded > 0) return `+${rounded}% vs 80% target`;
  return `${rounded}% vs 80% target`;
}

export function computeBriefingEngagement(
  briefing: AudioBriefing,
  pos?: PlaybackPosition
): BriefingEngagementMetrics {
  const segDurations = briefing.segments.map((seg) =>
    Math.max(10, Math.round(seg.audioDurationSeconds || seg.estimatedSeconds || 60))
  );
  const totalSeconds = Math.max(
    10,
    segDurations.reduce((sum, d) => sum + d, 0)
  );
  const totalChapters = briefing.segments.length;

  let currentListenedSec = 0;
  let chaptersCompleted = 0;

  if (pos) {
    const clampedSegIdx = Math.max(
      0,
      Math.min(pos.segmentIndex, Math.max(0, totalChapters - 1))
    );
    for (let i = 0; i < clampedSegIdx; i++) {
      currentListenedSec += segDurations[i] || 0;
    }
    const activeSegDur = segDurations[clampedSegIdx] || 60;
    const withinActive = Math.max(
      0,
      Math.min(activeSegDur, pos.currentTime || 0)
    );
    currentListenedSec += withinActive;

    const reachedFinalEnd =
      clampedSegIdx === totalChapters - 1 &&
      activeSegDur > 0 &&
      withinActive >= Math.max(1, activeSegDur - 2);

    if (pos.completed || reachedFinalEnd) {
      currentListenedSec = totalSeconds;
      chaptersCompleted = totalChapters;
    } else {
      chaptersCompleted =
        clampedSegIdx + (withinActive >= activeSegDur * 0.85 ? 1 : 0);
    }
  }

  const peakSeconds = Math.max(
    currentListenedSec,
    pos?.maxListenedSeconds ?? 0,
    pos?.completed ? totalSeconds : 0
  );
  const listenedSeconds = Math.max(
    0,
    Math.min(totalSeconds, Math.round(peakSeconds))
  );
  const remainingSeconds = Math.max(0, totalSeconds - listenedSeconds);

  const rawPct = totalSeconds > 0 ? (listenedSeconds / totalSeconds) * 100 : 0;
  const completionRate = Math.max(0, Math.min(100, Math.round(rawPct)));

  if (completionRate >= 98) {
    chaptersCompleted = totalChapters;
  }

  // Compute per-chapter listened duration, completion rate, and tone sentiment breakdown
  let remainingBudget = listenedSeconds;
  const tonePreset = briefing.preferences.tone || 'executive';

  const chapters: ChapterEngagementMetrics[] = briefing.segments.map(
    (seg, idx) => {
      const chapTotalSec = segDurations[idx] || 60;
      const chapListenedSec = Math.max(
        0,
        Math.min(chapTotalSec, Math.round(remainingBudget))
      );
      remainingBudget = Math.max(0, remainingBudget - chapTotalSec);

      const chapCompletion =
        chapTotalSec > 0
          ? Math.max(
              0,
              Math.min(100, Math.round((chapListenedSec / chapTotalSec) * 100))
            )
          : 0;
      const tone = scoreSegmentToneSentiment(seg, tonePreset);

      return {
        chapterIndex: idx,
        chapterNumber: idx + 1,
        title: seg.title || `Chapter ${idx + 1}`,
        category: seg.category || 'News',
        totalSeconds: chapTotalSec,
        listenedSeconds: chapListenedSec,
        totalMinutes: Number((chapTotalSec / 60).toFixed(2)),
        listenedMinutes: Number((chapListenedSec / 60).toFixed(2)),
        completionRate: chapCompletion,
        targetDeltaPct: chapCompletion - 80,
        toneSentimentScore: tone.score,
        toneRegister: tone.register,
        constructivePct: tone.constructivePct,
        balancedPct: tone.balancedPct,
        cautionaryPct: tone.cautionaryPct,
      };
    }
  );

  const avgToneScore =
    chapters.length > 0
      ? Math.round(
          chapters.reduce((sum, c) => sum + c.toneSentimentScore, 0) /
            chapters.length
        )
      : TONE_PRESET_BASELINE[tonePreset] ?? 58;

  const avgConstructive =
    chapters.length > 0
      ? Math.round(
          chapters.reduce((sum, c) => sum + c.constructivePct, 0) /
            chapters.length
        )
      : 34;
  const avgCautionary =
    chapters.length > 0
      ? Math.round(
          chapters.reduce((sum, c) => sum + c.cautionaryPct, 0) /
            chapters.length
        )
      : 20;
  const avgBalanced = Math.max(0, 100 - avgConstructive - avgCautionary);

  const toneRegister: 'Constructive' | 'Balanced' | 'Cautionary' =
    avgToneScore >= 64
      ? 'Constructive'
      : avgToneScore <= 46
        ? 'Cautionary'
        : 'Balanced';

  const status: 'completed' | 'in_progress' | 'unplayed' =
    completionRate >= 95
      ? 'completed'
      : listenedSeconds >= 2
        ? 'in_progress'
        : 'unplayed';

  const createdDate = new Date(briefing.createdAt);
  const validDate = Number.isNaN(createdDate.getTime())
    ? new Date()
    : createdDate;
  const dateKey = toLocalDateKey(validDate);
  const shortDateLabel = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(validDate);
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(validDate);

  const cleanTitle = briefing.editionTitle || 'Untitled Briefing';
  const shortTitle =
    cleanTitle.length > 22 ? `${cleanTitle.slice(0, 21).trim()}…` : cleanTitle;

  return {
    briefing,
    briefingId: briefing.id,
    title: cleanTitle,
    shortTitle,
    dateKey,
    dateLabel,
    shortDateLabel,
    totalSeconds,
    listenedSeconds,
    remainingSeconds,
    totalMinutes: Number((totalSeconds / 60).toFixed(2)),
    listenedMinutes: Number((listenedSeconds / 60).toFixed(2)),
    remainingMinutes: Number((remainingSeconds / 60).toFixed(2)),
    completionRate,
    targetDeltaPct: completionRate - 80,
    toneSentimentScore: avgToneScore,
    toneRegister,
    constructivePct: avgConstructive,
    balancedPct: avgBalanced,
    cautionaryPct: avgCautionary,
    tonePresetLabel: TONE_PRESET_LABEL[tonePreset] || 'Executive',
    formatLabel: formatBroadcastFormat(briefing),
    chaptersCompleted,
    totalChapters,
    chapters,
    status,
  };
}

function SentimentShareBar({
  constructivePct,
  balancedPct,
  cautionaryPct,
}: {
  constructivePct: number;
  balancedPct: number;
  cautionaryPct: number;
}) {
  const [iC, iB, iW] = quantizeThreeWayIndices(
    constructivePct,
    balancedPct,
    cautionaryPct
  );
  const wC = PERCENT_WIDTH_CLASSES[iC] || 'w-0';
  const wB = PERCENT_WIDTH_CLASSES[iB] || 'w-0';
  const wW = PERCENT_WIDTH_CLASSES[iW] || 'w-0';

  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full rounded-full bg-[#181D27] overflow-hidden flex">
        {iC > 0 && (
          <div
            className={`h-full bg-[#34D399] ${wC}`}
            aria-hidden="true"
          />
        )}
        {iB > 0 && (
          <div
            className={`h-full bg-[#22D3EE] ${wB}`}
            aria-hidden="true"
          />
        )}
        {iW > 0 && (
          <div
            className={`h-full bg-[#F59E0B] ${wW}`}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums">
        <span className="text-[#34D399]">Constructive {constructivePct}%</span>
        <span className="text-[#67E8F9]">Balanced {balancedPct}%</span>
        <span className="text-[#FBBF24]">Cautionary {cautionaryPct}%</span>
      </div>
    </div>
  );
}

function CompletionProgressBar({
  completionRate,
  targetDeltaPct,
  accent = 'emerald',
}: {
  completionRate: number;
  targetDeltaPct: number;
  accent?: 'emerald' | 'sky';
}) {
  const fillWidthClass = getPctWidthClass(completionRate);
  const fillColorClass =
    accent === 'sky' ? 'bg-[#38BDF8]' : 'bg-[#34D399]';
  const deltaTextColor =
    targetDeltaPct >= 0 ? 'text-[#34D399]' : 'text-[#FBBF24]';

  return (
    <div className="space-y-1">
      <div className="relative h-2 w-full rounded-full bg-[#161B24] overflow-hidden border border-[#222938]">
        <div
          className={`h-full ${fillColorClass} ${fillWidthClass} rounded-full`}
          aria-hidden="true"
        />
        {/* 80% Target Benchmark Marker */}
        <div
          className="absolute top-0 bottom-0 left-[80%] w-0.5 bg-[#F59E0B]"
          aria-hidden="true"
        />
      </div>
      <div className="flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums">
        <span className="text-[#8C96A8]">0% · 80% benchmark</span>
        <span className={deltaTextColor}>
          {formatTarget80Delta(targetDeltaPct)}
        </span>
      </div>
    </div>
  );
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: EngagementChartPoint }>;
  rangeMode: EngagementRangeMode;
  barClickSelectMode: boolean;
  nextPickSlot: 'A' | 'B';
}

function EngagementCustomTooltip({
  active,
  payload,
  rangeMode,
  barClickSelectMode,
  nextPickSlot,
}: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;

  if (point.editionsCount === 0) {
    return (
      <div className="w-64 bg-[#0B0D10] border border-[#222833] rounded-lg p-3 shadow-2xl text-xs">
        <p className="font-serif text-sm font-medium text-[#F5F7FA]">
          {point.tooltipTitle}
        </p>
        <p className="mt-1 font-mono text-[11px] text-[#8C96A8]">
          No briefings generated on this date.
        </p>
      </div>
    );
  }

  return (
    <div className="w-80 bg-[#0B0D10] border border-[#22D3EE]/60 rounded-lg p-3.5 shadow-2xl text-xs space-y-3">
      {/* Header: Edition / Date Title + Overall Completion Badge */}
      <div className="flex items-start justify-between gap-2.5 pb-2.5 border-b border-[#1F2532]">
        <div className="min-w-0">
          <p className="font-serif text-sm font-medium text-[#F5F7FA] truncate">
            {point.tooltipTitle}
          </p>
          <p className="font-mono text-[11px] text-[#8C96A8] tabular-nums mt-0.5 truncate">
            {point.tooltipSubtitle}
          </p>
        </div>
        <div className="text-right shrink-0">
          <span className="font-mono text-sm font-semibold text-[#34D399] tabular-nums">
            {point.completionRate}%
          </span>
          <p className="font-mono text-[10px] text-[#8C96A8]">completion</p>
        </div>
      </div>

      {/* Block 1: Visual Completion Progress Bar + 80% Target Delta + Clock Time */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
          <span className="text-[#67E8F9]">
            Listened {formatClock(point.listenedSeconds)} / {formatClock(point.totalSeconds)}
          </span>
          <span className="text-[#A0AABB]">{point.chaptersSummary}</span>
        </div>
        <CompletionProgressBar
          completionRate={point.completionRate}
          targetDeltaPct={point.targetDeltaPct}
          accent="emerald"
        />
      </div>

      {/* Block 2: Tone Sentiment Score, Preset & 3-Way Lexical Share Bars */}
      <div className="pt-2.5 border-t border-[#1F2532] space-y-1.5">
        <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
          <span className="text-[#C4B5FD] font-medium">
            Tone Sentiment: {point.toneSentimentScore}% ({point.toneRegister})
          </span>
          <span className="text-[#9CA3AF]">
            Preset: {point.tonePresetLabel}
          </span>
        </div>
        <SentimentShareBar
          constructivePct={point.constructivePct}
          balancedPct={point.balancedPct}
          cautionaryPct={point.cautionaryPct}
        />
      </div>

      {/* Block 3: Chapter-by-Chapter / Edition Breakdown List */}
      {point.chapterPreviewList.length > 0 && (
        <div className="pt-2.5 border-t border-[#1F2532] space-y-1.5">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-[#6E788A]">
            <span>
              {rangeMode === 'editions'
                ? 'Chapter Completion & Tone'
                : 'Briefings in Date Window'}
            </span>
            <span>Comp · Tone</span>
          </div>
          <ul className="space-y-1 font-mono text-[11px] tabular-nums">
            {point.chapterPreviewList.slice(0, 5).map((item, idx) => (
              <li
                key={idx}
                className="flex items-center justify-between gap-2 text-[#D1D5DB]"
              >
                <span className="truncate min-w-0">
                  <span className="text-[#6E788A]">{item.label}</span>{' '}
                  {item.title}
                </span>
                <span className="shrink-0">
                  <span
                    className={
                      item.completionRate >= 80
                        ? 'text-[#34D399]'
                        : item.completionRate > 0
                          ? 'text-[#67E8F9]'
                          : 'text-[#6E788A]'
                    }
                  >
                    {item.completionRate}%
                  </span>
                  <span className="text-[#4B5563]"> · </span>
                  <span className="text-[#C4B5FD]">
                    {item.toneSentimentScore}%
                  </span>
                </span>
              </li>
            ))}
            {point.chapterPreviewList.length > 5 && (
              <li className="text-[10px] text-[#6E788A]">
                +{point.chapterPreviewList.length - 5} more chapters
              </li>
            )}
          </ul>
        </div>
      )}

      {point.targetBriefing && (
        <p className="pt-2 border-t border-[#1F2532] text-[10px] font-mono text-[#22D3EE]">
          {barClickSelectMode
            ? `Click bar to assign to Quick Compare Edition ${nextPickSlot} →`
            : 'Click bar to open or resume edition →'}
        </p>
      )}
    </div>
  );
}

interface CompareTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: CompareChapterChartPoint }>;
  editionA: BriefingEngagementMetrics | null;
  editionB: BriefingEngagementMetrics | null;
}

function QuickCompareCustomTooltip({
  active,
  payload,
  editionA,
  editionB,
}: CompareTooltipProps) {
  if (!active || !payload || payload.length === 0 || !editionA || !editionB) {
    return null;
  }
  const point = payload[0]?.payload;
  if (!point) return null;

  const compDelta = point.completionRateA - point.completionRateB;
  const toneDelta = point.toneSentimentA - point.toneSentimentB;
  const durDelta = point.listenedSecondsA - point.listenedSecondsB;

  return (
    <div className="w-[360px] sm:w-[410px] bg-[#0B0D10] border border-[#22D3EE]/60 rounded-lg p-3.5 shadow-2xl text-xs space-y-3">
      {/* Header + Signed Deltas (A vs B) */}
      <div className="pb-2.5 border-b border-[#1F2532] space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-serif text-sm font-medium text-[#F5F7FA]">
            Chapter {point.chapterNumber} Head-to-Head
          </span>
          <span className="font-mono text-[11px] text-[#8C96A8]">
            Edition A vs Edition B
          </span>
        </div>

        {/* Signed Delta Summary Row */}
        <div className="grid grid-cols-3 gap-2 pt-1 font-mono text-[10px] tabular-nums">
          <div className="p-1.5 rounded bg-[#131720] border border-[#1F2532]">
            <p className="text-[#8C96A8]">Completion Δ</p>
            <p
              className={`mt-0.5 font-medium ${
                compDelta > 0
                  ? 'text-[#34D399]'
                  : compDelta < 0
                    ? 'text-[#38BDF8]'
                    : 'text-[#D1D5DB]'
              }`}
            >
              {formatSignedPctDelta(compDelta)}
            </p>
          </div>
          <div className="p-1.5 rounded bg-[#131720] border border-[#1F2532]">
            <p className="text-[#8C96A8]">Tone Score Δ</p>
            <p
              className={`mt-0.5 font-medium ${
                toneDelta > 0
                  ? 'text-[#C4B5FD]'
                  : toneDelta < 0
                    ? 'text-[#F472B6]'
                    : 'text-[#D1D5DB]'
              }`}
            >
              {formatSignedPctDelta(toneDelta)}
            </p>
          </div>
          <div className="p-1.5 rounded bg-[#131720] border border-[#1F2532]">
            <p className="text-[#8C96A8]">Listened Δ</p>
            <p className="mt-0.5 font-medium text-[#67E8F9]">
              {formatSignedDurationDelta(durDelta)}
            </p>
          </div>
        </div>
      </div>

      {/* Side-by-Side Edition A and Edition B Columns */}
      <div className="grid grid-cols-2 gap-3">
        {/* Column A */}
        <div className="space-y-2 pr-1.5 border-r border-[#1F2532]">
          <div>
            <div className="flex items-center justify-between gap-1 font-mono text-[10px] text-[#67E8F9]">
              <span className="uppercase tracking-wider">Edition A</span>
              <span>{editionA.tonePresetLabel}</span>
            </div>
            <p className="mt-0.5 font-medium text-[#F5F7FA] truncate">
              {point.titleA}
            </p>
          </div>

          {point.hasChapterA ? (
            <>
              <div className="space-y-1">
                <div className="flex items-center justify-between font-mono text-[11px] tabular-nums">
                  <span className="text-[#34D399] font-semibold">
                    {point.completionRateA}% done
                  </span>
                  <span className="text-[#9CA3AF]">
                    {formatClock(point.listenedSecondsA)}/
                    {formatClock(point.totalSecondsA)}
                  </span>
                </div>
                <CompletionProgressBar
                  completionRate={point.completionRateA}
                  targetDeltaPct={point.targetDeltaA}
                  accent="emerald"
                />
              </div>

              <div className="pt-1.5 border-t border-[#1F2532]/70 space-y-1">
                <div className="flex items-center justify-between font-mono text-[10px] tabular-nums">
                  <span className="text-[#C4B5FD]">
                    Tone {point.toneSentimentA}%
                  </span>
                  <span className="text-[#8C96A8]">{point.toneRegisterA}</span>
                </div>
                <SentimentShareBar
                  constructivePct={point.constructivePctA}
                  balancedPct={point.balancedPctA}
                  cautionaryPct={point.cautionaryPctA}
                />
              </div>
            </>
          ) : (
            <p className="font-mono text-[11px] text-[#6E788A]">
              No Chapter {point.chapterNumber} in Edition A.
            </p>
          )}
        </div>

        {/* Column B */}
        <div className="space-y-2">
          <div>
            <div className="flex items-center justify-between gap-1 font-mono text-[10px] text-[#FCD34D]">
              <span className="uppercase tracking-wider">Edition B</span>
              <span>{editionB.tonePresetLabel}</span>
            </div>
            <p className="mt-0.5 font-medium text-[#F5F7FA] truncate">
              {point.titleB}
            </p>
          </div>

          {point.hasChapterB ? (
            <>
              <div className="space-y-1">
                <div className="flex items-center justify-between font-mono text-[11px] tabular-nums">
                  <span className="text-[#38BDF8] font-semibold">
                    {point.completionRateB}% done
                  </span>
                  <span className="text-[#9CA3AF]">
                    {formatClock(point.listenedSecondsB)}/
                    {formatClock(point.totalSecondsB)}
                  </span>
                </div>
                <CompletionProgressBar
                  completionRate={point.completionRateB}
                  targetDeltaPct={point.targetDeltaB}
                  accent="sky"
                />
              </div>

              <div className="pt-1.5 border-t border-[#1F2532]/70 space-y-1">
                <div className="flex items-center justify-between font-mono text-[10px] tabular-nums">
                  <span className="text-[#F472B6]">
                    Tone {point.toneSentimentB}%
                  </span>
                  <span className="text-[#8C96A8]">{point.toneRegisterB}</span>
                </div>
                <SentimentShareBar
                  constructivePct={point.constructivePctB}
                  balancedPct={point.balancedPctB}
                  cautionaryPct={point.cautionaryPctB}
                />
              </div>
            </>
          ) : (
            <p className="font-mono text-[11px] text-[#6E788A]">
              No Chapter {point.chapterNumber} in Edition B.
            </p>
          )}
        </div>
      </div>

      <p className="pt-2 border-t border-[#1F2532] text-[10px] font-mono text-[#8C96A8]">
        Click a cyan bar to open Edition A or an amber bar to open Edition B →
      </p>
    </div>
  );
}

export function ListenerEngagementDashboard({
  archive,
  playbackPositions,
  onOpenBriefing,
}: ListenerEngagementDashboardProps) {
  const [rangeMode, setRangeMode] = useState<EngagementRangeMode>('7d');
  const [isCompareMode, setIsCompareMode] = useState(false);
  const [barClickSelectMode, setBarClickSelectMode] = useState(false);
  const [nextPickSlot, setNextPickSlot] = useState<'A' | 'B'>('A');
  const [compareIdA, setCompareIdA] = useState<string>('');
  const [compareIdB, setCompareIdB] = useState<string>('');

  // Chronological metrics for timeline charts
  const briefingMetrics = useMemo(() => {
    const sorted = [...archive].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    return sorted.map((b) =>
      computeBriefingEngagement(b, playbackPositions[b.id])
    );
  }, [archive, playbackPositions]);

  // Reverse-chronological list for dropdown selectors (newest first)
  const newestFirstMetrics = useMemo(
    () => [...briefingMetrics].reverse(),
    [briefingMetrics]
  );

  // Keep compareIdA and compareIdB valid as archive items are added or deleted
  useEffect(() => {
    if (newestFirstMetrics.length === 0) {
      setCompareIdA('');
      setCompareIdB('');
      return;
    }
    const validIds = new Set(newestFirstMetrics.map((m) => m.briefingId));
    let nextA = validIds.has(compareIdA)
      ? compareIdA
      : newestFirstMetrics[0].briefingId;
    let nextB = validIds.has(compareIdB)
      ? compareIdB
      : (newestFirstMetrics[1] || newestFirstMetrics[0]).briefingId;

    if (nextA === nextB && newestFirstMetrics.length > 1) {
      const fallback = newestFirstMetrics.find((m) => m.briefingId !== nextA);
      if (fallback) nextB = fallback.briefingId;
    }

    if (nextA !== compareIdA) setCompareIdA(nextA);
    if (nextB !== compareIdB) setCompareIdB(nextB);
  }, [newestFirstMetrics, compareIdA, compareIdB]);

  const editionA = useMemo(
    () =>
      newestFirstMetrics.find((m) => m.briefingId === compareIdA) ||
      newestFirstMetrics[0] ||
      null,
    [newestFirstMetrics, compareIdA]
  );

  const editionB = useMemo(
    () =>
      newestFirstMetrics.find((m) => m.briefingId === compareIdB) ||
      newestFirstMetrics[1] ||
      newestFirstMetrics[0] ||
      null,
    [newestFirstMetrics, compareIdB]
  );

  // Build chapter-by-chapter side-by-side comparison dataset
  const compareChartData = useMemo((): CompareChapterChartPoint[] => {
    if (!editionA || !editionB) return [];
    const maxChapters = Math.max(
      editionA.chapters.length,
      editionB.chapters.length
    );
    const points: CompareChapterChartPoint[] = [];

    for (let idx = 0; idx < maxChapters; idx++) {
      const chA = editionA.chapters[idx];
      const chB = editionB.chapters[idx];
      points.push({
        key: `ch-${idx + 1}`,
        axisLabel: `Ch. ${idx + 1}`,
        chapterNumber: idx + 1,
        titleA: chA ? chA.title : 'No chapter in Edition A',
        categoryA: chA ? chA.category : '—',
        titleB: chB ? chB.title : 'No chapter in Edition B',
        categoryB: chB ? chB.category : '—',
        listenedMinutesA: chA ? chA.listenedMinutes : 0,
        totalMinutesA: chA ? chA.totalMinutes : 0,
        listenedSecondsA: chA ? chA.listenedSeconds : 0,
        totalSecondsA: chA ? chA.totalSeconds : 0,
        completionRateA: chA ? chA.completionRate : 0,
        targetDeltaA: chA ? chA.targetDeltaPct : -80,
        toneSentimentA: chA
          ? chA.toneSentimentScore
          : editionA.toneSentimentScore,
        toneRegisterA: chA ? chA.toneRegister : editionA.toneRegister,
        constructivePctA: chA
          ? chA.constructivePct
          : editionA.constructivePct,
        balancedPctA: chA ? chA.balancedPct : editionA.balancedPct,
        cautionaryPctA: chA ? chA.cautionaryPct : editionA.cautionaryPct,
        hasChapterA: Boolean(chA),
        listenedMinutesB: chB ? chB.listenedMinutes : 0,
        totalMinutesB: chB ? chB.totalMinutes : 0,
        listenedSecondsB: chB ? chB.listenedSeconds : 0,
        totalSecondsB: chB ? chB.totalSeconds : 0,
        completionRateB: chB ? chB.completionRate : 0,
        targetDeltaB: chB ? chB.targetDeltaPct : -80,
        toneSentimentB: chB
          ? chB.toneSentimentScore
          : editionB.toneSentimentScore,
        toneRegisterB: chB ? chB.toneRegister : editionB.toneRegister,
        constructivePctB: chB
          ? chB.constructivePct
          : editionB.constructivePct,
        balancedPctB: chB ? chB.balancedPct : editionB.balancedPct,
        cautionaryPctB: chB ? chB.cautionaryPct : editionB.cautionaryPct,
        hasChapterB: Boolean(chB),
      });
    }
    return points;
  }, [editionA, editionB]);

  const {
    chartData,
    windowListenedSeconds,
    windowTotalSeconds,
    windowAvgCompletionRate,
    windowAvgToneSentiment,
    windowCompletedCount,
    windowInProgressCount,
    windowEditionsCount,
  } = useMemo(() => {
    const now = new Date();
    const shortWeekdayFmt = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
    });
    const shortMonthDayFmt = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const fullDayFmt = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    if (rangeMode === 'editions') {
      const points: EngagementChartPoint[] = briefingMetrics.map((m, idx) => ({
        key: m.briefingId,
        axisLabel: `#${idx + 1} ${m.shortDateLabel}`,
        tooltipTitle: m.title,
        tooltipSubtitle: `${m.dateLabel} · ${m.formatLabel}`,
        listenedMinutes: m.listenedMinutes,
        remainingMinutes: m.remainingMinutes,
        totalMinutes: m.totalMinutes,
        listenedSeconds: m.listenedSeconds,
        totalSeconds: m.totalSeconds,
        completionRate: m.completionRate,
        targetDeltaPct: m.targetDeltaPct,
        toneSentimentScore: m.toneSentimentScore,
        toneRegister: m.toneRegister,
        tonePresetLabel: m.tonePresetLabel,
        formatLabel: m.formatLabel,
        constructivePct: m.constructivePct,
        balancedPct: m.balancedPct,
        cautionaryPct: m.cautionaryPct,
        editionsCount: 1,
        completedCount: m.status === 'completed' ? 1 : 0,
        inProgressCount: m.status === 'in_progress' ? 1 : 0,
        chaptersSummary: `${m.chaptersCompleted}/${m.totalChapters} chapters`,
        chapterPreviewList: m.chapters.map((ch) => ({
          label: `Ch.${ch.chapterNumber}`,
          title: ch.title,
          completionRate: ch.completionRate,
          toneSentimentScore: ch.toneSentimentScore,
          listenedSeconds: ch.listenedSeconds,
          totalSeconds: ch.totalSeconds,
        })),
        targetBriefing: m.briefing,
      }));

      const totalSec = briefingMetrics.reduce((s, m) => s + m.totalSeconds, 0);
      const listenedSec = briefingMetrics.reduce(
        (s, m) => s + m.listenedSeconds,
        0
      );
      const avgCompletion =
        briefingMetrics.length > 0
          ? Math.round(
              briefingMetrics.reduce((s, m) => s + m.completionRate, 0) /
                briefingMetrics.length
            )
          : 0;
      const avgTone =
        briefingMetrics.length > 0
          ? Math.round(
              briefingMetrics.reduce((s, m) => s + m.toneSentimentScore, 0) /
                briefingMetrics.length
            )
          : 0;

      return {
        chartData: points,
        windowListenedSeconds: listenedSec,
        windowTotalSeconds: totalSec,
        windowAvgCompletionRate: avgCompletion,
        windowAvgToneSentiment: avgTone,
        windowCompletedCount: briefingMetrics.filter(
          (m) => m.status === 'completed'
        ).length,
        windowInProgressCount: briefingMetrics.filter(
          (m) => m.status === 'in_progress'
        ).length,
        windowEditionsCount: briefingMetrics.length,
      };
    }

    const buildDateBucketPoint = (
      dateKey: string,
      axisLabel: string,
      tooltipTitle: string,
      items: BriefingEngagementMetrics[]
    ): EngagementChartPoint => {
      const listenedSec = items.reduce((s, i) => s + i.listenedSeconds, 0);
      const totalSec = items.reduce((s, i) => s + i.totalSeconds, 0);
      const remainingSec = Math.max(0, totalSec - listenedSec);
      const completionRate =
        totalSec > 0
          ? Math.min(100, Math.round((listenedSec / totalSec) * 100))
          : 0;
      const avgTone =
        items.length > 0
          ? Math.round(
              items.reduce((s, i) => s + i.toneSentimentScore, 0) /
                items.length
            )
          : 0;
      const avgConstructive =
        items.length > 0
          ? Math.round(
              items.reduce((s, i) => s + i.constructivePct, 0) / items.length
            )
          : 0;
      const avgCautionary =
        items.length > 0
          ? Math.round(
              items.reduce((s, i) => s + i.cautionaryPct, 0) / items.length
            )
          : 0;
      const avgBalanced =
        items.length > 0
          ? Math.max(0, 100 - avgConstructive - avgCautionary)
          : 0;
      const completedCount = items.filter(
        (i) => i.status === 'completed'
      ).length;
      const inProgressCount = items.filter(
        (i) => i.status === 'in_progress'
      ).length;

      const latest = items[items.length - 1];
      const uniquePresets = Array.from(
        new Set(items.map((i) => i.tonePresetLabel))
      );

      // If single edition on that date, show its chapters; if multiple, list each edition
      const chapterPreviewList: TooltipChapterPreviewItem[] =
        items.length === 1
          ? items[0].chapters.map((ch) => ({
              label: `Ch.${ch.chapterNumber}`,
              title: ch.title,
              completionRate: ch.completionRate,
              toneSentimentScore: ch.toneSentimentScore,
              listenedSeconds: ch.listenedSeconds,
              totalSeconds: ch.totalSeconds,
            }))
          : items.map((ed, idx) => ({
              label: `Ed.${idx + 1}`,
              title: ed.title,
              completionRate: ed.completionRate,
              toneSentimentScore: ed.toneSentimentScore,
              listenedSeconds: ed.listenedSeconds,
              totalSeconds: ed.totalSeconds,
            }));

      return {
        key: dateKey,
        axisLabel,
        tooltipTitle,
        tooltipSubtitle:
          items.length === 1
            ? `${items[0].title} · ${items[0].formatLabel}`
            : `${items.length} archived editions`,
        listenedMinutes: Number((listenedSec / 60).toFixed(2)),
        remainingMinutes: Number((remainingSec / 60).toFixed(2)),
        totalMinutes: Number((totalSec / 60).toFixed(2)),
        listenedSeconds: listenedSec,
        totalSeconds: totalSec,
        completionRate,
        targetDeltaPct: completionRate - 80,
        toneSentimentScore: avgTone,
        toneRegister:
          avgTone >= 64
            ? 'Constructive'
            : avgTone <= 46
              ? 'Cautionary'
              : 'Balanced',
        tonePresetLabel:
          uniquePresets.length > 0 ? uniquePresets.join(' / ') : 'Executive',
        formatLabel: latest?.formatLabel || 'Podcast',
        constructivePct: avgConstructive,
        balancedPct: avgBalanced,
        cautionaryPct: avgCautionary,
        editionsCount: items.length,
        completedCount,
        inProgressCount,
        chaptersSummary:
          items.length === 1
            ? `${items[0].chaptersCompleted}/${items[0].totalChapters} chapters`
            : `${items.length} editions (${completedCount} done)`,
        chapterPreviewList,
        targetBriefing: latest?.briefing ?? null,
      };
    };

    if (rangeMode === 'all') {
      const grouped = new Map<string, BriefingEngagementMetrics[]>();
      for (const m of briefingMetrics) {
        const list = grouped.get(m.dateKey) || [];
        list.push(m);
        grouped.set(m.dateKey, list);
      }

      const points: EngagementChartPoint[] = Array.from(grouped.entries()).map(
        ([dateKey, items]) => {
          const [y, mo, da] = dateKey.split('-').map(Number);
          const d = new Date(y, (mo || 1) - 1, da || 1);
          return buildDateBucketPoint(
            dateKey,
            shortMonthDayFmt.format(d),
            fullDayFmt.format(d),
            items
          );
        }
      );

      const totalSec = briefingMetrics.reduce((s, m) => s + m.totalSeconds, 0);
      const listenedSec = briefingMetrics.reduce(
        (s, m) => s + m.listenedSeconds,
        0
      );
      const avgCompletion =
        totalSec > 0
          ? Math.min(100, Math.round((listenedSec / totalSec) * 100))
          : 0;
      const avgTone =
        briefingMetrics.length > 0
          ? Math.round(
              briefingMetrics.reduce((s, m) => s + m.toneSentimentScore, 0) /
                briefingMetrics.length
            )
          : 0;

      return {
        chartData: points,
        windowListenedSeconds: listenedSec,
        windowTotalSeconds: totalSec,
        windowAvgCompletionRate: avgCompletion,
        windowAvgToneSentiment: avgTone,
        windowCompletedCount: briefingMetrics.filter(
          (m) => m.status === 'completed'
        ).length,
        windowInProgressCount: briefingMetrics.filter(
          (m) => m.status === 'in_progress'
        ).length,
        windowEditionsCount: briefingMetrics.length,
      };
    }

    // '7d' or '30d' rolling calendar window
    const daySpan = rangeMode === '7d' ? 7 : 30;
    const byDate = new Map<string, BriefingEngagementMetrics[]>();
    for (const m of briefingMetrics) {
      const list = byDate.get(m.dateKey) || [];
      list.push(m);
      byDate.set(m.dateKey, list);
    }

    const points: EngagementChartPoint[] = [];
    const includedMetrics: BriefingEngagementMetrics[] = [];

    for (let offset = daySpan - 1; offset >= 0; offset--) {
      const d = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - offset
      );
      const dateKey = toLocalDateKey(d);
      const items = byDate.get(dateKey) || [];
      includedMetrics.push(...items);

      const axisLabel =
        offset === 0
          ? 'Today'
          : rangeMode === '7d'
            ? shortWeekdayFmt.format(d)
            : shortMonthDayFmt.format(d);

      points.push(
        buildDateBucketPoint(dateKey, axisLabel, fullDayFmt.format(d), items)
      );
    }

    const totalSec = includedMetrics.reduce((s, m) => s + m.totalSeconds, 0);
    const listenedSec = includedMetrics.reduce(
      (s, m) => s + m.listenedSeconds,
      0
    );
    const avgCompletion =
      totalSec > 0
        ? Math.min(100, Math.round((listenedSec / totalSec) * 100))
        : 0;
    const avgTone =
      includedMetrics.length > 0
        ? Math.round(
            includedMetrics.reduce((s, m) => s + m.toneSentimentScore, 0) /
              includedMetrics.length
          )
        : 0;

    return {
      chartData: points,
      windowListenedSeconds: listenedSec,
      windowTotalSeconds: totalSec,
      windowAvgCompletionRate: avgCompletion,
      windowAvgToneSentiment: avgTone,
      windowCompletedCount: includedMetrics.filter(
        (m) => m.status === 'completed'
      ).length,
      windowInProgressCount: includedMetrics.filter(
        (m) => m.status === 'in_progress'
      ).length,
      windowEditionsCount: includedMetrics.length,
    };
  }, [briefingMetrics, rangeMode]);

  const rangeLabel =
    rangeMode === '7d'
      ? '7d'
      : rangeMode === '30d'
        ? '30d'
        : rangeMode === 'all'
          ? 'All-Time'
          : 'Per-Edition';

  const handleStandardBarClick = (pt?: EngagementChartPoint) => {
    const target = pt?.targetBriefing;
    if (!target) return;

    if (barClickSelectMode) {
      if (nextPickSlot === 'A') {
        setCompareIdA(target.id);
        setNextPickSlot('B');
      } else {
        setCompareIdB(target.id);
        setNextPickSlot('A');
        if (archive.length >= 2) {
          setIsCompareMode(true);
        }
      }
      return;
    }

    onOpenBriefing(target);
  };

  const handleSwapComparedEditions = () => {
    const prevA = compareIdA;
    setCompareIdA(compareIdB);
    setCompareIdB(prevA);
  };

  return (
    <section
      aria-label="Listener engagement trends"
      className="mt-6 bg-[#13161C] border border-[#222833] rounded-lg p-5"
    >
      {/* Header + Quick Compare Toggle + Time Range Switcher */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-[#1F2532]">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-[#22D3EE]">
            <Activity className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Listener Engagement Telemetry</span>
          </div>
          <h2 className="mt-1 font-serif text-xl font-medium text-[#F5F7FA]">
            {isCompareMode
              ? 'Head-to-Head Edition Comparison'
              : 'Listen Duration, Completion & Tone Sentiment'}
          </h2>
          <p className="mt-0.5 text-xs text-[#8C96A8]">
            {isCompareMode
              ? 'Side-by-side chapter duration, playback completion rate, and tone sentiment across two selected editions.'
              : 'Tracks listened minutes, playback completion percentage, and tone sentiment index across your archive.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start lg:self-center shrink-0">
          {/* Quick Compare Mode Toggle */}
          <button
            type="button"
            aria-pressed={isCompareMode}
            onClick={() => {
              const next = !isCompareMode;
              setIsCompareMode(next);
              if (next) setBarClickSelectMode(false);
            }}
            className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              isCompareMode
                ? 'bg-[#18212E] text-[#67E8F9] border border-[#22D3EE]'
                : 'bg-[#0E1116] text-[#D1D5DB] border border-[#222833] hover:border-[#22D3EE]/50 hover:text-[#67E8F9]'
            }`}
          >
            <GitCompare className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            <span>Quick Compare</span>
          </button>

          {/* Click-Bar-to-Compare Picker Toggle (Available in timeline/per-edition view) */}
          {!isCompareMode && archive.length >= 2 && (
            <button
              type="button"
              aria-pressed={barClickSelectMode}
              onClick={() => {
                setBarClickSelectMode((prev) => !prev);
                if (rangeMode !== 'editions') {
                  setRangeMode('editions');
                }
              }}
              className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                barClickSelectMode
                  ? 'bg-[#221A2E] text-[#C4B5FD] border border-[#A78BFA]'
                  : 'bg-[#0E1116] text-[#8C96A8] border border-[#222833] hover:text-[#F5F7FA]'
              }`}
            >
              <span>
                {barClickSelectMode
                  ? `Click bar for Slot ${nextPickSlot}`
                  : 'Pick Bars A/B'}
              </span>
            </button>
          )}

          {/* 7d / 30d / All-Time / Per-Edition Segmented Controls */}
          <div
            role="group"
            aria-label="Listener engagement time window and grouping"
            className="inline-flex items-center gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md"
          >
            {(
              [
                { id: '7d', label: '7d' },
                { id: '30d', label: '30d' },
                { id: 'all', label: 'All-Time' },
                { id: 'editions', label: 'Per-Edition' },
              ] as Array<{ id: EngagementRangeMode; label: string }>
            ).map((opt) => {
              const active = !isCompareMode && rangeMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setIsCompareMode(false);
                    setRangeMode(opt.id);
                  }}
                  className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
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
      </div>

      {isCompareMode ? (
        /* ==================== QUICK COMPARE MODE ==================== */
        archive.length < 2 ? (
          <div className="py-10 text-center space-y-2">
            <p className="font-serif text-lg text-[#F5F7FA]">
              Need at least two archived editions for Quick Compare
            </p>
            <p className="text-xs text-[#8C96A8] max-w-md mx-auto">
              Generate one more briefing edition so you can benchmark listen duration, chapter completion rates, and tone sentiment side-by-side.
            </p>
          </div>
        ) : (
          <>
            {/* Dual Edition Dropdown Selector Toolbar */}
            <div className="py-3.5 border-b border-[#1F2532] flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="flex-1 min-w-0">
                <label
                  htmlFor="compare-select-edition-a"
                  className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[#67E8F9] mb-1"
                >
                  <span className="w-2 h-2 rounded-xs bg-[#22D3EE] inline-block" aria-hidden="true" />
                  <span>Edition A (Cyan / Emerald)</span>
                </label>
                <select
                  id="compare-select-edition-a"
                  value={editionA?.briefingId || ''}
                  onChange={(e) => setCompareIdA(e.target.value)}
                  className="w-full h-9 px-3 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#22D3EE]/45 focus:border-[#22D3EE] focus:outline-none rounded-md cursor-pointer"
                >
                  {newestFirstMetrics.map((m) => (
                    <option key={`a-${m.briefingId}`} value={m.briefingId}>
                      {m.shortDateLabel} — {m.title} ({m.completionRate}% · {m.tonePresetLabel})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-center md:pt-5 shrink-0">
                <button
                  type="button"
                  onClick={handleSwapComparedEditions}
                  aria-label="Swap Edition A and Edition B"
                  className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#A0AABB] hover:text-[#67E8F9] bg-[#0B0D10] border border-[#262B36] hover:border-[#22D3EE]/45 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Swap</span>
                </button>
              </div>

              <div className="flex-1 min-w-0">
                <label
                  htmlFor="compare-select-edition-b"
                  className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[#FCD34D] mb-1"
                >
                  <span className="w-2 h-2 rounded-xs bg-[#F59E0B] inline-block" aria-hidden="true" />
                  <span>Edition B (Amber / Sky)</span>
                </label>
                <select
                  id="compare-select-edition-b"
                  value={editionB?.briefingId || ''}
                  onChange={(e) => setCompareIdB(e.target.value)}
                  className="w-full h-9 px-3 text-xs text-[#F5F7FA] bg-[#0B0D10] border border-[#F59E0B]/45 focus:border-[#F59E0B] focus:outline-none rounded-md cursor-pointer"
                >
                  {newestFirstMetrics.map((m) => (
                    <option key={`b-${m.briefingId}`} value={m.briefingId}>
                      {m.shortDateLabel} — {m.title} ({m.completionRate}% · {m.tonePresetLabel})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Head-to-Head Delta & Format Comparison KPI Strip */}
            {editionA && editionB && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 py-4 border-b border-[#1F2532]">
                {/* 1. Listen Duration Delta */}
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 h-8 w-8 rounded-md bg-[#0E1722] border border-[#22D3EE]/30 flex items-center justify-center shrink-0">
                    <Clock className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-[#8C96A8]">Listen Duration Delta</p>
                    <p className="mt-1 font-mono text-lg font-medium text-[#F5F7FA] tabular-nums leading-none">
                      {formatSignedDurationDelta(
                        editionA.listenedSeconds - editionB.listenedSeconds
                      )}
                    </p>
                    <p className="mt-1.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
                      A: {formatDurationCompact(editionA.listenedSeconds)} /{' '}
                      {formatDurationCompact(editionA.totalSeconds)} · B:{' '}
                      {formatDurationCompact(editionB.listenedSeconds)} /{' '}
                      {formatDurationCompact(editionB.totalSeconds)}
                    </p>
                  </div>
                </div>

                {/* 2. Completion Rate Delta */}
                <div className="sm:pl-6 sm:border-l border-[#1F2532] flex items-start gap-3">
                  <div className="mt-0.5 h-8 w-8 rounded-md bg-[#0E1F1A] border border-[#34D399]/30 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-4 h-4 text-[#34D399]" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-[#8C96A8]">Completion Rate Delta</p>
                    <p className="mt-1 font-mono text-lg font-medium text-[#34D399] tabular-nums leading-none">
                      {formatSignedPctDelta(
                        editionA.completionRate - editionB.completionRate
                      )}
                    </p>
                    <p className="mt-1.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
                      A: {editionA.completionRate}% ({editionA.chaptersCompleted}/
                      {editionA.totalChapters} ch) · B: {editionB.completionRate}% (
                      {editionB.chaptersCompleted}/{editionB.totalChapters} ch)
                    </p>
                  </div>
                </div>

                {/* 3. Tone Sentiment & Format Comparison */}
                <div className="sm:pl-6 sm:border-l border-[#1F2532] flex items-start gap-3">
                  <div className="mt-0.5 h-8 w-8 rounded-md bg-[#181625] border border-[#A78BFA]/30 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-[#A78BFA]" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-[#8C96A8]">Tone &amp; Format Matchup</p>
                    <p className="mt-1 font-mono text-sm font-medium text-[#C4B5FD] tabular-nums leading-snug">
                      A: {editionA.tonePresetLabel} ({editionA.toneSentimentScore}%) vs B:{' '}
                      {editionB.tonePresetLabel} ({editionB.toneSentimentScore}%)
                    </p>
                    <p className="mt-1 text-[11px] font-mono text-[#6E788A]">
                      {editionA.formatLabel} vs {editionB.formatLabel}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Side-by-Side Chapter ComposedChart */}
            <div className="pt-4">
              <div className="h-64 w-full select-none">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={compareChartData}
                    margin={{ top: 12, right: 8, left: -12, bottom: 4 }}
                  >
                    <CartesianGrid
                      stroke="#1F2532"
                      strokeDasharray="2 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="axisLabel"
                      tick={{
                        fill: '#8C96A8',
                        fontSize: 10,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      }}
                      axisLine={{ stroke: '#1F2532' }}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="duration"
                      orientation="left"
                      tick={{
                        fill: '#67E8F9',
                        fontSize: 10,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `${Number(v.toFixed(1))}m`}
                    />
                    <YAxis
                      yAxisId="completion"
                      orientation="right"
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tick={{
                        fill: '#34D399',
                        fontSize: 10,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <Tooltip
                      content={
                        <QuickCompareCustomTooltip
                          editionA={editionA}
                          editionB={editionB}
                        />
                      }
                      cursor={{ fill: 'rgba(34, 211, 238, 0.06)' }}
                    />
                    <ReferenceLine
                      yAxisId="completion"
                      y={80}
                      stroke="#F59E0B"
                      strokeDasharray="3 3"
                      strokeOpacity={0.35}
                    />
                    <Bar
                      yAxisId="duration"
                      dataKey="listenedMinutesA"
                      name="Edition A Listened (min)"
                      fill="#22D3EE"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={22}
                      onClick={() => {
                        if (editionA) onOpenBriefing(editionA.briefing);
                      }}
                    />
                    <Bar
                      yAxisId="duration"
                      dataKey="listenedMinutesB"
                      name="Edition B Listened (min)"
                      fill="#F59E0B"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={22}
                      onClick={() => {
                        if (editionB) onOpenBriefing(editionB.briefing);
                      }}
                    />
                    <Line
                      yAxisId="completion"
                      type="monotone"
                      dataKey="completionRateA"
                      name="Edition A Completion (%)"
                      stroke="#34D399"
                      strokeWidth={2.25}
                      dot={{
                        r: 3.5,
                        fill: '#34D399',
                        stroke: '#0B0D10',
                        strokeWidth: 1.5,
                      }}
                    />
                    <Line
                      yAxisId="completion"
                      type="monotone"
                      dataKey="completionRateB"
                      name="Edition B Completion (%)"
                      stroke="#38BDF8"
                      strokeWidth={2.25}
                      dot={{
                        r: 3.5,
                        fill: '#38BDF8',
                        stroke: '#0B0D10',
                        strokeWidth: 1.5,
                      }}
                    />
                    <Line
                      yAxisId="completion"
                      type="monotone"
                      dataKey="toneSentimentA"
                      name="Edition A Tone Sentiment (%)"
                      stroke="#A78BFA"
                      strokeWidth={1.75}
                      strokeDasharray="4 3"
                      dot={{
                        r: 2.5,
                        fill: '#A78BFA',
                        stroke: '#0B0D10',
                        strokeWidth: 1,
                      }}
                    />
                    <Line
                      yAxisId="completion"
                      type="monotone"
                      dataKey="toneSentimentB"
                      name="Edition B Tone Sentiment (%)"
                      stroke="#F472B6"
                      strokeWidth={1.75}
                      strokeDasharray="4 3"
                      dot={{
                        r: 2.5,
                        fill: '#F472B6',
                        stroke: '#0B0D10',
                        strokeWidth: 1,
                      }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Quick Compare Legend & Direct Open Links */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8C96A8]">
                <div className="flex flex-wrap items-center gap-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-[#22D3EE] inline-block" aria-hidden="true" />
                    <span>Ed. A listened (min)</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-[#F59E0B] inline-block" aria-hidden="true" />
                    <span>Ed. B listened (min)</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-0.5 bg-[#34D399] inline-block" aria-hidden="true" />
                    <span>Ed. A completion %</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-0.5 bg-[#38BDF8] inline-block" aria-hidden="true" />
                    <span>Ed. B completion %</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-0.5 border-t-2 border-dashed border-[#A78BFA] inline-block" aria-hidden="true" />
                    <span>Ed. A tone %</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-0.5 border-t-2 border-dashed border-[#F472B6] inline-block" aria-hidden="true" />
                    <span>Ed. B tone %</span>
                  </span>
                </div>

                {editionA && editionB && (
                  <div className="flex items-center gap-3 font-mono">
                    <button
                      type="button"
                      onClick={() => onOpenBriefing(editionA.briefing)}
                      className="text-[#67E8F9] hover:underline cursor-pointer"
                    >
                      Open Edition A
                    </button>
                    <span aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={() => onOpenBriefing(editionB.briefing)}
                      className="text-[#FCD34D] hover:underline cursor-pointer"
                    >
                      Open Edition B
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )
      ) : (
        /* ==================== STANDARD TIMELINE / PER-EDITION MODE ==================== */
        <>
          {/* 3-Column Engagement KPI Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 py-4 border-b border-[#1F2532]">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 h-8 w-8 rounded-md bg-[#0E1722] border border-[#22D3EE]/30 flex items-center justify-center shrink-0">
                <Clock className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs text-[#8C96A8]">
                  Time Listened ({rangeLabel})
                </p>
                <p className="mt-1 font-mono text-2xl font-medium text-[#F5F7FA] tabular-nums leading-none">
                  {formatDurationCompact(windowListenedSeconds)}
                </p>
                <p className="mt-1.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
                  of {formatDurationCompact(windowTotalSeconds)} generated audio
                </p>
              </div>
            </div>

            <div className="sm:pl-6 sm:border-l border-[#1F2532] flex items-start gap-3">
              <div className="mt-0.5 h-8 w-8 rounded-md bg-[#0E1F1A] border border-[#34D399]/30 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-4 h-4 text-[#34D399]" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs text-[#8C96A8]">
                  Playback Completion Rate
                </p>
                <p className="mt-1 font-mono text-2xl font-medium text-[#34D399] tabular-nums leading-none">
                  {windowAvgCompletionRate}%
                </p>
                <p className="mt-1.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
                  {windowCompletedCount} completed · {windowInProgressCount} in progress
                </p>
              </div>
            </div>

            <div className="sm:pl-6 sm:border-l border-[#1F2532] flex items-start gap-3">
              <div className="mt-0.5 h-8 w-8 rounded-md bg-[#181625] border border-[#A78BFA]/30 flex items-center justify-center shrink-0">
                <Headphones className="w-4 h-4 text-[#A78BFA]" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs text-[#8C96A8]">
                  Tone Sentiment &amp; Editions
                </p>
                <p className="mt-1 font-mono text-2xl font-medium text-[#C4B5FD] tabular-nums leading-none">
                  {windowAvgToneSentiment}%
                </p>
                <p className="mt-1.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
                  {windowEditionsCount}{' '}
                  {windowEditionsCount === 1 ? 'edition' : 'editions'} in window
                </p>
              </div>
            </div>
          </div>

          {/* Recharts Dual-Axis ComposedChart */}
          <div className="pt-4">
            {chartData.length === 0 ? (
              <div className="h-56 flex flex-col items-center justify-center text-center px-4 bg-[#0E1116] border border-[#1F2532] rounded-lg">
                <p className="text-sm font-medium text-[#F5F7FA]">
                  No archived briefings to plot yet
                </p>
                <p className="mt-1 text-xs text-[#8C96A8] max-w-md">
                  Generate and listen to a briefing to track daily listen duration, tone sentiment, and chapter-by-chapter completion rates.
                </p>
              </div>
            ) : (
              <div className="h-60 w-full select-none">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chartData}
                    margin={{ top: 12, right: 8, left: -12, bottom: 4 }}
                  >
                    <CartesianGrid
                      stroke="#1F2532"
                      strokeDasharray="2 3"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="axisLabel"
                      tick={{
                        fill: '#8C96A8',
                        fontSize: 10,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      }}
                      axisLine={{ stroke: '#1F2532' }}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      yAxisId="duration"
                      orientation="left"
                      tick={{
                        fill: '#67E8F9',
                        fontSize: 10,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `${Math.round(v)}m`}
                    />
                    <YAxis
                      yAxisId="completion"
                      orientation="right"
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                      tick={{
                        fill: '#34D399',
                        fontSize: 10,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `${v}%`}
                    />
                    <Tooltip
                      content={
                        <EngagementCustomTooltip
                          rangeMode={rangeMode}
                          barClickSelectMode={barClickSelectMode}
                          nextPickSlot={nextPickSlot}
                        />
                      }
                      cursor={{ fill: 'rgba(34, 211, 238, 0.06)' }}
                    />
                    <ReferenceLine
                      yAxisId="completion"
                      y={80}
                      stroke="#F59E0B"
                      strokeDasharray="3 3"
                      strokeOpacity={0.45}
                    />
                    <Bar
                      yAxisId="duration"
                      dataKey="listenedMinutes"
                      name="Listened Duration (min)"
                      stackId="durationStack"
                      fill="#22D3EE"
                      radius={[0, 0, 2, 2]}
                      maxBarSize={28}
                      onClick={(data) =>
                        handleStandardBarClick(
                          data as unknown as EngagementChartPoint
                        )
                      }
                    >
                      {chartData.map((entry) => {
                        const isPickedA =
                          barClickSelectMode &&
                          entry.targetBriefing?.id === compareIdA;
                        const isPickedB =
                          barClickSelectMode &&
                          entry.targetBriefing?.id === compareIdB;
                        return (
                          <Cell
                            key={`listened-${entry.key}`}
                            fill={
                              isPickedA
                                ? '#22D3EE'
                                : isPickedB
                                  ? '#F59E0B'
                                  : entry.listenedMinutes > 0
                                    ? '#22D3EE'
                                    : '#1B2230'
                            }
                            className={
                              entry.targetBriefing ? 'cursor-pointer' : ''
                            }
                          />
                        );
                      })}
                    </Bar>
                    <Bar
                      yAxisId="duration"
                      dataKey="remainingMinutes"
                      name="Unplayed Duration (min)"
                      stackId="durationStack"
                      fill="#1E2634"
                      radius={[3, 3, 0, 0]}
                      maxBarSize={28}
                      onClick={(data) =>
                        handleStandardBarClick(
                          data as unknown as EngagementChartPoint
                        )
                      }
                    >
                      {chartData.map((entry) => (
                        <Cell
                          key={`remaining-${entry.key}`}
                          fill="#1E2634"
                          className={
                            entry.targetBriefing ? 'cursor-pointer' : ''
                          }
                        />
                      ))}
                    </Bar>
                    <Line
                      yAxisId="completion"
                      type="monotone"
                      dataKey="completionRate"
                      name="Completion Rate (%)"
                      stroke="#34D399"
                      strokeWidth={2.25}
                      dot={{
                        r: 3.5,
                        fill: '#34D399',
                        stroke: '#0B0D10',
                        strokeWidth: 1.5,
                      }}
                      activeDot={{
                        r: 5,
                        fill: '#6EE7B7',
                        stroke: '#0B0D10',
                        strokeWidth: 1.5,
                      }}
                    />
                    <Line
                      yAxisId="completion"
                      type="monotone"
                      dataKey="toneSentimentScore"
                      name="Tone Sentiment (%)"
                      stroke="#A78BFA"
                      strokeWidth={1.9}
                      strokeDasharray="4 3"
                      dot={{
                        r: 3,
                        fill: '#A78BFA',
                        stroke: '#0B0D10',
                        strokeWidth: 1.5,
                      }}
                      activeDot={{
                        r: 4.5,
                        fill: '#C4B5FD',
                        stroke: '#0B0D10',
                        strokeWidth: 1.5,
                      }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Editorial Legend & Interaction Hint */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#8C96A8]">
              <div className="flex flex-wrap items-center gap-4">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-xs bg-[#22D3EE] inline-block"
                    aria-hidden="true"
                  />
                  <span>Listened duration (min)</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-xs bg-[#1E2634] border border-[#2E3A4E] inline-block"
                    aria-hidden="true"
                  />
                  <span>Remaining briefing length</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-3 h-0.5 bg-[#34D399] inline-block"
                    aria-hidden="true"
                  />
                  <span>Completion rate (%)</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-3 h-0.5 border-t-2 border-dashed border-[#A78BFA] inline-block"
                    aria-hidden="true"
                  />
                  <span>Tone sentiment (%)</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="w-3 h-0.5 border-t border-dashed border-[#F59E0B] inline-block"
                    aria-hidden="true"
                  />
                  <span>80% target</span>
                </span>
              </div>
              <span className="font-mono text-[#6E788A]">
                {barClickSelectMode
                  ? `Click any bar to assign Edition ${nextPickSlot}`
                  : rangeMode === 'editions'
                    ? 'Click any edition bar to open or resume'
                    : `Grouped by date (${rangeLabel})`}
              </span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
