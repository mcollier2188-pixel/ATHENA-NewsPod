import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crosshair,
  Download,
  Headphones,
  Radio,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import type { AudioBriefing, FeedAlertHistoryEntry } from '../types';

export interface MasterOrganicDayPoint {
  dateKey: string;
  subscribers: number;
  downloads: number;
  rolling7dGrowthPct: number;
  featuredEpisodeTitle: string | null;
}

interface DailyWindowBreakdownRow {
  dayOffsetLabel: string;
  dateKey: string;
  shortDateLabel: string;
  fullDateLabel: string;
  subscribers: number;
  rawDelta: number;
  cumulativeDelta: number;
  cumulativeGrowthPct: number;
  dailyVelocityPct: number;
  deltaSharePct: number;
  downloads: number;
  downloadsPerSub: number;
  isBaseline: boolean;
  isTriggerDay: boolean;
  isPeakDeltaDay: boolean;
}

interface AlertDetailModalProps {
  entry: FeedAlertHistoryEntry | null;
  onClose: () => void;
  masterOrganicPoints: MasterOrganicDayPoint[];
  matchedBriefing: AudioBriefing | null;
  onOpenBriefing: (briefing: AudioBriefing) => void;
  onFocusOnChart: (entry: FeedAlertHistoryEntry) => void;
  onToggleAcknowledge: (entry: FeedAlertHistoryEntry) => void;
  isSyncingAck: boolean;
  onExportSingleAlertCsv: (entry: FeedAlertHistoryEntry) => void;
  currentIndex: number;
  totalVisibleCount: number;
  onSelectPrevious?: () => void;
  onSelectNext?: () => void;
}

function formatUtcTimestampDisplay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }).format(d)} UTC`;
}

function formatShortDay(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

function formatFullDay(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

function addUtcDays(dateKey: string, deltaDays: number): string {
  const base = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return dateKey;
  const shifted = new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() + deltaDays
    )
  );
  return shifted.toISOString().slice(0, 10);
}

interface ModalChartTooltipPayloadItem {
  payload?: DailyWindowBreakdownRow;
}

function AlertWindowTooltip({
  active,
  payload,
  targetSubscribers,
}: {
  active?: boolean;
  payload?: ModalChartTooltipPayloadItem[];
  targetSubscribers: number;
}) {
  if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
    return null;
  }

  const row = payload[0].payload;
  const rawDeltaLabel = row.isBaseline
    ? 'Baseline'
    : row.rawDelta > 0
      ? `+${row.rawDelta}`
      : `${row.rawDelta}`;

  return (
    <div className="w-68 p-3 bg-[#0B0D10] border border-[#22D3EE]/45 rounded-lg shadow-2xl text-xs space-y-2">
      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-[#1E232D] font-mono tabular-nums">
        <span className="text-[#F5F7FA] font-medium">{row.fullDateLabel}</span>
        <span className="text-[10px] text-[#67E8F9]">{row.dayOffsetLabel}</span>
      </div>

      <div className="space-y-1 font-mono tabular-nums">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Active Subscribers</span>
          <span className="text-[#22D3EE] font-medium">
            {row.subscribers.toLocaleString()}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Raw Daily Delta</span>
          <span
            className={
              row.isBaseline
                ? 'text-[#8B95A7]'
                : row.rawDelta > 0
                  ? 'text-[#34D399] font-medium'
                  : row.rawDelta < 0
                    ? 'text-[#F87171]'
                    : 'text-[#8B95A7]'
            }
          >
            {rawDeltaLabel}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Window Cumulative</span>
          <span className="text-[#E5E7EB]">
            {row.cumulativeDelta >= 0
              ? `+${row.cumulativeDelta}`
              : row.cumulativeDelta}{' '}
            ({row.cumulativeGrowthPct >= 0 ? '+' : ''}
            {row.cumulativeGrowthPct.toFixed(1)}%)
          </span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Vs Alert Target</span>
          <span
            className={
              row.subscribers >= targetSubscribers
                ? 'text-[#34D399]'
                : 'text-[#FCD34D]'
            }
          >
            {row.subscribers >= targetSubscribers
              ? `+${row.subscribers - targetSubscribers} above`
              : `${targetSubscribers - row.subscribers} below`}{' '}
            ({targetSubscribers})
          </span>
        </div>

        <div className="pt-1 border-t border-[#1E232D] flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Daily Downloads</span>
          <span className="text-[#34D399]">
            {row.downloads.toLocaleString()} ({row.downloadsPerSub.toFixed(2)}x)
          </span>
        </div>
      </div>
    </div>
  );
}

export function AlertDetailModal({
  entry,
  onClose,
  masterOrganicPoints,
  matchedBriefing,
  onOpenBriefing,
  onFocusOnChart,
  onToggleAcknowledge,
  isSyncingAck,
  onExportSingleAlertCsv,
  currentIndex,
  totalVisibleCount,
  onSelectPrevious,
  onSelectNext,
}: AlertDetailModalProps) {
  const [csvExportedFlash, setCsvExportedFlash] = useState(false);

  useEffect(() => {
    setCsvExportedFlash(false);
  }, [entry?.id]);

  // Keyboard navigation: Escape closes, Left/Right step between visible alerts
  useEffect(() => {
    if (!entry) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT');
      if (isInputFocused) return;

      if (e.key === 'ArrowLeft' && onSelectPrevious && currentIndex > 0) {
        e.preventDefault();
        onSelectPrevious();
      } else if (
        e.key === 'ArrowRight' &&
        onSelectNext &&
        currentIndex >= 0 &&
        currentIndex < totalVisibleCount - 1
      ) {
        e.preventDefault();
        onSelectNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    entry,
    onClose,
    onSelectPrevious,
    onSelectNext,
    currentIndex,
    totalVisibleCount,
  ]);

  const analysis = useMemo(() => {
    if (!entry) return null;

    const targetSubscribers =
      entry.targetSubscribers ??
      Math.max(
        entry.startSubscribers + 1,
        Math.ceil(entry.startSubscribers * (1 + entry.thresholdPercent / 100))
      );

    // Build exact 7-day window breakdown (D-6 Baseline through D0 Trigger)
    let rawDays: Array<{
      dateKey: string;
      subscribers: number;
      downloads: number;
    }> = [];

    if (entry.eventType === 'organic') {
      const peakIdx = masterOrganicPoints.findIndex(
        (pt) => pt.dateKey === entry.dateKey
      );
      if (peakIdx >= 6) {
        rawDays = masterOrganicPoints
          .slice(peakIdx - 6, peakIdx + 1)
          .map((pt) => ({
            dateKey: pt.dateKey,
            subscribers: pt.subscribers,
            downloads: pt.downloads,
          }));
      }
    }

    // Reconstruct deterministic 7-day curve for simulated test runs or archived dates outside 90d buffer
    if (rawDays.length !== 7) {
      const weights = [0, 0.1, 0.24, 0.42, 0.62, 0.81, 1.0];
      const prior6dDownloads = Math.max(
        0,
        entry.trailing7dDownloads - entry.dailyDownloads
      );
      const dlWeights = [0.13, 0.15, 0.16, 0.17, 0.19, 0.2];
      let allocatedPriorDownloads = 0;

      rawDays = weights.map((w, idx) => {
        const dateKey = addUtcDays(entry.windowStartDate, idx);
        const subscribers =
          idx === 0
            ? entry.startSubscribers
            : idx === 6
              ? entry.endSubscribers
              : entry.startSubscribers +
                Math.round(entry.netNewSubscribers * w);

        let downloads = entry.dailyDownloads;
        if (idx < 6) {
          if (idx === 5) {
            downloads = Math.max(
              1,
              prior6dDownloads - allocatedPriorDownloads
            );
          } else {
            const d = Math.max(1, Math.round(prior6dDownloads * dlWeights[idx]));
            allocatedPriorDownloads += d;
            downloads = d;
          }
        }

        return { dateKey, subscribers, downloads };
      });
    }

    let peakDailyDelta = Number.NEGATIVE_INFINITY;
    let peakDeltaIdx = 1;
    const baselineSubs = rawDays[0]?.subscribers || entry.startSubscribers;
    const totalPositiveDelta = rawDays.reduce((sum, item, idx) => {
      if (idx === 0) return sum;
      const d = item.subscribers - rawDays[idx - 1].subscribers;
      if (d > peakDailyDelta) {
        peakDailyDelta = d;
        peakDeltaIdx = idx;
      }
      return d > 0 ? sum + d : sum;
    }, 0);

    const rows: DailyWindowBreakdownRow[] = rawDays.map((item, idx) => {
      const prevSubs = idx === 0 ? item.subscribers : rawDays[idx - 1].subscribers;
      const rawDelta = idx === 0 ? 0 : item.subscribers - prevSubs;
      const cumulativeDelta = item.subscribers - baselineSubs;
      const cumulativeGrowthPct =
        baselineSubs > 0
          ? Math.round((cumulativeDelta / baselineSubs) * 1000) / 10
          : 0;
      const dailyVelocityPct =
        idx > 0 && prevSubs > 0
          ? Math.round((rawDelta / prevSubs) * 1000) / 10
          : 0;
      const deltaSharePct =
        idx > 0 && rawDelta > 0 && totalPositiveDelta > 0
          ? Math.round((rawDelta / totalPositiveDelta) * 1000) / 10
          : 0;
      const downloadsPerSub =
        item.subscribers > 0
          ? Math.round((item.downloads / item.subscribers) * 100) / 100
          : 0;

      return {
        dayOffsetLabel: idx === 0 ? 'D-6 Base' : idx === 6 ? 'D0 Trigger' : `D-${6 - idx}`,
        dateKey: item.dateKey,
        shortDateLabel: formatShortDay(item.dateKey),
        fullDateLabel: formatFullDay(item.dateKey),
        subscribers: item.subscribers,
        rawDelta,
        cumulativeDelta,
        cumulativeGrowthPct,
        dailyVelocityPct,
        deltaSharePct,
        downloads: item.downloads,
        downloadsPerSub,
        isBaseline: idx === 0,
        isTriggerDay: idx === 6,
        isPeakDeltaDay: idx === peakDeltaIdx && rawDelta > 0,
      };
    });

    // Velocity & acceleration metrics across the 6 transition intervals (D-5..D0)
    const meanDailyNetSubs = entry.netNewSubscribers / 6;
    const compoundDailyGrowthRatePct =
      entry.startSubscribers > 0 && entry.endSubscribers > 0
        ? (Math.pow(entry.endSubscribers / entry.startSubscribers, 1 / 6) - 1) *
          100
        : 0;
    const projected30dNetSubs = Math.round(meanDailyNetSubs * 30);

    const earlyHalfDelta =
      rows.slice(1, 4).reduce((acc, r) => acc + r.rawDelta, 0);
    const lateHalfDelta =
      rows.slice(4, 7).reduce((acc, r) => acc + r.rawDelta, 0);
    const lateWindowSharePct =
      entry.netNewSubscribers > 0
        ? Math.max(
            0,
            Math.min(
              100,
              Math.round((lateHalfDelta / entry.netNewSubscribers) * 100)
            )
          )
        : 0;

    let velocityRegimeLabel = 'Steady Compounding';
    if (lateHalfDelta >= earlyHalfDelta * 1.35) {
      velocityRegimeLabel = 'Accelerating Late Surge';
    } else if (earlyHalfDelta >= lateHalfDelta * 1.35) {
      velocityRegimeLabel = 'Front-Loaded Release Wave';
    }

    const positiveTransitionDays = rows
      .slice(1)
      .filter((r) => r.rawDelta > 0).length;
    const surplusAboveTarget = entry.endSubscribers - targetSubscribers;
    const resolvedDlPerSub =
      entry.downloadsPerSubscriber ??
      (entry.endSubscribers > 0
        ? Math.round((entry.trailing7dDownloads / entry.endSubscribers) * 10) /
          10
        : 0);
    const downloadsPerNetNewSub =
      entry.netNewSubscribers > 0
        ? Math.round(
            (entry.trailing7dDownloads / entry.netNewSubscribers) * 10
          ) / 10
        : entry.trailing7dDownloads;
    const triggerDayDownloadSharePct =
      entry.trailing7dDownloads > 0
        ? Math.round(
            (entry.dailyDownloads / entry.trailing7dDownloads) * 1000
          ) / 10
        : 0;

    const minSubs = Math.min(
      ...rows.map((r) => r.subscribers),
      targetSubscribers
    );
    const maxSubs = Math.max(
      ...rows.map((r) => r.subscribers),
      targetSubscribers
    );
    const yDomain: [number, number] = [
      Math.max(0, minSubs - 2),
      maxSubs + 3,
    ];

    return {
      rows,
      targetSubscribers,
      surplusAboveTarget,
      meanDailyNetSubs,
      compoundDailyGrowthRatePct,
      projected30dNetSubs,
      earlyHalfDelta,
      lateHalfDelta,
      lateWindowSharePct,
      velocityRegimeLabel,
      positiveTransitionDays,
      peakDeltaRow: rows[peakDeltaIdx] || rows[rows.length - 1],
      resolvedDlPerSub,
      downloadsPerNetNewSub,
      triggerDayDownloadSharePct,
      yDomain,
    };
  }, [entry, masterOrganicPoints]);

  if (!entry || !analysis) return null;

  const isAcknowledged = Boolean(entry.acknowledged);
  const lifecycleLabel =
    entry.eventType === 'test'
      ? 'Simulated Test Run'
      : entry.status === 'Active'
        ? 'Active 7d Window'
        : 'Historical Crossing';
  const resolvedClientFamily = entry.topClientFamily || 'Apple Podcasts';
  const resolvedFeedAccess = entry.feedAccessLabel || 'Private Token Link';
  const resolvedChannels =
    entry.deliveryChannelSummary || 'Inline Banner · Chart Target';

  const handleExportClick = () => {
    onExportSingleAlertCsv(entry);
    setCsvExportedFlash(true);
    window.setTimeout(() => {
      setCsvExportedFlash(false);
    }, 2200);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/75 backdrop-blur-xs"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="detailed-alert-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl max-h-[90vh] flex flex-col bg-[#0F1218] border border-[#22D3EE]/40 rounded-lg shadow-2xl overflow-hidden"
      >
        {/* Modal Header */}
        <div className="px-5 py-4 bg-[#13161C] border-b border-[#1E232D] flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#8B95A7] tabular-nums">
              <span className="text-[#22D3EE]">Detailed Alert View</span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  entry.eventType === 'test'
                    ? 'text-[#F59E0B]'
                    : 'text-[#67E8F9]'
                }
              >
                {lifecycleLabel}
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatUtcTimestampDisplay(entry.triggeredAt)}</span>
              <span aria-hidden="true">·</span>
              <span className="text-[#6E788A]">ID: {entry.id}</span>
            </div>
            <h2
              id="detailed-alert-modal-title"
              className="mt-1 font-serif text-lg sm:text-xl font-medium text-[#F5F7FA] truncate"
            >
              +{entry.growthPct.toFixed(1)}% 7-Day Subscriber Growth ({entry.startSubscribers.toLocaleString()} &rarr; {entry.endSubscribers.toLocaleString()} Subscribers)
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {/* Live Firestore Acknowledgment Status & Switch */}
            <div className="inline-flex items-center gap-2 px-2.5 h-8 rounded-md border border-[#262B36] bg-[#0B0D10]">
              {isAcknowledged ? (
                <span className="inline-flex items-center gap-1 text-[#6EE7B7] font-mono text-[11px] font-medium whitespace-nowrap shrink-0">
                  <CheckCircle2
                    className="w-3.5 h-3.5 text-[#34D399] shrink-0"
                    aria-hidden="true"
                  />
                  <span>Acknowledged</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[#FCD34D] font-mono text-[11px] font-medium whitespace-nowrap shrink-0">
                  <Clock
                    className="w-3.5 h-3.5 text-[#FBBF24] shrink-0"
                    aria-hidden="true"
                  />
                  <span>Pending</span>
                </span>
              )}

              <button
                type="button"
                role="switch"
                aria-checked={isAcknowledged}
                disabled={isSyncingAck}
                onClick={() => onToggleAcknowledge(entry)}
                aria-label="Toggle alert acknowledgment status in Firestore"
                className={`relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                  isAcknowledged ? 'bg-[#22D3EE]' : 'bg-[#2A303C]'
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 rounded-full bg-[#071318] transition-transform ${
                    isAcknowledged ? 'translate-x-4' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Previous / Next Alert Navigation */}
            {totalVisibleCount > 1 && currentIndex >= 0 && (
              <div
                className="inline-flex items-center bg-[#0B0D10] border border-[#262B36] rounded-md h-8"
                role="group"
                aria-label="Step through filtered alerts"
              >
                <button
                  type="button"
                  onClick={onSelectPrevious}
                  disabled={!onSelectPrevious || currentIndex <= 0}
                  aria-label="Inspect previous alert in list"
                  className="h-full px-2 text-[#A0AABB] hover:text-[#F5F7FA] disabled:opacity-35 transition-colors cursor-pointer disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <span className="px-2 font-mono text-[11px] text-[#8B95A7] border-x border-[#262B36] tabular-nums whitespace-nowrap">
                  {currentIndex + 1} / {totalVisibleCount}
                </span>
                <button
                  type="button"
                  onClick={onSelectNext}
                  disabled={
                    !onSelectNext || currentIndex >= totalVisibleCount - 1
                  }
                  aria-label="Inspect next alert in list"
                  className="h-full px-2 text-[#A0AABB] hover:text-[#F5F7FA] disabled:opacity-35 transition-colors cursor-pointer disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Close Detailed Alert View modal"
              className="h-8 w-8 inline-flex items-center justify-center text-[#8B95A7] hover:text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] hover:border-[#3A4150] rounded-md transition-colors shrink-0 cursor-pointer"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Scrollable Analytical Body */}
        <div className="flex-1 overflow-y-auto divide-y divide-[#1E232D]">
          {/* 1. 4-Column Raw Subscriber Delta & Growth Velocity KPI Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[#1E232D] bg-[#0B0D10]/70">
            {/* Metric 1: Raw Subscriber Delta */}
            <div className="p-4 space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs text-[#8B95A7]">
                <span>Raw Subscriber Delta (7d)</span>
                <Users
                  className="w-3.5 h-3.5 text-[#22D3EE] shrink-0"
                  aria-hidden="true"
                />
              </div>
              <div className="flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-2xl font-semibold text-[#34D399]">
                  +{entry.netNewSubscribers.toLocaleString()}
                </span>
                <span className="text-xs text-[#E5E7EB]">
                  ({entry.startSubscribers.toLocaleString()} &rarr;{' '}
                  {entry.endSubscribers.toLocaleString()})
                </span>
              </div>
              <p className="font-mono text-[11px] text-[#6E788A] tabular-nums">
                {analysis.surplusAboveTarget >= 0
                  ? `+${analysis.surplusAboveTarget} subs above ${analysis.targetSubscribers} target`
                  : `Target threshold: ${analysis.targetSubscribers} subs`}
              </p>
            </div>

            {/* Metric 2: Growth Rate & Compound Daily Velocity */}
            <div className="p-4 space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs text-[#8B95A7]">
                <span>Growth Velocity &amp; CDGR</span>
                <TrendingUp
                  className="w-3.5 h-3.5 text-[#34D399] shrink-0"
                  aria-hidden="true"
                />
              </div>
              <div className="flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-2xl font-semibold text-[#F5F7FA]">
                  +{analysis.meanDailyNetSubs.toFixed(2)}
                </span>
                <span className="text-xs text-[#67E8F9]">subs / day</span>
              </div>
              <p className="font-mono text-[11px] text-[#6E788A] tabular-nums">
                CDGR +{analysis.compoundDailyGrowthRatePct.toFixed(2)}%/d · 30d
                pace +{analysis.projected30dNetSubs} subs
              </p>
            </div>

            {/* Metric 3: Momentum & Window Acceleration Breakdown */}
            <div className="p-4 space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs text-[#8B95A7]">
                <span>Window Acceleration Split</span>
                <Radio
                  className="w-3.5 h-3.5 text-[#F59E0B] shrink-0"
                  aria-hidden="true"
                />
              </div>
              <div className="flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-lg font-semibold text-[#F5F7FA]">
                  {analysis.earlyHalfDelta >= 0
                    ? `+${analysis.earlyHalfDelta}`
                    : analysis.earlyHalfDelta}{' '}
                  vs{' '}
                  <span className="text-[#67E8F9]">
                    {analysis.lateHalfDelta >= 0
                      ? `+${analysis.lateHalfDelta}`
                      : analysis.lateHalfDelta}
                  </span>
                </span>
                <span className="text-[11px] text-[#8B95A7]">early / late</span>
              </div>
              <p className="font-mono text-[11px] text-[#6E788A] tabular-nums">
                {analysis.velocityRegimeLabel} · {analysis.lateWindowSharePct}%
                in final 72h
              </p>
            </div>

            {/* Metric 4: Download Velocity & Conversion Intensity */}
            <div className="p-4 space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs text-[#8B95A7]">
                <span>Download Velocity (7d)</span>
                <Download
                  className="w-3.5 h-3.5 text-[#67E8F9] shrink-0"
                  aria-hidden="true"
                />
              </div>
              <div className="flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-2xl font-semibold text-[#F5F7FA]">
                  {analysis.resolvedDlPerSub.toFixed(1)}x
                </span>
                <span className="text-xs text-[#34D399]">
                  {entry.trailing7dDownloads.toLocaleString()} WAVs
                </span>
              </div>
              <p className="font-mono text-[11px] text-[#6E788A] tabular-nums">
                {analysis.downloadsPerNetNewSub.toFixed(1)} DLs / new sub ·{' '}
                {analysis.triggerDayDownloadSharePct}% on D0
              </p>
            </div>
          </div>

          {/* 2. Interactive 7-Day Window Trajectory & Daily Raw Delta Chart */}
          <div className="p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <div>
                <h3 className="font-medium text-[#F5F7FA]">
                  7-Day Evaluation Window Trajectory ({entry.windowStartDate}{' '}
                  &rarr; {entry.dateKey})
                </h3>
                <p className="mt-0.5 text-[#8B95A7] font-mono text-[11px] tabular-nums">
                  Rule threshold +{entry.thresholdPercent}% (
                  {analysis.targetSubscribers.toLocaleString()} subs) · Exceeded
                  by +{entry.varianceOverThresholdPct.toFixed(1)}% · Peak daily
                  gain +{analysis.peakDeltaRow.rawDelta} subs on{' '}
                  {analysis.peakDeltaRow.shortDateLabel}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono">
                <span className="inline-flex items-center gap-1.5 text-[#D1D5DB]">
                  <span
                    className="inline-block w-3 h-0.5 bg-[#22D3EE]"
                    aria-hidden="true"
                  />
                  <span>Active Subscribers</span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-[#D1D5DB]">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-xs bg-[#34D399]"
                    aria-hidden="true"
                  />
                  <span>Raw Daily Subscriber Delta</span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-[#FCD34D]">
                  <span
                    className="inline-block w-3 border-t border-dashed border-[#F59E0B]"
                    aria-hidden="true"
                  />
                  <span>Target ({analysis.targetSubscribers})</span>
                </span>
              </div>
            </div>

            <div className="h-56 w-full bg-[#0B0D10] border border-[#1E232D] rounded-md p-3">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={analysis.rows}
                  margin={{ top: 10, right: 12, left: 0, bottom: 2 }}
                >
                  <defs>
                    <linearGradient
                      id="alertDetailSubscribersGradient"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="#22D3EE"
                        stopOpacity={0.28}
                      />
                      <stop
                        offset="95%"
                        stopColor="#22D3EE"
                        stopOpacity={0.0}
                      />
                    </linearGradient>
                  </defs>

                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#1E232D"
                    vertical={false}
                  />

                  <XAxis
                    dataKey="shortDateLabel"
                    stroke="#6E788A"
                    tick={{
                      fill: '#8B95A7',
                      fontSize: 11,
                      fontFamily: 'monospace',
                    }}
                    tickLine={false}
                    axisLine={{ stroke: '#1E232D' }}
                  />

                  <YAxis
                    yAxisId="subs"
                    orientation="left"
                    domain={analysis.yDomain}
                    stroke="#22D3EE"
                    tick={{
                      fill: '#67E8F9',
                      fontSize: 11,
                      fontFamily: 'monospace',
                    }}
                    tickLine={false}
                    axisLine={false}
                    width={38}
                  />

                  <YAxis
                    yAxisId="delta"
                    orientation="right"
                    stroke="#34D399"
                    allowDecimals={false}
                    tick={{
                      fill: '#6EE7B7',
                      fontSize: 11,
                      fontFamily: 'monospace',
                    }}
                    tickLine={false}
                    axisLine={false}
                    width={32}
                  />

                  <Tooltip
                    content={
                      <AlertWindowTooltip
                        targetSubscribers={analysis.targetSubscribers}
                      />
                    }
                    cursor={{ fill: 'rgba(34, 211, 238, 0.06)' }}
                  />

                  <Bar
                    yAxisId="delta"
                    dataKey="rawDelta"
                    name="Raw Daily Delta"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={28}
                  >
                    {analysis.rows.map((row) => (
                      <Cell
                        key={row.dateKey}
                        fill={
                          row.isPeakDeltaDay
                            ? '#F59E0B'
                            : row.rawDelta < 0
                              ? '#F87171'
                              : '#34D399'
                        }
                        fillOpacity={row.isBaseline ? 0.25 : 0.85}
                      />
                    ))}
                  </Bar>

                  <ReferenceLine
                    yAxisId="subs"
                    y={analysis.targetSubscribers}
                    stroke="#F59E0B"
                    strokeDasharray="5 4"
                    strokeWidth={1.5}
                    label={{
                      value: `Target ${analysis.targetSubscribers} (+${entry.thresholdPercent}%)`,
                      position: 'insideTopLeft',
                      fill: '#FCD34D',
                      fontSize: 11,
                      fontFamily: 'monospace',
                    }}
                  />

                  <Area
                    yAxisId="subs"
                    type="monotone"
                    dataKey="subscribers"
                    name="Active Subscribers"
                    stroke="#22D3EE"
                    strokeWidth={2.25}
                    fillOpacity={1}
                    fill="url(#alertDetailSubscribersGradient)"
                    activeDot={{
                      r: 4.5,
                      fill: '#22D3EE',
                      stroke: '#0B0D10',
                      strokeWidth: 2,
                    }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 3. Day-by-Day Raw Subscriber Delta & Growth Velocity Breakdown Table */}
          <div className="p-5 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium text-[#F5F7FA]">
                Daily Raw Subscriber Delta &amp; Velocity Breakdown
              </h3>
              <span className="font-mono text-[11px] text-[#8B95A7] tabular-nums">
                {analysis.positiveTransitionDays} of 6 transition days net-positive
                · Total +{entry.netNewSubscribers} net subscribers
              </span>
            </div>

            <div className="overflow-x-auto border border-[#1E232D] rounded-md bg-[#0B0D10]">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1E232D] text-[11px] font-medium text-[#8B95A7] bg-[#13161C]/80">
                    <th scope="col" className="py-2 px-3 whitespace-nowrap">
                      Window Day
                    </th>
                    <th scope="col" className="py-2 px-3 whitespace-nowrap">
                      Date (UTC)
                    </th>
                    <th
                      scope="col"
                      className="py-2 px-3 text-right whitespace-nowrap"
                    >
                      Subscribers
                    </th>
                    <th
                      scope="col"
                      className="py-2 px-3 text-right whitespace-nowrap"
                    >
                      Raw Daily Delta
                    </th>
                    <th
                      scope="col"
                      className="py-2 px-3 text-right whitespace-nowrap"
                    >
                      Day-over-Day Velocity
                    </th>
                    <th
                      scope="col"
                      className="py-2 px-3 text-right whitespace-nowrap"
                    >
                      Cumulative 7d Growth
                    </th>
                    <th
                      scope="col"
                      className="py-2 px-3 text-right whitespace-nowrap"
                    >
                      Share of Gain
                    </th>
                    <th
                      scope="col"
                      className="py-2 px-3 text-right whitespace-nowrap"
                    >
                      WAV Downloads
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E232D] font-mono text-[11px] tabular-nums">
                  {analysis.rows.map((row) => (
                    <tr
                      key={row.dateKey}
                      className={
                        row.isTriggerDay
                          ? 'bg-[#131C26]/75'
                          : 'hover:bg-[#13161C]/60'
                      }
                    >
                      <td className="py-2 px-3 whitespace-nowrap">
                        <span
                          className={
                            row.isTriggerDay
                              ? 'text-[#67E8F9] font-medium'
                              : row.isBaseline
                                ? 'text-[#8B95A7]'
                                : 'text-[#D1D5DB]'
                          }
                        >
                          {row.dayOffsetLabel}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-[#A0AABB] whitespace-nowrap">
                        {row.dateKey}
                      </td>
                      <td className="py-2 px-3 text-right text-[#F5F7FA] font-medium whitespace-nowrap">
                        {row.subscribers.toLocaleString()}
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {row.isBaseline ? (
                          <span className="text-[#6E788A]">Baseline</span>
                        ) : (
                          <span
                            className={
                              row.rawDelta > 0
                                ? 'text-[#34D399] font-medium'
                                : row.rawDelta < 0
                                  ? 'text-[#F87171]'
                                  : 'text-[#8B95A7]'
                            }
                          >
                            {row.rawDelta > 0
                              ? `+${row.rawDelta}`
                              : row.rawDelta}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {row.isBaseline ? (
                          <span className="text-[#6E788A]">&mdash;</span>
                        ) : (
                          <span
                            className={
                              row.dailyVelocityPct > 0
                                ? 'text-[#6EE7B7]'
                                : row.dailyVelocityPct < 0
                                  ? 'text-[#F87171]'
                                  : 'text-[#8B95A7]'
                            }
                          >
                            {row.dailyVelocityPct > 0
                              ? `+${row.dailyVelocityPct.toFixed(1)}%/d`
                              : `${row.dailyVelocityPct.toFixed(1)}%/d`}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        <span
                          className={
                            row.subscribers >= analysis.targetSubscribers
                              ? 'text-[#34D399] font-medium'
                              : 'text-[#E5E7EB]'
                          }
                        >
                          {row.cumulativeDelta >= 0
                            ? `+${row.cumulativeDelta}`
                            : row.cumulativeDelta}{' '}
                          ({row.cumulativeGrowthPct >= 0 ? '+' : ''}
                          {row.cumulativeGrowthPct.toFixed(1)}%)
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right text-[#A0AABB] whitespace-nowrap">
                        {row.isBaseline
                          ? '—'
                          : `${row.deltaSharePct.toFixed(1)}%`}
                      </td>
                      <td className="py-2 px-3 text-right text-[#E5E7EB] whitespace-nowrap">
                        {row.downloads.toLocaleString()}{' '}
                        <span className="text-[#6E788A]">
                          ({row.downloadsPerSub.toFixed(1)}x)
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 4. Full Enriched Metadata & Attribution Specification */}
          <div className="p-5 space-y-3">
            <h3 className="text-xs font-medium text-[#F5F7FA]">
              Full Alert Metadata &amp; Attribution Record
            </h3>

            <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-4 bg-[#0B0D10] border border-[#1E232D] rounded-md text-xs">
              <div className="space-y-1">
                <dt className="text-[11px] text-[#8B95A7]">
                  Alert Identifier &amp; Event Classification
                </dt>
                <dd className="font-mono text-[#F5F7FA] tabular-nums break-all">
                  {entry.id} · {lifecycleLabel}
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-[11px] text-[#8B95A7]">
                  Evaluation Window &amp; Trigger Timestamp
                </dt>
                <dd className="font-mono text-[#F5F7FA] tabular-nums">
                  {entry.windowStartDate} &rarr; {entry.dateKey} (
                  {formatUtcTimestampDisplay(entry.triggeredAt)})
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-[11px] text-[#8B95A7]">
                  Rule Threshold &amp; Variance Math
                </dt>
                <dd className="font-mono text-[#F5F7FA] tabular-nums">
                  Rule &ge; +{entry.thresholdPercent.toFixed(1)}% · Actual +
                  {entry.growthPct.toFixed(1)}% (+
                  {entry.varianceOverThresholdPct.toFixed(1)}% over rule)
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-[11px] text-[#8B95A7]">
                  Syndicated Feed &amp; Security Mode
                </dt>
                <dd className="font-mono text-[#F5F7FA]">
                  {entry.feedTitle} · {resolvedFeedAccess}
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-[11px] text-[#8B95A7]">
                  Primary Listener App &amp; Delivery Channels
                </dt>
                <dd className="font-mono text-[#F5F7FA]">
                  <span className="text-[#67E8F9]">{resolvedClientFamily}</span>{' '}
                  · {resolvedChannels}
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-[11px] text-[#8B95A7]">
                  Acknowledgment Audit &amp; Sync Source
                </dt>
                <dd className="font-mono text-[#F5F7FA] tabular-nums">
                  {isAcknowledged
                    ? `Acknowledged${
                        entry.acknowledgedAt
                          ? ` (${formatUtcTimestampDisplay(
                              entry.acknowledgedAt
                            )})`
                          : ''
                      }`
                    : 'Pending acknowledgment'}{' '}
                  ·{' '}
                  {entry.ackSyncSource === 'firestore'
                    ? 'Firestore Sync'
                    : 'Local Browser Cache'}
                </dd>
              </div>

              <div className="sm:col-span-2 lg:col-span-3 pt-3 border-t border-[#1E232D] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <dt className="text-[11px] text-[#8B95A7]">
                    Top Attribution Driver Edition
                  </dt>
                  <dd className="mt-0.5 font-serif text-sm text-[#F5F7FA] truncate">
                    {entry.driverEpisodeTitle}
                  </dd>
                </div>

                {matchedBriefing && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenBriefing(matchedBriefing);
                      onClose();
                    }}
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#34D399] hover:bg-[#6EE7B7] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Headphones className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Open Driver Edition</span>
                  </button>
                )}
              </div>
            </dl>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3.5 bg-[#13161C] border-t border-[#1E232D] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <span className="font-mono text-[11px] text-[#6E788A]">
            Tip: Use Left / Right arrow keys to compare adjacent alerts in your filtered view.
          </span>

          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={handleExportClick}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] hover:border-[#22D3EE]/60 hover:text-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {csvExportedFlash ? (
                <Check
                  className="w-3.5 h-3.5 text-[#34D399]"
                  aria-hidden="true"
                />
              ) : (
                <Download
                  className="w-3.5 h-3.5 text-[#22D3EE]"
                  aria-hidden="true"
                />
              )}
              <span>
                {csvExportedFlash ? 'Exported Alert CSV' : 'Export Alert CSV'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                onFocusOnChart(entry);
                onClose();
              }}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Crosshair className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Focus on Main Chart</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] hover:border-[#3A4150] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
