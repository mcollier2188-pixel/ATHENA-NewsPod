import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bell,
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Crosshair,
  Download,
  FileSpreadsheet,
  FlaskConical,
  Headphones,
  History,
  Radio,
  RefreshCw,
  Rss,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  TrendingUp,
  Users,
  X,
} from 'lucide-react';
import type {
  AudioBriefing,
  FeedAlertEventStatus,
  FeedAlertHistoryEntry,
  FeedGrowthAlertConfig,
  LocalRssFeedConfig,
  RssClientAppFamily,
  RssFeedAnalyticsSnapshot,
} from '../types';
import {
  fetchPrivateRssAnalytics,
  saveLocalRssFeedConfig,
} from '../services/rssApi';
import {
  makeScopedAlertLookupKey,
  subscribeToUserFeedAlertAcknowledgments,
  upsertFeedAlertAcknowledgment,
  type FirestoreAlertAcknowledgmentRecord,
} from '../services/firestoreAlertAcknowledgments';
import { formatClock } from '../utils/wavUtils';
import { useAuth } from '../contexts/AuthContext';

export type FeedPerformanceWindow = '7d' | '30d' | '90d';
export type FeedSeriesFocus = 'all' | 'subscribers' | 'downloads';

const STORAGE_GROWTH_ALERT_KEY = 'dispatch_feed_growth_alert_v1';
const STORAGE_ALERT_HISTORY_KEY = 'dispatch_feed_alert_history_v1';
const PRESET_THRESHOLDS = [5, 10, 15, 25] as const;
const TEST_ALERT_DURATION_SECONDS = 15;
const MAX_STORED_TEST_LOGS = 60;

type BrowserPermissionOutcome =
  | 'granted-sent'
  | 'denied'
  | 'sandbox-restricted'
  | 'unsupported';

interface TestAlertDiagnostics {
  testedAtLabel: string;
  thresholdTested: number;
  simulatedGrowthPct: number;
  simulatedNetNewSubs: number;
  targetSubscribers: number;
  bannerVerified: boolean;
  browserOutcome: BrowserPermissionOutcome;
}

interface StoredAlertHistoryState {
  testEntries: FeedAlertHistoryEntry[];
  acknowledgedDateKeys: string[];
  acknowledgedTimestamps: Record<string, string>;
}

type AlertDrawerFilterTab =
  | 'all'
  | 'Pending'
  | 'Acknowledged'
  | 'Active'
  | 'Historical'
  | 'test';

type AlertDrawerSortField =
  | 'triggeredAt'
  | 'growthPct'
  | 'netNewSubscribers'
  | 'trailing7dDownloads'
  | 'status';

type AlertDrawerSortDirection = 'asc' | 'desc';

interface FeedPerformanceDashboardProps {
  archive: AudioBriefing[];
  rssFeedConfig: LocalRssFeedConfig | null;
  onRssFeedConfigChange?: (next: LocalRssFeedConfig | null) => void;
  onOpenBriefing: (briefing: AudioBriefing) => void;
  onOpenRssModal: () => void;
}

interface FeedPerformanceChartPoint {
  dateKey: string;
  shortLabel: string;
  fullDateLabel: string;
  activeSubscribers: number;
  subscriberDelta: number;
  rolling7dGrowthPct: number;
  exceedsGrowthThreshold: boolean;
  dailyDownloads: number;
  cumulativeDownloads: number;
  liveDownloadsOnDay: number;
  livePollsOnDay: number;
  featuredEpisodeTitle: string | null;
  isPeakDownloadDay: boolean;
}

interface TopEpisodePerformanceRow {
  briefing: AudioBriefing;
  totalDownloads: number;
  liveDownloads: number;
  sharePercent: number;
  durationSeconds: number;
  formatLabel: string;
}

interface ClientAppBreakdownRow {
  family: RssClientAppFamily;
  count: number;
  sharePercent: number;
  accentHex: string;
  barClass: string;
}

function readBrowserNotificationPermission():
  | NotificationPermission
  | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

function formatBrowserPermissionLabel(
  perm: NotificationPermission | 'unsupported'
): string {
  if (perm === 'granted') return 'Granted';
  if (perm === 'denied') return 'Blocked in Browser';
  if (perm === 'default') return 'Prompt on Test / Enable';
  return 'Unsupported';
}

function formatBrowserOutcomeSummary(outcome: BrowserPermissionOutcome): {
  label: string;
  detail: string;
  toneClass: string;
} {
  switch (outcome) {
    case 'granted-sent':
      return {
        label: 'Granted · Test Sent',
        detail:
          'Desktop test notification dispatched via Web Notifications API.',
        toneClass: 'text-[#34D399]',
      };
    case 'denied':
      return {
        label: 'Permission Denied',
        detail:
          'Browser notifications are blocked for this origin; inline banner and chart alerts remain active.',
        toneClass: 'text-[#F59E0B]',
      };
    case 'sandbox-restricted':
      return {
        label: 'Preview Sandbox Restricted',
        detail:
          'Embedded iframe blocked the desktop prompt; open the app in a standalone tab for OS notifications.',
        toneClass: 'text-[#F59E0B]',
      };
    case 'unsupported':
      return {
        label: 'Unsupported Browser',
        detail:
          'Web Notifications API is unavailable here; inline banner and chart alerts remain active.',
        toneClass: 'text-[#8B95A7]',
      };
  }
}

function loadStoredGrowthAlertConfig(
  feedConfig: LocalRssFeedConfig | null
): FeedGrowthAlertConfig {
  if (feedConfig?.growthAlert) {
    return {
      enabled: feedConfig.growthAlert.enabled !== false,
      thresholdPercent: Math.min(
        200,
        Math.max(1, feedConfig.growthAlert.thresholdPercent || 10)
      ),
      browserNotificationsEnabled: Boolean(
        feedConfig.growthAlert.browserNotificationsEnabled
      ),
      acknowledgedSignature:
        feedConfig.growthAlert.acknowledgedSignature ?? null,
    };
  }
  try {
    const raw = localStorage.getItem(STORAGE_GROWTH_ALERT_KEY);
    if (!raw) {
      return {
        enabled: true,
        thresholdPercent: 10,
        browserNotificationsEnabled: false,
        acknowledgedSignature: null,
      };
    }
    const parsed = JSON.parse(raw) as Partial<FeedGrowthAlertConfig>;
    return {
      enabled: parsed.enabled !== false,
      thresholdPercent:
        typeof parsed.thresholdPercent === 'number' &&
        Number.isFinite(parsed.thresholdPercent)
          ? Math.min(200, Math.max(1, parsed.thresholdPercent))
          : 10,
      browserNotificationsEnabled: Boolean(parsed.browserNotificationsEnabled),
      acknowledgedSignature: parsed.acknowledgedSignature ?? null,
    };
  } catch {
    return {
      enabled: true,
      thresholdPercent: 10,
      browserNotificationsEnabled: false,
      acknowledgedSignature: null,
    };
  }
}

function saveStoredGrowthAlertConfig(config: FeedGrowthAlertConfig): void {
  try {
    localStorage.setItem(STORAGE_GROWTH_ALERT_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage quota errors
  }
}

function loadStoredAlertHistoryState(): StoredAlertHistoryState {
  try {
    const raw = localStorage.getItem(STORAGE_ALERT_HISTORY_KEY);
    if (!raw) {
      return {
        testEntries: [],
        acknowledgedDateKeys: [],
        acknowledgedTimestamps: {},
      };
    }
    const parsed = JSON.parse(raw) as Partial<StoredAlertHistoryState>;
    const testEntries = Array.isArray(parsed.testEntries)
      ? parsed.testEntries.slice(0, MAX_STORED_TEST_LOGS)
      : [];
    const acknowledgedDateKeys = Array.isArray(parsed.acknowledgedDateKeys)
      ? parsed.acknowledgedDateKeys.filter(
          (k): k is string => typeof k === 'string'
        )
      : [];
    const acknowledgedTimestamps =
      parsed.acknowledgedTimestamps &&
      typeof parsed.acknowledgedTimestamps === 'object'
        ? (parsed.acknowledgedTimestamps as Record<string, string>)
        : {};
    return { testEntries, acknowledgedDateKeys, acknowledgedTimestamps };
  } catch {
    return {
      testEntries: [],
      acknowledgedDateKeys: [],
      acknowledgedTimestamps: {},
    };
  }
}

function saveStoredAlertHistoryState(state: StoredAlertHistoryState): void {
  try {
    localStorage.setItem(
      STORAGE_ALERT_HISTORY_KEY,
      JSON.stringify({
        testEntries: state.testEntries.slice(0, MAX_STORED_TEST_LOGS),
        acknowledgedDateKeys: state.acknowledgedDateKeys.slice(-200),
        acknowledgedTimestamps: state.acknowledgedTimestamps || {},
      })
    );
  } catch {
    // Ignore storage quota errors
  }
}

function resolveFeedAccessLabel(feedConfig: LocalRssFeedConfig | null): string {
  if (!feedConfig) return 'Preview Syndication';
  if (feedConfig.passwordProtected) {
    return feedConfig.useSignedUrlKey
      ? 'Password + Signed Key'
      : 'HTTP Basic Auth';
  }
  return 'Private Token Link';
}

function resolveTopClientForSeed(seed: string): RssClientAppFamily {
  const bucket = deterministicHash(seed) % 10;
  if (bucket <= 4) return 'Apple Podcasts';
  if (bucket <= 7) return 'Overcast';
  if (bucket === 8) return 'Pocket Casts';
  return 'Direct & Web RSS';
}

function getCanonicalAlertKey(entry: {
  id: string;
  eventType: 'organic' | 'test';
  dateKey: string;
  thresholdPercent: number;
}): string {
  return entry.eventType === 'organic'
    ? `${entry.dateKey}:${entry.thresholdPercent}`
    : entry.id;
}

function getAlertStatusSortRank(entry: FeedAlertHistoryEntry): number {
  const isAck = entry.acknowledged ?? entry.status === 'Acknowledged';
  if (!isAck) {
    if (entry.status === 'Active') return 5;
    if (entry.eventType === 'test') return 4;
    return 3;
  }
  return entry.eventType === 'organic' ? 2 : 1;
}

function sanitizeCsvTextCell(raw: string): string {
  const cleaned = String(raw ?? '').replace(/\r?\n/g, ' ').trim();
  // Guard against spreadsheet formula execution when opened in Excel / Sheets
  const safePrefix =
    /^[=+\-@]/.test(cleaned) || /^[\t\r]/.test(String(raw ?? ''))
      ? `'${cleaned}`
      : cleaned;
  return `"${safePrefix.replace(/"/g, '""')}"`;
}

function formatCsvNumberCell(value: number, decimals?: number): string {
  if (!Number.isFinite(value)) return '0';
  if (typeof decimals === 'number') {
    return value.toFixed(decimals);
  }
  return String(Math.round(value));
}

function buildAlertHistoryCsvContent(entries: FeedAlertHistoryEntry[]): string {
  const headers = [
    'Alert ID',
    'Triggered At (UTC)',
    'Trigger Date',
    '7d Window Start Date',
    'Event Type',
    'Feed Title',
    'Feed Access Mode',
    'Threshold (%)',
    '7d Growth Rate (%)',
    'Variance Over Threshold (%)',
    'Start Subscribers (7d Ago)',
    'Target Subscribers',
    'Triggered Subscribers',
    'Net New Subscribers (7d)',
    'Trailing 7d Downloads',
    'Trigger Day Downloads',
    'Downloads / Subscriber (7d)',
    'Primary Client App',
    'Delivery Channels',
    'Top Driver Episode',
    'Acknowledgment Status',
    'Lifecycle Window',
    'Acknowledged At (UTC)',
    'Sync Source',
  ];

  const rows = entries.map((entry) => {
    const targetSubs =
      entry.targetSubscribers ??
      Math.max(
        entry.startSubscribers + 1,
        Math.ceil(entry.startSubscribers * (1 + entry.thresholdPercent / 100))
      );
    const dlPerSub =
      entry.downloadsPerSubscriber ??
      (entry.endSubscribers > 0
        ? Math.round((entry.trailing7dDownloads / entry.endSubscribers) * 10) /
          10
        : 0);
    const isAck = entry.acknowledged ?? entry.status === 'Acknowledged';
    const lifecycleLabel =
      entry.eventType === 'test'
        ? 'Test Run'
        : entry.status === 'Active'
          ? 'Active Window'
          : 'Historical';

    return [
      sanitizeCsvTextCell(entry.id),
      sanitizeCsvTextCell(entry.triggeredAt),
      sanitizeCsvTextCell(entry.dateKey),
      sanitizeCsvTextCell(entry.windowStartDate),
      sanitizeCsvTextCell(
        entry.eventType === 'test' ? 'Simulated Test' : 'Organic'
      ),
      sanitizeCsvTextCell(entry.feedTitle),
      sanitizeCsvTextCell(entry.feedAccessLabel || 'Private Token Link'),
      formatCsvNumberCell(entry.thresholdPercent, 1),
      formatCsvNumberCell(entry.growthPct, 1),
      formatCsvNumberCell(entry.varianceOverThresholdPct, 1),
      formatCsvNumberCell(entry.startSubscribers),
      formatCsvNumberCell(targetSubs),
      formatCsvNumberCell(entry.endSubscribers),
      formatCsvNumberCell(entry.netNewSubscribers),
      formatCsvNumberCell(entry.trailing7dDownloads),
      formatCsvNumberCell(entry.dailyDownloads),
      formatCsvNumberCell(dlPerSub, 1),
      sanitizeCsvTextCell(
        entry.topClientFamily || resolveTopClientForSeed(entry.id)
      ),
      sanitizeCsvTextCell(
        entry.deliveryChannelSummary || 'Inline Banner · Chart Target'
      ),
      sanitizeCsvTextCell(entry.driverEpisodeTitle),
      sanitizeCsvTextCell(isAck ? 'Acknowledged' : 'Pending'),
      sanitizeCsvTextCell(lifecycleLabel),
      sanitizeCsvTextCell(isAck ? entry.acknowledgedAt || '' : ''),
      sanitizeCsvTextCell(
        entry.ackSyncSource === 'firestore' ? 'Firestore' : 'Local Browser'
      ),
    ];
  });

  const lines = [headers.map(sanitizeCsvTextCell).join(',')];
  for (const row of rows) {
    lines.push(row.join(','));
  }
  // Prepend UTF-8 BOM for clean UTF-8 detection in Excel, Numbers, and Sheets
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function triggerCsvDownload(csvContent: string, filename: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  link.className = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1500);
}

function deterministicHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatAxisDateLabel(
  dateKey: string,
  windowMode: FeedPerformanceWindow
): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  if (windowMode === '7d') {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(d);
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(d);
}

function formatTooltipDateLabel(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

function formatHistoryTimestamp(iso: string, eventType: 'organic' | 'test'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (eventType === 'test') {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

interface CustomTooltipPayloadItem {
  payload?: FeedPerformanceChartPoint;
}

function FeedPerformanceTooltip({
  active,
  payload,
  alertEnabled,
  thresholdPercent,
}: {
  active?: boolean;
  payload?: CustomTooltipPayloadItem[];
  alertEnabled: boolean;
  thresholdPercent: number;
}) {
  if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
    return null;
  }

  const point = payload[0].payload;
  const subDeltaText =
    point.subscriberDelta > 0
      ? `+${point.subscriberDelta}`
      : point.subscriberDelta < 0
        ? `${point.subscriberDelta}`
        : '0';
  const growthText =
    point.rolling7dGrowthPct > 0
      ? `+${point.rolling7dGrowthPct.toFixed(1)}%`
      : `${point.rolling7dGrowthPct.toFixed(1)}%`;

  return (
    <div className="w-76 p-3.5 bg-[#0F1218] border border-[#22D3EE]/45 rounded-lg shadow-2xl text-xs space-y-2.5">
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-[#1E232D]">
        <span className="font-mono text-[#F5F7FA] font-medium tabular-nums">
          {point.fullDateLabel}
        </span>
        <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums">
          {alertEnabled && point.exceedsGrowthThreshold && (
            <span className="text-[#34D399]">
              &ge;{thresholdPercent}% 7d Target
            </span>
          )}
          {point.isPeakDownloadDay && (
            <span className="text-[#F59E0B]">Peak Day</span>
          )}
        </div>
      </div>

      <div className="space-y-1.5 font-mono tabular-nums">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Active Subscribers</span>
          <div className="flex items-center gap-1.5">
            <span className="text-[#22D3EE] font-medium">
              {point.activeSubscribers.toLocaleString()}
            </span>
            <span
              className={`text-[11px] ${
                point.subscriberDelta > 0
                  ? 'text-[#34D399]'
                  : point.subscriberDelta < 0
                    ? 'text-[#F87171]'
                    : 'text-[#6E788A]'
              }`}
            >
              ({subDeltaText})
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Rolling 7d Growth</span>
          <span
            className={
              alertEnabled && point.exceedsGrowthThreshold
                ? 'text-[#34D399] font-medium'
                : point.rolling7dGrowthPct >= 0
                  ? 'text-[#E5E7EB]'
                  : 'text-[#F87171]'
            }
          >
            {growthText}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Daily Downloads</span>
          <span className="text-[#34D399] font-medium">
            {point.dailyDownloads.toLocaleString()}
          </span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[#A0AABB]">Window Cumulative</span>
          <span className="text-[#E5E7EB]">
            {point.cumulativeDownloads.toLocaleString()} DLs
          </span>
        </div>

        {(point.liveDownloadsOnDay > 0 || point.livePollsOnDay > 0) && (
          <div className="pt-1.5 border-t border-[#1E232D] flex items-center justify-between gap-2 text-[11px]">
            <span className="text-[#67E8F9]">Live Server Activity</span>
            <span className="text-[#F5F7FA]">
              {point.livePollsOnDay} XML · {point.liveDownloadsOnDay} WAV
            </span>
          </div>
        )}
      </div>

      {point.featuredEpisodeTitle && (
        <div className="pt-2 border-t border-[#1E232D]">
          <p className="font-mono text-[10px] text-[#6E788A]">
            Top Edition Drawn
          </p>
          <p className="mt-0.5 text-xs text-[#E5E7EB] truncate font-serif">
            {point.featuredEpisodeTitle}
          </p>
        </div>
      )}
    </div>
  );
}

export function FeedPerformanceDashboard({
  archive,
  rssFeedConfig,
  onRssFeedConfigChange,
  onOpenBriefing,
  onOpenRssModal,
}: FeedPerformanceDashboardProps) {
  const { user, isLoading: isAuthLoading, getIdToken } = useAuth();
  const [windowMode, setWindowMode] = useState<FeedPerformanceWindow>('30d');
  const [seriesFocus, setSeriesFocus] = useState<FeedSeriesFocus>('all');
  const [liveAnalytics, setLiveAnalytics] =
    useState<RssFeedAnalyticsSnapshot | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Settings Popover & Collapsible Subscriber Growth Alerts Drawer state
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [includeTestAlerts, setIncludeTestAlerts] = useState<boolean>(false);
  const [alertFilterTab, setAlertFilterTab] =
    useState<AlertDrawerFilterTab>('all');
  const [alertSearchQuery, setAlertSearchQuery] = useState<string>('');
  const [minGrowthFilterPct, setMinGrowthFilterPct] = useState<number>(0);
  const [alertSortField, setAlertSortField] =
    useState<AlertDrawerSortField>('triggeredAt');
  const [alertSortDirection, setAlertSortDirection] =
    useState<AlertDrawerSortDirection>('desc');
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null);
  const [focusedAlertId, setFocusedAlertId] = useState<string | null>(null);
  const [csvExportFlashCount, setCsvExportFlashCount] = useState<number | null>(
    null
  );
  const [firestoreAckRecords, setFirestoreAckRecords] = useState<
    Record<string, FirestoreAlertAcknowledgmentRecord>
  >({});
  const [pendingAckKeys, setPendingAckKeys] = useState<Record<string, boolean>>(
    {}
  );
  const [firestoreAckError, setFirestoreAckError] = useState<string | null>(
    null
  );
  const settingsContainerRef = useRef<HTMLDivElement | null>(null);
  const alertDrawerRef = useRef<HTMLDivElement | null>(null);
  const chartSectionRef = useRef<HTMLDivElement | null>(null);

  const [alertConfig, setAlertConfig] = useState<FeedGrowthAlertConfig>(() =>
    loadStoredGrowthAlertConfig(rssFeedConfig)
  );
  const [customThresholdInput, setCustomThresholdInput] = useState<string>(() =>
    String(loadStoredGrowthAlertConfig(rssFeedConfig).thresholdPercent)
  );
  const [storedHistoryState, setStoredHistoryState] =
    useState<StoredAlertHistoryState>(() => loadStoredAlertHistoryState());
  const [browserPermission, setBrowserPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() => readBrowserNotificationPermission());

  // 15-second auto-resetting Test Alert state & diagnostic report
  const [testRemainingSeconds, setTestRemainingSeconds] = useState<
    number | null
  >(null);
  const [testDiagnostics, setTestDiagnostics] =
    useState<TestAlertDiagnostics | null>(null);
  const lastDispatchedNotificationRef = useRef<string | null>(null);

  const isSimulatingSurge =
    testRemainingSeconds !== null && testRemainingSeconds > 0;
  const activeFeedTitle = rssFeedConfig?.title || 'Dispatch Private RSS';
  const canUseFirestoreAck = Boolean(
    !isAuthLoading && user && user.emailVerified
  );

  // Real-time Firestore listener for per-user alert acknowledgments
  useEffect(() => {
    if (!canUseFirestoreAck || !user?.uid) {
      setFirestoreAckRecords({});
      setFirestoreAckError(null);
      return;
    }
    setFirestoreAckError(null);
    const unsubscribe = subscribeToUserFeedAlertAcknowledgments(
      user.uid,
      (recordsByScopedKey) => {
        setFirestoreAckRecords(recordsByScopedKey);
        setFirestoreAckError(null);
      },
      () => {
        setFirestoreAckError(
          'Could not sync alert acknowledgments from Firestore; local state remains active.'
        );
      }
    );
    return () => unsubscribe();
  }, [canUseFirestoreAck, user?.uid]);

  useEffect(() => {
    const synced = loadStoredGrowthAlertConfig(rssFeedConfig);
    setAlertConfig(synced);
    setCustomThresholdInput(String(synced.thresholdPercent));
  }, [rssFeedConfig?.feedId]);

  // Close Settings popover on outside click or Escape key
  useEffect(() => {
    if (!isSettingsOpen) return;
    setBrowserPermission(readBrowserNotificationPermission());

    const handlePointerDown = (e: MouseEvent) => {
      if (
        settingsContainerRef.current &&
        !settingsContainerRef.current.contains(e.target as Node)
      ) {
        setIsSettingsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSettingsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSettingsOpen]);

  // 15-second countdown auto-reset timer for simulated growth spike
  useEffect(() => {
    if (testRemainingSeconds === null) return;
    if (testRemainingSeconds <= 0) {
      setTestRemainingSeconds(null);
      return;
    }
    const timerId = window.setTimeout(() => {
      setTestRemainingSeconds((prev) =>
        prev === null || prev <= 1 ? null : prev - 1
      );
    }, 1000);
    return () => window.clearTimeout(timerId);
  }, [testRemainingSeconds]);

  const persistAlertConfig = useCallback(
    (next: FeedGrowthAlertConfig) => {
      setAlertConfig(next);
      saveStoredGrowthAlertConfig(next);
      if (rssFeedConfig && onRssFeedConfigChange) {
        const updatedFeedConfig: LocalRssFeedConfig = {
          ...rssFeedConfig,
          growthAlert: next,
        };
        saveLocalRssFeedConfig(updatedFeedConfig);
        onRssFeedConfigChange(updatedFeedConfig);
      }
    },
    [rssFeedConfig, onRssFeedConfigChange]
  );

  const updateStoredHistoryState = useCallback(
    (updater: (prev: StoredAlertHistoryState) => StoredAlertHistoryState) => {
      setStoredHistoryState((prev) => {
        const next = updater(prev);
        saveStoredAlertHistoryState(next);
        return next;
      });
    },
    []
  );

  const loadAnalytics = useCallback(async () => {
    if (!rssFeedConfig?.feedId) {
      setLiveAnalytics(null);
      return;
    }
    setIsRefreshing(true);
    try {
      const token = await getIdToken().catch(() => null);
      const snapshot = await fetchPrivateRssAnalytics(rssFeedConfig.feedId, {
        token,
        manageToken: rssFeedConfig.manageToken,
      });
      setLiveAnalytics(snapshot);
    } catch {
      // Keep existing snapshot or deterministic baseline if feed hasn't been synced on server yet
    } finally {
      setIsRefreshing(false);
    }
  }, [rssFeedConfig?.feedId, rssFeedConfig?.manageToken, getIdToken]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics, rssFeedConfig?.lastSyncedAt]);

  const {
    chartData,
    currentSubscribers,
    subscriberNetChange,
    subscriberGrowthPct,
    sevenDayStartSubscribers,
    sevenDayNetNewSubscribers,
    sevenDayGrowthPct,
    organicSevenDayStartSubscribers,
    organicTrailing6dDownloads,
    peak90dRollingGrowthPct,
    organicCrossingEntries,
    targetSubscriberThresholdCount,
    subscriberAxisDomain,
    totalWindowDownloads,
    downloadsPerSubscriber,
    peakDayDownloads,
    peakDayLabel,
    topEpisodes,
    clientBreakdownRows,
  } = useMemo(() => {
    const daysCount = windowMode === '7d' ? 7 : windowMode === '30d' ? 30 : 90;
    const now = new Date();
    const liveDailyMap = new Map<
      string,
      { subscribers: number; downloads: number; rssPolls: number }
    >();

    if (liveAnalytics?.dailyBuckets) {
      for (const bucket of liveAnalytics.dailyBuckets) {
        liveDailyMap.set(bucket.date, {
          subscribers: bucket.subscribers,
          downloads: bucket.downloads,
          rssPolls: bucket.rssPolls,
        });
      }
    }

    const archiveByDate = new Map<string, AudioBriefing[]>();
    for (const item of archive) {
      const parsed = new Date(item.createdAt);
      const key = Number.isNaN(parsed.getTime())
        ? toUtcDateKey(now)
        : toUtcDateKey(parsed);
      const list = archiveByDate.get(key) || [];
      list.push(item);
      archiveByDate.set(key, list);
    }

    const baseEditionCount = Math.max(1, archive.length);
    const feedSeed = rssFeedConfig?.feedId || 'dispatch-default-feed';

    // Build 90-day organic series + optional 15s test spike overlay
    const masterDays = 90;
    let runningSubscribers = Math.max(12, baseEditionCount * 7);

    interface MasterDayPoint {
      dateKey: string;
      organicSubscribers: number;
      organicDownloads: number;
      activeSubscribers: number;
      dailyDownloads: number;
      liveDownloadsOnDay: number;
      livePollsOnDay: number;
      featuredEpisode: AudioBriefing | null;
      featuredEpisodeTitle: string | null;
    }

    const rawMasterSeries: MasterDayPoint[] = [];
    let capturedOrganic7dStart = runningSubscribers;

    for (let offset = masterDays - 1; offset >= 0; offset -= 1) {
      const d = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - offset
        )
      );
      const dateKey = toUtcDateKey(d);
      const dayHash = deterministicHash(
        `${feedSeed}:${dateKey}:${baseEditionCount}`
      );
      const dayOfWeek = d.getUTCDay();
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
      const editionsOnDay = archiveByDate.get(dateKey) || [];

      // Periodic syndication momentum waves + edition drops balanced by natural churn
      const isMomentumWaveDay =
        (offset >= 18 && offset <= 21) ||
        (offset >= 46 && offset <= 49) ||
        (offset >= 71 && offset <= 73);
      const waveGain = isMomentumWaveDay
        ? Math.max(1, Math.round(runningSubscribers * 0.036))
        : 0;
      const drift =
        (dayHash % 6 === 0 ? 1 : 0) +
        waveGain -
        (dayHash % 13 === 0 ? 1 : 0);
      const releaseBoost =
        editionsOnDay.length > 0 ? editionsOnDay.length * 2 : 0;
      runningSubscribers = Math.max(
        8,
        runningSubscribers + drift + releaseBoost
      );

      const liveBucket = liveDailyMap.get(dateKey);
      const organicSubs = runningSubscribers + (liveBucket?.subscribers || 0);

      if (offset === 6) {
        capturedOrganic7dStart = organicSubs;
      }

      const commuteFactor = isWeekday ? 0.62 : 0.38;
      const editionMultiplier = editionsOnDay.length > 0 ? 1.35 : 0.88;
      const jitter = ((dayHash >> 4) % 9) - 4;
      const liveDownloadsOnDay = liveBucket?.downloads || 0;
      const livePollsOnDay = liveBucket?.rssPolls || 0;

      const organicBaselineDownloads = Math.max(
        4,
        Math.round(
          organicSubs * commuteFactor * editionMultiplier * 0.55 + jitter
        )
      );
      const organicDownloads = organicBaselineDownloads + liveDownloadsOnDay;

      // Apply temporary 15-second Test Alert spike only to chart display series (not organic history)
      let effectiveSubscribers = organicSubs;
      let surgeDownloadBoost = 0;
      if (isSimulatingSurge && offset < 6) {
        const progressStep = (6 - offset) / 6;
        const baseAt7dStart =
          rawMasterSeries.length >= masterDays - 7
            ? rawMasterSeries[masterDays - 7]?.organicSubscribers || organicSubs
            : organicSubs;
        const requiredSurgeTotal = Math.max(
          4,
          Math.ceil(
            baseAt7dStart * ((alertConfig.thresholdPercent + 6.5) / 100)
          )
        );
        const addedSubs = Math.ceil(requiredSurgeTotal * progressStep);
        effectiveSubscribers += addedSubs;
        surgeDownloadBoost = Math.ceil(addedSubs * 1.6);
      }

      const dailyDownloads = organicDownloads + surgeDownloadBoost;
      const featuredEpisode =
        editionsOnDay[0] ||
        (archive.length > 0 ? archive[dayHash % archive.length] : null);

      rawMasterSeries.push({
        dateKey,
        organicSubscribers: organicSubs,
        organicDownloads,
        activeSubscribers: effectiveSubscribers,
        dailyDownloads,
        liveDownloadsOnDay,
        livePollsOnDay,
        featuredEpisode,
        featuredEpisodeTitle: featuredEpisode
          ? featuredEpisode.editionTitle
          : null,
      });
    }

    // Compute rolling 7-day growth for chart display series AND pure organic series
    let max90dOrganicGrowth = 0;
    const masterWithRolling7d = rawMasterSeries.map((item, idx) => {
      const anchorIdx = Math.max(0, idx - 6);
      const anchorSubs = rawMasterSeries[anchorIdx].activeSubscribers;
      const rollingPct =
        anchorSubs > 0
          ? Math.round(
              ((item.activeSubscribers - anchorSubs) / anchorSubs) * 1000
            ) / 10
          : 0;

      const orgAnchorSubs = rawMasterSeries[anchorIdx].organicSubscribers;
      const orgRollingPct =
        orgAnchorSubs > 0
          ? Math.round(
              ((item.organicSubscribers - orgAnchorSubs) / orgAnchorSubs) * 1000
            ) / 10
          : 0;
      if (idx >= 6 && orgRollingPct > max90dOrganicGrowth) {
        max90dOrganicGrowth = orgRollingPct;
      }

      return {
        ...item,
        rolling7dGrowthPct: rollingPct,
        exceedsGrowthThreshold: rollingPct >= alertConfig.thresholdPercent,
        organicAnchorDateKey: rawMasterSeries[anchorIdx].dateKey,
        organicAnchorSubs: orgAnchorSubs,
        organicRolling7dGrowthPct: orgRollingPct,
      };
    });

    // Detect onset-deduplicated organic 90-day threshold crossing waves
    const ackSet = new Set(storedHistoryState.acknowledgedDateKeys);
    const ackTimestamps = storedHistoryState.acknowledgedTimestamps || {};
    const feedAccessLabel = resolveFeedAccessLabel(rssFeedConfig);
    const organicChannelSummary = alertConfig.browserNotificationsEnabled
      ? 'Desktop Notification · Inline Banner · Chart Target'
      : 'Inline Banner · Chart Target';
    const detectedOrganicEntries: FeedAlertHistoryEntry[] = [];
    let waveStartIdx: number | null = null;
    let wavePeakIdx: number = -1;

    const finalizeOrganicWave = (peakIdx: number) => {
      const peakPoint = masterWithRolling7d[peakIdx];
      const windowStartIdx = Math.max(0, peakIdx - 6);
      let window7dDownloads = 0;
      for (let k = windowStartIdx; k <= peakIdx; k += 1) {
        window7dDownloads += masterWithRolling7d[k].organicDownloads;
      }

      const isLatestDay = peakIdx === masterWithRolling7d.length - 1;
      const ackKey = `${peakPoint.dateKey}:${alertConfig.thresholdPercent}`;
      const scopedFirestoreKey = makeScopedAlertLookupKey(
        rssFeedConfig?.feedId,
        ackKey
      );
      const firestoreRecord = canUseFirestoreAck
        ? firestoreAckRecords[scopedFirestoreKey]
        : undefined;

      let isAck = false;
      let acknowledgedAt: string | null = null;
      let ackSyncSource: 'firestore' | 'local' = canUseFirestoreAck
        ? 'firestore'
        : 'local';

      if (firestoreRecord) {
        isAck = firestoreRecord.acknowledged;
        acknowledgedAt = firestoreRecord.acknowledged
          ? firestoreRecord.acknowledgedAtIso || null
          : null;
        ackSyncSource = 'firestore';
      } else if (ackSet.has(ackKey) || ackSet.has(peakPoint.dateKey)) {
        isAck = true;
        acknowledgedAt =
          ackTimestamps[ackKey] || ackTimestamps[peakPoint.dateKey] || null;
        ackSyncSource = 'local';
      }

      let status: FeedAlertEventStatus = 'Historical';
      if (isAck) {
        status = 'Acknowledged';
      } else if (isLatestDay && alertConfig.enabled) {
        status = 'Active';
      }

      const variance =
        Math.round(
          (peakPoint.organicRolling7dGrowthPct - alertConfig.thresholdPercent) *
            10
        ) / 10;
      const targetAtTrigger = Math.max(
        peakPoint.organicAnchorSubs + 1,
        Math.ceil(
          peakPoint.organicAnchorSubs * (1 + alertConfig.thresholdPercent / 100)
        )
      );
      const velocityDlPerSub =
        peakPoint.organicSubscribers > 0
          ? Math.round(
              (window7dDownloads / peakPoint.organicSubscribers) * 10
            ) / 10
          : 0;

      detectedOrganicEntries.push({
        id: `org-${peakPoint.dateKey}-t${alertConfig.thresholdPercent}`,
        triggeredAt: `${peakPoint.dateKey}T09:00:00Z`,
        windowStartDate: peakPoint.organicAnchorDateKey,
        dateKey: peakPoint.dateKey,
        eventType: 'organic',
        feedTitle: activeFeedTitle,
        thresholdPercent: alertConfig.thresholdPercent,
        growthPct: peakPoint.organicRolling7dGrowthPct,
        varianceOverThresholdPct: variance,
        startSubscribers: peakPoint.organicAnchorSubs,
        endSubscribers: peakPoint.organicSubscribers,
        netNewSubscribers:
          peakPoint.organicSubscribers - peakPoint.organicAnchorSubs,
        targetSubscribers: targetAtTrigger,
        trailing7dDownloads: window7dDownloads,
        dailyDownloads: peakPoint.organicDownloads,
        downloadsPerSubscriber: velocityDlPerSub,
        topClientFamily: resolveTopClientForSeed(
          `${feedSeed}:${peakPoint.dateKey}`
        ),
        feedAccessLabel,
        deliveryChannelSummary: organicChannelSummary,
        acknowledged: isAck,
        acknowledgedAt,
        ackSyncSource,
        driverBriefingId: peakPoint.featuredEpisode?.id,
        driverEpisodeTitle:
          peakPoint.featuredEpisodeTitle || 'General Feed Syndication',
        status,
      });
    };

    for (let idx = 6; idx < masterWithRolling7d.length; idx += 1) {
      const pt = masterWithRolling7d[idx];
      if (pt.organicRolling7dGrowthPct >= alertConfig.thresholdPercent) {
        if (waveStartIdx === null) {
          waveStartIdx = idx;
          wavePeakIdx = idx;
        } else if (
          pt.organicRolling7dGrowthPct >=
          masterWithRolling7d[wavePeakIdx].organicRolling7dGrowthPct
        ) {
          wavePeakIdx = idx;
        }
      } else if (waveStartIdx !== null) {
        finalizeOrganicWave(wavePeakIdx);
        waveStartIdx = null;
        wavePeakIdx = -1;
      }
    }
    if (waveStartIdx !== null && wavePeakIdx >= 0) {
      finalizeOrganicWave(wavePeakIdx);
    }

    // Trailing 7-day evaluation for active banner & KPIs
    const trailingStartIdx = Math.max(0, masterWithRolling7d.length - 7);
    const trailingStartSubs =
      masterWithRolling7d[trailingStartIdx]?.activeSubscribers || 0;
    const trailingEndSubs =
      masterWithRolling7d[masterWithRolling7d.length - 1]?.activeSubscribers ||
      0;
    const trailingNetNew = trailingEndSubs - trailingStartSubs;
    const trailingGrowthPct =
      trailingStartSubs > 0
        ? Math.round((trailingNetNew / trailingStartSubs) * 1000) / 10
        : 0;
    const computedTargetSubs = Math.max(
      trailingStartSubs + 1,
      Math.ceil(trailingStartSubs * (1 + alertConfig.thresholdPercent / 100))
    );

    let trailing6dOrgDownloads = 0;
    for (
      let k = Math.max(0, masterWithRolling7d.length - 7);
      k < masterWithRolling7d.length;
      k += 1
    ) {
      trailing6dOrgDownloads += masterWithRolling7d[k].organicDownloads;
    }

    const sliced = masterWithRolling7d.slice(
      masterWithRolling7d.length - daysCount
    );
    let maxDownloads = 0;
    let maxDateKey = '';
    let minSubsInSlice = Number.POSITIVE_INFINITY;
    let maxSubsInSlice = 0;

    for (const item of sliced) {
      if (item.dailyDownloads > maxDownloads) {
        maxDownloads = item.dailyDownloads;
        maxDateKey = item.dateKey;
      }
      if (item.activeSubscribers < minSubsInSlice) {
        minSubsInSlice = item.activeSubscribers;
      }
      if (item.activeSubscribers > maxSubsInSlice) {
        maxSubsInSlice = item.activeSubscribers;
      }
    }

    if (!Number.isFinite(minSubsInSlice)) minSubsInSlice = 0;
    const yMin = Math.max(
      0,
      Math.min(minSubsInSlice, computedTargetSubs) - 3
    );
    const yMax = Math.max(maxSubsInSlice, computedTargetSubs) + 4;

    let cumulative = 0;
    const points: FeedPerformanceChartPoint[] = sliced.map((item, idx) => {
      cumulative += item.dailyDownloads;
      const prevSubs =
        idx > 0 ? sliced[idx - 1].activeSubscribers : item.activeSubscribers;
      return {
        dateKey: item.dateKey,
        shortLabel: formatAxisDateLabel(item.dateKey, windowMode),
        fullDateLabel: formatTooltipDateLabel(item.dateKey),
        activeSubscribers: item.activeSubscribers,
        subscriberDelta: item.activeSubscribers - prevSubs,
        rolling7dGrowthPct: item.rolling7dGrowthPct,
        exceedsGrowthThreshold: item.exceedsGrowthThreshold,
        dailyDownloads: item.dailyDownloads,
        cumulativeDownloads: cumulative,
        liveDownloadsOnDay: item.liveDownloadsOnDay,
        livePollsOnDay: item.livePollsOnDay,
        featuredEpisodeTitle: item.featuredEpisodeTitle,
        isPeakDownloadDay: item.dateKey === maxDateKey && maxDownloads > 0,
      };
    });

    const latestSubs =
      points.length > 0 ? points[points.length - 1].activeSubscribers : 0;
    const startSubs = points.length > 0 ? points[0].activeSubscribers : 0;
    const netChange = latestSubs - startSubs;
    const growthPct =
      startSubs > 0 ? Math.round((netChange / startSubs) * 1000) / 10 : 0;
    const dlPerSub =
      latestSubs > 0 ? Math.round((cumulative / latestSubs) * 10) / 10 : 0;

    // Build Top Downloaded Episodes leaderboard
    const episodeRowsRaw = archive.map((briefing, idx) => {
      const epHash = deterministicHash(`${feedSeed}:ep:${briefing.id}`);
      const recencyBonus = Math.max(0, (archive.length - idx) * 9);
      const chapterBonus = briefing.segments.length * 11;
      const surgeBonus = isSimulatingSurge && idx === 0 ? 24 : 0;
      const baselineEpDownloads =
        28 + (epHash % 45) + recencyBonus + chapterBonus + surgeBonus;
      const liveEpDownloads =
        liveAnalytics?.episodeDownloads?.[briefing.id] || 0;
      const totalEpDownloads = baselineEpDownloads + liveEpDownloads;
      const durationSeconds = briefing.segments.reduce(
        (sum, s) => sum + (s.audioDurationSeconds || s.estimatedSeconds || 60),
        0
      );
      const formatLabel =
        briefing.preferences.format === 'podcast'
          ? briefing.preferences.dynamicPanel
            ? 'Newsroom Panel'
            : 'Two-Host Podcast'
          : 'Solo Anchor';

      return {
        briefing,
        totalDownloads: totalEpDownloads,
        liveDownloads: liveEpDownloads,
        durationSeconds,
        formatLabel,
      };
    });

    episodeRowsRaw.sort((a, b) => b.totalDownloads - a.totalDownloads);
    const topSlice = episodeRowsRaw.slice(0, 4);
    const maxEpDownloads = Math.max(
      1,
      topSlice.reduce((max, r) => Math.max(max, r.totalDownloads), 1)
    );
    const computedTopEpisodes: TopEpisodePerformanceRow[] = topSlice.map(
      (r) => ({
        ...r,
        sharePercent: Math.round((r.totalDownloads / maxEpDownloads) * 100),
      })
    );

    const baseTotal = Math.max(20, cumulative);
    const appleCount =
      Math.round(baseTotal * 0.44) +
      (liveAnalytics?.clientBreakdown?.['Apple Podcasts'] || 0);
    const overcastCount =
      Math.round(baseTotal * 0.26) +
      (liveAnalytics?.clientBreakdown?.Overcast || 0);
    const pocketCastsCount =
      Math.round(baseTotal * 0.19) +
      (liveAnalytics?.clientBreakdown?.['Pocket Casts'] || 0);
    const directCount =
      Math.max(1, baseTotal - Math.round(baseTotal * 0.89)) +
      (liveAnalytics?.clientBreakdown?.['Direct & Web RSS'] || 0);

    const clientSum = Math.max(
      1,
      appleCount + overcastCount + pocketCastsCount + directCount
    );

    const computedClients: ClientAppBreakdownRow[] = [
      {
        family: 'Apple Podcasts',
        count: appleCount,
        sharePercent: Math.round((appleCount / clientSum) * 100),
        accentHex: '#22D3EE',
        barClass: 'bg-[#22D3EE]',
      },
      {
        family: 'Overcast',
        count: overcastCount,
        sharePercent: Math.round((overcastCount / clientSum) * 100),
        accentHex: '#34D399',
        barClass: 'bg-[#34D399]',
      },
      {
        family: 'Pocket Casts',
        count: pocketCastsCount,
        sharePercent: Math.round((pocketCastsCount / clientSum) * 100),
        accentHex: '#F59E0B',
        barClass: 'bg-[#F59E0B]',
      },
      {
        family: 'Direct & Web RSS',
        count: directCount,
        sharePercent: Math.max(
          1,
          100 -
            Math.round((appleCount / clientSum) * 100) -
            Math.round((overcastCount / clientSum) * 100) -
            Math.round((pocketCastsCount / clientSum) * 100)
        ),
        accentHex: '#A78BFA',
        barClass: 'bg-[#A78BFA]',
      },
    ];

    return {
      chartData: points,
      currentSubscribers: latestSubs,
      subscriberNetChange: netChange,
      subscriberGrowthPct: growthPct,
      sevenDayStartSubscribers: trailingStartSubs,
      sevenDayNetNewSubscribers: trailingNetNew,
      sevenDayGrowthPct: trailingGrowthPct,
      organicSevenDayStartSubscribers: capturedOrganic7dStart,
      organicTrailing6dDownloads: trailing6dOrgDownloads,
      peak90dRollingGrowthPct: max90dOrganicGrowth,
      organicCrossingEntries: detectedOrganicEntries,
      targetSubscriberThresholdCount: computedTargetSubs,
      subscriberAxisDomain: [yMin, yMax] as [number, number],
      totalWindowDownloads: cumulative,
      downloadsPerSubscriber: dlPerSub,
      peakDayDownloads: maxDownloads,
      peakDayLabel: maxDateKey ? formatAxisDateLabel(maxDateKey, '30d') : '—',
      topEpisodes: computedTopEpisodes,
      clientBreakdownRows: computedClients,
    };
  }, [
    archive,
    rssFeedConfig,
    activeFeedTitle,
    windowMode,
    liveAnalytics,
    alertConfig.thresholdPercent,
    alertConfig.enabled,
    alertConfig.browserNotificationsEnabled,
    storedHistoryState.acknowledgedDateKeys,
    storedHistoryState.acknowledgedTimestamps,
    canUseFirestoreAck,
    firestoreAckRecords,
    isSimulatingSurge,
  ]);

  const hydratedTestEntries = useMemo(() => {
    const localAckSet = new Set(storedHistoryState.acknowledgedDateKeys);
    const localAckTimestamps = storedHistoryState.acknowledgedTimestamps || {};

    return storedHistoryState.testEntries.map((rawEntry) => {
      const ackKey = getCanonicalAlertKey(rawEntry);
      const scopedKey = makeScopedAlertLookupKey(rssFeedConfig?.feedId, ackKey);
      const fsRecord = canUseFirestoreAck
        ? firestoreAckRecords[scopedKey]
        : undefined;

      let isAck = Boolean(rawEntry.acknowledged);
      let acknowledgedAt: string | null = rawEntry.acknowledgedAt ?? null;
      let ackSyncSource: 'firestore' | 'local' = canUseFirestoreAck
        ? 'firestore'
        : 'local';

      if (fsRecord) {
        isAck = fsRecord.acknowledged;
        acknowledgedAt = fsRecord.acknowledged
          ? fsRecord.acknowledgedAtIso || null
          : null;
        ackSyncSource = 'firestore';
      } else if (localAckSet.has(ackKey)) {
        isAck = true;
        acknowledgedAt = localAckTimestamps[ackKey] || acknowledgedAt || null;
        ackSyncSource = 'local';
      }

      const resolvedStatus: FeedAlertEventStatus = isAck
        ? 'Acknowledged'
        : 'Test Verified';

      return {
        ...rawEntry,
        acknowledged: isAck,
        acknowledgedAt: isAck ? acknowledgedAt : null,
        ackSyncSource,
        status: resolvedStatus,
      };
    });
  }, [
    storedHistoryState.testEntries,
    storedHistoryState.acknowledgedDateKeys,
    storedHistoryState.acknowledgedTimestamps,
    rssFeedConfig?.feedId,
    canUseFirestoreAck,
    firestoreAckRecords,
  ]);

  // Combine organic 90d crossings with optional simulated test alert runs
  const baseAlertHistory = useMemo(() => {
    const combined: FeedAlertHistoryEntry[] = [...organicCrossingEntries];
    if (
      (includeTestAlerts || alertFilterTab === 'test') &&
      hydratedTestEntries.length > 0
    ) {
      combined.push(...hydratedTestEntries);
    }
    combined.sort(
      (a, b) =>
        new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime()
    );
    return combined;
  }, [
    organicCrossingEntries,
    includeTestAlerts,
    alertFilterTab,
    hydratedTestEntries,
  ]);

  const alertTabCounts = useMemo(() => {
    let pending = 0;
    let acknowledged = 0;
    let active = 0;
    let historical = 0;

    for (const entry of baseAlertHistory) {
      const isAck = Boolean(entry.acknowledged);
      if (isAck) acknowledged += 1;
      else pending += 1;
    }

    for (const entry of organicCrossingEntries) {
      if (entry.status === 'Active') active += 1;
      else if (entry.status === 'Historical') historical += 1;
    }

    const test = hydratedTestEntries.length;
    const all = baseAlertHistory.length;
    return { all, pending, acknowledged, active, historical, test };
  }, [baseAlertHistory, organicCrossingEntries, hydratedTestEntries.length]);

  const pendingAlertCount = alertTabCounts.pending;
  const hasPendingAlerts = pendingAlertCount > 0;

  // Current maximum 7-day subscriber growth percentage bound for the range slider
  const currentMax7dGrowthPct = useMemo(() => {
    let maxPct = Math.max(peak90dRollingGrowthPct, sevenDayGrowthPct);
    for (const pt of chartData) {
      if (pt.rolling7dGrowthPct > maxPct) {
        maxPct = pt.rolling7dGrowthPct;
      }
    }
    for (const entry of baseAlertHistory) {
      if (entry.growthPct > maxPct) {
        maxPct = entry.growthPct;
      }
    }
    return Math.max(0, maxPct);
  }, [peak90dRollingGrowthPct, sevenDayGrowthPct, chartData, baseAlertHistory]);

  const maxSliderGrowthPct = useMemo(() => {
    const roundedHalfStep = Math.ceil(currentMax7dGrowthPct * 2) / 2;
    return Math.max(0.5, roundedHalfStep);
  }, [currentMax7dGrowthPct]);

  const effectiveMinGrowthPct = Math.min(
    minGrowthFilterPct,
    maxSliderGrowthPct
  );

  // Filter by acknowledgment/status/type, minimum 7d growth percentage slider, search query, and sort column
  const visibleAlertHistory = useMemo(() => {
    const query = alertSearchQuery.trim().toLowerCase();
    const filtered = baseAlertHistory.filter((entry) => {
      const isAck = Boolean(entry.acknowledged);
      if (alertFilterTab === 'Pending') {
        if (isAck) return false;
      } else if (alertFilterTab === 'Acknowledged') {
        if (!isAck) return false;
      } else if (alertFilterTab === 'test') {
        if (entry.eventType !== 'test') return false;
      } else if (alertFilterTab !== 'all') {
        if (entry.eventType !== 'organic' || entry.status !== alertFilterTab) {
          return false;
        }
      }

      if (effectiveMinGrowthPct > 0 && entry.growthPct < effectiveMinGrowthPct) {
        return false;
      }

      if (!query) return true;
      const formattedStamp = formatHistoryTimestamp(
        entry.triggeredAt,
        entry.eventType
      ).toLowerCase();
      const topClient = (
        entry.topClientFamily || resolveTopClientForSeed(entry.id)
      ).toLowerCase();
      const accessMode = (entry.feedAccessLabel || '').toLowerCase();
      const channels = (entry.deliveryChannelSummary || '').toLowerCase();
      const ackLabel = isAck ? 'acknowledged' : 'pending';
      const syncLabel =
        entry.ackSyncSource === 'firestore' ? 'firestore' : 'local';

      return (
        entry.driverEpisodeTitle.toLowerCase().includes(query) ||
        entry.feedTitle.toLowerCase().includes(query) ||
        entry.id.toLowerCase().includes(query) ||
        entry.dateKey.toLowerCase().includes(query) ||
        entry.windowStartDate.toLowerCase().includes(query) ||
        formattedStamp.includes(query) ||
        entry.status.toLowerCase().includes(query) ||
        ackLabel.includes(query) ||
        syncLabel.includes(query) ||
        entry.eventType.toLowerCase().includes(query) ||
        topClient.includes(query) ||
        accessMode.includes(query) ||
        channels.includes(query)
      );
    });

    const dirMultiplier = alertSortDirection === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      let cmp = 0;
      switch (alertSortField) {
        case 'triggeredAt':
          cmp =
            new Date(a.triggeredAt).getTime() -
            new Date(b.triggeredAt).getTime();
          break;
        case 'growthPct':
          cmp = a.growthPct - b.growthPct;
          break;
        case 'netNewSubscribers':
          cmp = a.netNewSubscribers - b.netNewSubscribers;
          break;
        case 'trailing7dDownloads':
          cmp = a.trailing7dDownloads - b.trailing7dDownloads;
          break;
        case 'status':
          cmp = getAlertStatusSortRank(a) - getAlertStatusSortRank(b);
          break;
      }
      if (cmp !== 0) return cmp * dirMultiplier;
      return (
        new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime()
      );
    });

    return filtered;
  }, [
    baseAlertHistory,
    alertFilterTab,
    effectiveMinGrowthPct,
    alertSearchQuery,
    alertSortField,
    alertSortDirection,
  ]);

  const focusedAlertEntry = useMemo(() => {
    if (!focusedAlertId) return null;
    return (
      baseAlertHistory.find((e) => e.id === focusedAlertId) ||
      organicCrossingEntries.find((e) => e.id === focusedAlertId) ||
      hydratedTestEntries.find((e) => e.id === focusedAlertId) ||
      null
    );
  }, [
    focusedAlertId,
    baseAlertHistory,
    organicCrossingEntries,
    hydratedTestEntries,
  ]);

  const focusedChartPoint = useMemo(() => {
    if (!focusedAlertEntry) return null;
    return (
      chartData.find((pt) => pt.dateKey === focusedAlertEntry.dateKey) || null
    );
  }, [focusedAlertEntry, chartData]);

  const archiveByIdMap = useMemo(() => {
    const map = new Map<string, AudioBriefing>();
    for (const b of archive) {
      map.set(b.id, b);
    }
    return map;
  }, [archive]);

  const effectiveAlertActive = alertConfig.enabled || isSimulatingSurge;
  const currentAlertSignature = `${alertConfig.thresholdPercent}:${currentSubscribers}:live`;
  const isThresholdExceeded =
    effectiveAlertActive && sevenDayGrowthPct >= alertConfig.thresholdPercent;
  const todayUtcKey = toUtcDateKey(new Date());
  const isTodayOrganicAcknowledged = Boolean(
    organicCrossingEntries.find((e) => e.dateKey === todayUtcKey)?.acknowledged
  );
  const isAlertAcknowledged =
    !isSimulatingSurge &&
    (alertConfig.acknowledgedSignature === currentAlertSignature ||
      isTodayOrganicAcknowledged);
  const shouldShowAlertBanner = isThresholdExceeded && !isAlertAcknowledged;
  const thresholdExcessPct =
    Math.round((sevenDayGrowthPct - alertConfig.thresholdPercent) * 10) / 10;
  const topDriverEpisode = topEpisodes[0]?.briefing || null;

  // Dispatch Web Notification API alert for organic threshold crossings when enabled
  useEffect(() => {
    if (
      isSimulatingSurge ||
      !shouldShowAlertBanner ||
      !alertConfig.browserNotificationsEnabled
    ) {
      return;
    }
    if (lastDispatchedNotificationRef.current === currentAlertSignature) {
      return;
    }
    lastDispatchedNotificationRef.current = currentAlertSignature;

    if (
      typeof window !== 'undefined' &&
      'Notification' in window &&
      Notification.permission === 'granted'
    ) {
      try {
        new Notification(`${activeFeedTitle}: +${sevenDayGrowthPct}% 7d Growth`, {
          body: `Active subscribers rose by +${sevenDayNetNewSubscribers} (${sevenDayStartSubscribers} -> ${currentSubscribers}), exceeding your ${alertConfig.thresholdPercent}% 7-day alert threshold.`,
        });
      } catch {
        // Sandboxed preview fallback handled gracefully by inline banner
      }
    }
  }, [
    isSimulatingSurge,
    shouldShowAlertBanner,
    alertConfig.browserNotificationsEnabled,
    alertConfig.thresholdPercent,
    currentAlertSignature,
    activeFeedTitle,
    sevenDayGrowthPct,
    sevenDayNetNewSubscribers,
    sevenDayStartSubscribers,
    currentSubscribers,
  ]);

  const handleSelectPresetThreshold = (preset: number) => {
    setCustomThresholdInput(String(preset));
    persistAlertConfig({
      ...alertConfig,
      enabled: true,
      thresholdPercent: preset,
      acknowledgedSignature: null,
    });
  };

  const handleApplyCustomThreshold = (): number => {
    const parsed = Number(customThresholdInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setCustomThresholdInput(String(alertConfig.thresholdPercent));
      return alertConfig.thresholdPercent;
    }
    const clamped = Math.round(Math.min(200, Math.max(1, parsed)) * 10) / 10;
    setCustomThresholdInput(String(clamped));
    persistAlertConfig({
      ...alertConfig,
      enabled: true,
      thresholdPercent: clamped,
      acknowledgedSignature: null,
    });
    return clamped;
  };

  const handleToggleAlertEnabled = () => {
    persistAlertConfig({
      ...alertConfig,
      enabled: !alertConfig.enabled,
      acknowledgedSignature: null,
    });
  };

  const handleToggleBrowserNotifications = async () => {
    if (alertConfig.browserNotificationsEnabled) {
      persistAlertConfig({
        ...alertConfig,
        browserNotificationsEnabled: false,
      });
      return;
    }

    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserPermission('unsupported');
      return;
    }

    try {
      const permission =
        Notification.permission === 'granted'
          ? 'granted'
          : await Notification.requestPermission();
      setBrowserPermission(permission);
      if (permission === 'granted') {
        lastDispatchedNotificationRef.current = null;
        persistAlertConfig({
          ...alertConfig,
          enabled: true,
          browserNotificationsEnabled: true,
        });
      }
    } catch {
      setBrowserPermission(readBrowserNotificationPermission());
    }
  };

  const handleRunTestAlert = async () => {
    const parsedCustom = Number(customThresholdInput);
    const activeThreshold =
      Number.isFinite(parsedCustom) && parsedCustom > 0
        ? Math.round(Math.min(200, Math.max(1, parsedCustom)) * 10) / 10
        : alertConfig.thresholdPercent;

    if (activeThreshold !== alertConfig.thresholdPercent) {
      setCustomThresholdInput(String(activeThreshold));
      persistAlertConfig({
        ...alertConfig,
        thresholdPercent: activeThreshold,
        acknowledgedSignature: null,
      });
    }

    const baseStart = Math.max(8, organicSevenDayStartSubscribers);
    const simAddedSubs = Math.max(
      4,
      Math.ceil(baseStart * ((activeThreshold + 6.5) / 100))
    );
    const simEndSubs = baseStart + simAddedSubs;
    const simGrowthPct =
      Math.round(((simEndSubs - baseStart) / baseStart) * 1000) / 10;
    const simTargetSubs = Math.max(
      baseStart + 1,
      Math.ceil(baseStart * (1 + activeThreshold / 100))
    );

    setTestRemainingSeconds(TEST_ALERT_DURATION_SECONDS);

    let outcome: BrowserPermissionOutcome = 'unsupported';
    if (typeof window !== 'undefined' && 'Notification' in window) {
      try {
        let perm: NotificationPermission = Notification.permission;
        if (perm === 'default') {
          perm = await Notification.requestPermission();
        }
        setBrowserPermission(perm);

        if (perm === 'granted') {
          new Notification(
            `[TEST] ${activeFeedTitle}: +${simGrowthPct.toFixed(1)}% 7d Spike`,
            {
              body: `Simulated +${simAddedSubs} new subscribers (${baseStart} -> ${simEndSubs}) to verify your +${activeThreshold}% 7-day alert rule.`,
            }
          );
          outcome = 'granted-sent';
          if (!alertConfig.browserNotificationsEnabled) {
            persistAlertConfig({
              ...alertConfig,
              thresholdPercent: activeThreshold,
              browserNotificationsEnabled: true,
            });
          }
        } else {
          outcome = 'denied';
        }
      } catch {
        setBrowserPermission(readBrowserNotificationPermission());
        outcome = 'sandbox-restricted';
      }
    } else {
      setBrowserPermission('unsupported');
      outcome = 'unsupported';
    }

    const now = new Date();
    const testedAtLabel = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(now);

    setTestDiagnostics({
      testedAtLabel,
      thresholdTested: activeThreshold,
      simulatedGrowthPct: simGrowthPct,
      simulatedNetNewSubs: simAddedSubs,
      targetSubscribers: simTargetSubs,
      bannerVerified: true,
      browserOutcome: outcome,
    });

    // Record simulated test alert run into persisted Alert History ledger
    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)
    );
    const simDayDownloads = Math.ceil(simAddedSubs * 1.6) + 18;
    const simTrailing7dDownloads = organicTrailing6dDownloads + simDayDownloads;
    const simDlPerSub =
      simEndSubs > 0
        ? Math.round((simTrailing7dDownloads / simEndSubs) * 10) / 10
        : 0;
    const testChannelSummary =
      outcome === 'granted-sent'
        ? 'Desktop Test Sent · Inline Banner · Chart Target'
        : 'Inline Banner · Chart Target (Browser Restricted)';
    const newTestEntry: FeedAlertHistoryEntry = {
      id: `test-${now.getTime()}`,
      triggeredAt: now.toISOString(),
      windowStartDate: toUtcDateKey(windowStart),
      dateKey: toUtcDateKey(now),
      eventType: 'test',
      feedTitle: activeFeedTitle,
      thresholdPercent: activeThreshold,
      growthPct: simGrowthPct,
      varianceOverThresholdPct:
        Math.round((simGrowthPct - activeThreshold) * 10) / 10,
      startSubscribers: baseStart,
      endSubscribers: simEndSubs,
      netNewSubscribers: simAddedSubs,
      targetSubscribers: simTargetSubs,
      trailing7dDownloads: simTrailing7dDownloads,
      dailyDownloads: simDayDownloads,
      downloadsPerSubscriber: simDlPerSub,
      topClientFamily:
        clientBreakdownRows[0]?.family || 'Apple Podcasts',
      feedAccessLabel: resolveFeedAccessLabel(rssFeedConfig),
      deliveryChannelSummary: testChannelSummary,
      acknowledged: false,
      acknowledgedAt: null,
      ackSyncSource: canUseFirestoreAck ? 'firestore' : 'local',
      driverBriefingId: topDriverEpisode?.id,
      driverEpisodeTitle:
        topDriverEpisode?.editionTitle || 'Simulated Growth Test Edition',
      status: 'Test Verified',
    };

    updateStoredHistoryState((prev) => ({
      ...prev,
      testEntries: [newTestEntry, ...prev.testEntries].slice(
        0,
        MAX_STORED_TEST_LOGS
      ),
    }));
  };

  const handleEndTestAlert = () => {
    setTestRemainingSeconds(null);
  };

  const persistAlertAckState = async (params: {
    alertKey: string;
    legacyDateKey?: string;
    eventType: 'organic' | 'test';
    nextAcknowledged: boolean;
  }) => {
    const { alertKey, legacyDateKey, eventType, nextAcknowledged } = params;
    const nowIso = nextAcknowledged ? new Date().toISOString() : '';

    // 1. Optimistic local storage update (supports signed-out fallback & fast UI)
    updateStoredHistoryState((prev) => {
      const nextTimestamps = { ...(prev.acknowledgedTimestamps || {}) };
      let nextAckKeys = prev.acknowledgedDateKeys.filter(
        (k) => k !== alertKey && (legacyDateKey ? k !== legacyDateKey : true)
      );

      if (nextAcknowledged) {
        nextAckKeys = [...nextAckKeys, alertKey];
        nextTimestamps[alertKey] = nowIso;
      } else {
        delete nextTimestamps[alertKey];
        if (legacyDateKey) {
          delete nextTimestamps[legacyDateKey];
        }
      }

      const nextTestEntries =
        eventType === 'test'
          ? prev.testEntries.map((item) =>
              item.id === alertKey
                ? {
                    ...item,
                    acknowledged: nextAcknowledged,
                    acknowledgedAt: nextAcknowledged ? nowIso : null,
                    status: (nextAcknowledged
                      ? 'Acknowledged'
                      : 'Test Verified') as FeedAlertEventStatus,
                  }
                : item
            )
          : prev.testEntries;

      return {
        ...prev,
        testEntries: nextTestEntries,
        acknowledgedDateKeys: nextAckKeys,
        acknowledgedTimestamps: nextTimestamps,
      };
    });

    // 2. Persist to Firestore when signed in with a verified Google account
    if (canUseFirestoreAck && user?.uid) {
      const scopedKey = makeScopedAlertLookupKey(
        rssFeedConfig?.feedId,
        alertKey
      );
      const existingRecord = firestoreAckRecords[scopedKey];
      setPendingAckKeys((prev) => ({ ...prev, [alertKey]: true }));
      setFirestoreAckError(null);

      try {
        const saved = await upsertFeedAlertAcknowledgment({
          ownerId: user.uid,
          feedId: rssFeedConfig?.feedId,
          alertKey,
          eventType,
          acknowledged: nextAcknowledged,
          acknowledgedAtIso: nowIso,
          knownExists: existingRecord ? true : undefined,
        });
        setFirestoreAckRecords((prev) => ({
          ...prev,
          [scopedKey]: saved,
        }));
      } catch {
        setFirestoreAckError(
          'Could not save acknowledgment change to Firestore. Please check your session and try again.'
        );
      } finally {
        setPendingAckKeys((prev) => {
          const next = { ...prev };
          delete next[alertKey];
          return next;
        });
      }
    }
  };

  const handleAcknowledgeAlert = () => {
    if (isSimulatingSurge) {
      setTestRemainingSeconds(null);
      return;
    }
    const todayKey = toUtcDateKey(new Date());
    const ackKey = `${todayKey}:${alertConfig.thresholdPercent}`;
    persistAlertConfig({
      ...alertConfig,
      acknowledgedSignature: currentAlertSignature,
    });
    void persistAlertAckState({
      alertKey: ackKey,
      legacyDateKey: todayKey,
      eventType: 'organic',
      nextAcknowledged: true,
    });
  };

  const handleReopenAlert = () => {
    const todayKey = toUtcDateKey(new Date());
    const ackKey = `${todayKey}:${alertConfig.thresholdPercent}`;
    persistAlertConfig({
      ...alertConfig,
      acknowledgedSignature: null,
    });
    void persistAlertAckState({
      alertKey: ackKey,
      legacyDateKey: todayKey,
      eventType: 'organic',
      nextAcknowledged: false,
    });
  };

  const handleToggleRowAcknowledge = (entry: FeedAlertHistoryEntry) => {
    const alertKey = getCanonicalAlertKey(entry);
    const todayKey = toUtcDateKey(new Date());
    const isCurrentlyAck = Boolean(entry.acknowledged);
    const nextAcknowledged = !isCurrentlyAck;

    if (entry.eventType === 'organic' && entry.dateKey === todayKey) {
      persistAlertConfig({
        ...alertConfig,
        acknowledgedSignature: nextAcknowledged ? currentAlertSignature : null,
      });
    }

    void persistAlertAckState({
      alertKey,
      legacyDateKey: entry.eventType === 'organic' ? entry.dateKey : undefined,
      eventType: entry.eventType,
      nextAcknowledged,
    });
  };

  const handleFocusAlertOnChart = (entry: FeedAlertHistoryEntry) => {
    if (focusedAlertId === entry.id) {
      setFocusedAlertId(null);
      return;
    }
    setFocusedAlertId(entry.id);
    if (seriesFocus === 'downloads') {
      setSeriesFocus('all');
    }

    const nowUtcStart = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate()
    );
    const entryUtcMs = Date.parse(`${entry.dateKey}T00:00:00Z`);
    if (!Number.isNaN(entryUtcMs)) {
      const daysElapsed = Math.floor((nowUtcStart - entryUtcMs) / 86_400_000);
      if (daysElapsed >= 30 && windowMode !== '90d') {
        setWindowMode('90d');
      } else if (daysElapsed >= 7 && windowMode === '7d') {
        setWindowMode('30d');
      }
    }

    window.requestAnimationFrame(() => {
      chartSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    });
  };

  const handleToggleDrawerFromHeader = () => {
    setIsHistoryOpen((prev) => {
      const next = !prev;
      if (next) {
        window.setTimeout(() => {
          alertDrawerRef.current?.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        }, 80);
      }
      return next;
    });
  };

  const handleSortColumn = (field: AlertDrawerSortField) => {
    if (alertSortField === field) {
      setAlertSortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'));
    } else {
      setAlertSortField(field);
      setAlertSortDirection('desc');
    }
  };

  const handleSelectAlertFilterTab = (tab: AlertDrawerFilterTab) => {
    setAlertFilterTab(tab);
    if (tab === 'test' && !includeTestAlerts) {
      setIncludeTestAlerts(true);
    }
  };

  const handleResetAlertFilters = () => {
    setAlertFilterTab('all');
    setAlertSearchQuery('');
    setMinGrowthFilterPct(0);
    setAlertSortField('triggeredAt');
    setAlertSortDirection('desc');
  };

  const handleExportAlertHistoryCsv = () => {
    if (visibleAlertHistory.length === 0) return;
    const csvContent = buildAlertHistoryCsvContent(visibleAlertHistory);
    const todayStamp = toUtcDateKey(new Date());
    let filterSlug = 'organic';
    if (alertFilterTab === 'test') {
      filterSlug = 'test-runs';
    } else if (alertFilterTab === 'Pending') {
      filterSlug = 'pending';
    } else if (alertFilterTab === 'Acknowledged') {
      filterSlug = 'acknowledged';
    } else if (alertFilterTab === 'Active') {
      filterSlug = 'active';
    } else if (alertFilterTab === 'Historical') {
      filterSlug = 'historical';
    } else if (includeTestAlerts) {
      filterSlug = 'all-events';
    }
    const minGrowthSuffix =
      effectiveMinGrowthPct > 0
        ? `-min-${effectiveMinGrowthPct.toFixed(1).replace('.', '_')}pct`
        : '';
    const searchSuffix = alertSearchQuery.trim().length > 0 ? '-filtered' : '';
    const filename = `dispatch-alert-history-${filterSlug}${minGrowthSuffix}${searchSuffix}-${todayStamp}.csv`;
    triggerCsvDownload(csvContent, filename);
    setCsvExportFlashCount(visibleAlertHistory.length);
    window.setTimeout(() => {
      setCsvExportFlashCount(null);
    }, 2400);
  };

  const handleClearTestHistory = () => {
    updateStoredHistoryState((prev) => ({
      ...prev,
      testEntries: [],
    }));
    if (alertFilterTab === 'test') {
      setAlertFilterTab('all');
    }
  };

  const showSubscribers =
    seriesFocus === 'all' || seriesFocus === 'subscribers';
  const showDownloads = seriesFocus === 'all' || seriesFocus === 'downloads';
  const customMatchesPreset = PRESET_THRESHOLDS.some(
    (p) => p === alertConfig.thresholdPercent
  );
  const diagnosticSummary = testDiagnostics
    ? formatBrowserOutcomeSummary(testDiagnostics.browserOutcome)
    : null;

  return (
    <section
      aria-label="Private RSS Feed Performance Analytics"
      className="mt-6 bg-[#13161C] border border-[#22D3EE]/30 rounded-lg"
    >
      {/* Top Header & Toolbar with Alert History & Settings Menu Popover */}
      <div className="px-5 py-4 border-b border-[#1E232D] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8B95A7]">
            <span className="font-mono text-[#22D3EE]">Feed Performance</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {rssFeedConfig
                ? `Active Feed: ${rssFeedConfig.title}`
                : 'Archive Syndication Preview'}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={`font-mono tabular-nums ${
                isThresholdExceeded ? 'text-[#34D399]' : 'text-[#A0AABB]'
              }`}
            >
              7d Growth:{' '}
              {sevenDayGrowthPct >= 0
                ? `+${sevenDayGrowthPct.toFixed(1)}%`
                : `${sevenDayGrowthPct.toFixed(1)}%`}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-[#6E788A] tabular-nums">
              {isSimulatingSurge
                ? `Test Spike (${testRemainingSeconds}s)`
                : alertConfig.enabled
                  ? `Alert >= +${alertConfig.thresholdPercent}%`
                  : 'Alert Paused'}
            </span>
            {!isSimulatingSurge &&
              isThresholdExceeded &&
              isAlertAcknowledged && (
                <>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={handleReopenAlert}
                    className="font-mono text-[#34D399] hover:text-[#6EE7B7] underline underline-offset-2 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Re-open Alert
                  </button>
                </>
              )}
            {liveAnalytics &&
              (liveAnalytics.totalLivePolls > 0 ||
                liveAnalytics.totalLiveDownloads > 0) && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-[#34D399] tabular-nums">
                    {liveAnalytics.totalLivePolls} live XML /{' '}
                    {liveAnalytics.totalLiveDownloads} live WAV
                  </span>
                </>
              )}
          </div>
          <h2 className="mt-1 font-serif text-xl font-medium text-[#F5F7FA]">
            Active Subscribers &amp; Episode Downloads Over Time
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Series Focus Segmented Control */}
          <div
            className="inline-flex items-center p-0.5 bg-[#0B0D10] border border-[#262B36] rounded-md"
            role="group"
            aria-label="Filter chart metric series"
          >
            {(
              [
                { id: 'all', label: 'Dual Axis' },
                { id: 'subscribers', label: 'Subscribers' },
                { id: 'downloads', label: 'Downloads' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSeriesFocus(opt.id)}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  seriesFocus === opt.id
                    ? 'bg-[#171C24] text-[#67E8F9] border border-[#22D3EE]/40'
                    : 'text-[#8B95A7] hover:text-[#F5F7FA]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* 7d / 30d / 90d Window Toggle */}
          <div
            className="inline-flex items-center p-0.5 bg-[#0B0D10] border border-[#262B36] rounded-md"
            role="group"
            aria-label="Select feed performance time window"
          >
            {(['7d', '30d', '90d'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setWindowMode(mode)}
                className={`h-7 px-2.5 font-mono text-xs rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  windowMode === mode
                    ? 'bg-[#22D3EE] text-[#071318] font-medium'
                    : 'text-[#A0AABB] hover:text-[#F5F7FA]'
                }`}
              >
                {mode.toUpperCase()}
              </button>
            ))}
          </div>

          {rssFeedConfig ? (
            <button
              type="button"
              onClick={() => void loadAnalytics()}
              disabled={isRefreshing}
              aria-label="Refresh feed telemetry"
              className="h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#E5E7EB] bg-[#0B0D10] border border-[#262B36] hover:border-[#22D3EE]/50 hover:text-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin text-[#22D3EE]' : ''}`}
                aria-hidden="true"
              />
              <span>Refresh</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenRssModal}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Rss className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Activate RSS Feed</span>
            </button>
          )}

          {/* Collapsible Subscriber Growth Alerts Drawer Toggle (Synced with Bottom Drawer) */}
          <button
            type="button"
            onClick={handleToggleDrawerFromHeader}
            aria-expanded={isHistoryOpen}
            aria-controls="subscriber-growth-alerts-drawer"
            title={
              hasPendingAlerts
                ? `${pendingAlertCount} pending subscriber growth ${
                    pendingAlertCount === 1 ? 'alert' : 'alerts'
                  } awaiting acknowledgment`
                : 'Toggle Subscriber Growth Alerts history drawer'
            }
            className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isHistoryOpen
                ? 'bg-[#171C24] border-[#22D3EE] text-[#67E8F9]'
                : hasPendingAlerts
                  ? 'bg-[#0B0D10] border-[#F59E0B]/50 text-[#F5F7FA] hover:border-[#22D3EE]/60 hover:text-[#67E8F9]'
                  : 'bg-[#0B0D10] border-[#262B36] text-[#E5E7EB] hover:border-[#22D3EE]/50 hover:text-[#67E8F9]'
            }`}
          >
            <History className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="font-mono tabular-nums">
              Subscriber Alerts ({baseAlertHistory.length})
            </span>
            {hasPendingAlerts && (
              <span className="inline-flex items-center gap-1.5 pl-1.5 ml-0.5 border-l border-[#262B36]">
                <span
                  className="w-2 h-2 rounded-full bg-[#F59E0B] shrink-0"
                  aria-hidden="true"
                />
                <span className="text-[#FCD34D] font-medium whitespace-nowrap shrink-0">
                  New Alerts
                </span>
                <span className="font-mono text-[11px] text-[#FBBF24] tabular-nums">
                  ({pendingAlertCount})
                </span>
              </span>
            )}
            <ChevronDown
              className={`w-3 h-3 shrink-0 alert-drawer-chevron ${
                isHistoryOpen ? 'is-open text-[#67E8F9]' : 'text-[#8B95A7]'
              }`}
              aria-hidden="true"
            />
          </button>

          {/* Feed Performance Alert & Notification Settings Menu Popover */}
          <div ref={settingsContainerRef} className="relative">
            <button
              type="button"
              onClick={() => setIsSettingsOpen((prev) => !prev)}
              aria-expanded={isSettingsOpen}
              aria-haspopup="dialog"
              aria-label="Feed Performance alert settings"
              className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isSettingsOpen || isSimulatingSurge
                  ? 'bg-[#171C24] border-[#22D3EE] text-[#67E8F9]'
                  : 'bg-[#0B0D10] border-[#262B36] text-[#E5E7EB] hover:border-[#22D3EE]/50 hover:text-[#67E8F9]'
              }`}
            >
              <Settings className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Settings</span>
            </button>

            {isSettingsOpen && (
              <div
                role="dialog"
                aria-label="Feed Performance Alert Settings"
                className="absolute right-0 top-full mt-2 z-30 w-[340px] sm:w-[396px] p-4 bg-[#0B0D10] border border-[#22D3EE]/40 rounded-lg shadow-2xl space-y-4"
              >
                {/* Popover Header */}
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-[#1E232D]">
                  <div>
                    <h3 className="text-sm font-medium text-[#F5F7FA]">
                      Growth Alert &amp; Notification Settings
                    </h3>
                    <p className="mt-0.5 text-[11px] text-[#8B95A7]">
                      Configure 7-day subscriber growth thresholds, verify permissions, or export alert history.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(false)}
                    aria-label="Close settings menu"
                    className="h-7 w-7 inline-flex items-center justify-center text-[#8B95A7] hover:text-[#F5F7FA] bg-[#13161C] border border-[#262B36] rounded-md transition-colors shrink-0 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>

                {/* 1. 7-Day Growth Alert Toggle & Threshold Presets */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-[#F5F7FA]">
                        7-Day Subscriber Growth Alert
                      </p>
                      <p className="font-mono text-[11px] text-[#8B95A7] tabular-nums">
                        {alertConfig.enabled
                          ? `Target >= +${alertConfig.thresholdPercent}% (${targetSubscriberThresholdCount} subs)`
                          : 'Alert rule paused'}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={alertConfig.enabled}
                      aria-label="Toggle 7-day subscriber growth alert"
                      onClick={handleToggleAlertEnabled}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                        alertConfig.enabled ? 'bg-[#22D3EE]' : 'bg-[#2A303C]'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-[#071318] transition-transform ${
                          alertConfig.enabled
                            ? 'translate-x-4.5'
                            : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div
                      className="inline-flex items-center p-0.5 bg-[#13161C] border border-[#262B36] rounded-md"
                      role="group"
                      aria-label="7-day subscriber growth threshold presets"
                    >
                      {PRESET_THRESHOLDS.map((preset) => {
                        const isSelected =
                          alertConfig.enabled &&
                          alertConfig.thresholdPercent === preset;
                        return (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => handleSelectPresetThreshold(preset)}
                            className={`h-7 px-2.5 font-mono text-xs tabular-nums rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                              isSelected
                                ? 'bg-[#22D3EE] text-[#071318] font-medium'
                                : 'text-[#A0AABB] hover:text-[#F5F7FA]'
                            }`}
                          >
                            {preset}%
                          </button>
                        );
                      })}
                    </div>

                    <div className="inline-flex items-center gap-1 bg-[#13161C] border border-[#262B36] rounded-md px-2 h-8">
                      <label
                        htmlFor="rss-growth-custom-pct"
                        className="text-[11px] text-[#8B95A7] whitespace-nowrap shrink-0"
                      >
                        Custom
                      </label>
                      <input
                        id="rss-growth-custom-pct"
                        type="number"
                        min={1}
                        max={200}
                        step={0.5}
                        value={customThresholdInput}
                        onChange={(e) =>
                          setCustomThresholdInput(e.target.value)
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleApplyCustomThreshold();
                          }
                        }}
                        aria-label="Custom 7-day subscriber growth percentage threshold"
                        className="w-13 h-6 px-1.5 font-mono text-xs text-right text-[#F5F7FA] bg-[#0B0D10] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded tabular-nums"
                      />
                      <span className="font-mono text-xs text-[#8B95A7]">
                        %
                      </span>
                      <button
                        type="button"
                        onClick={handleApplyCustomThreshold}
                        className={`h-6 px-2 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          !customMatchesPreset &&
                          Number(customThresholdInput) ===
                            alertConfig.thresholdPercent
                            ? 'bg-[#22D3EE]/20 text-[#67E8F9]'
                            : 'text-[#D1D5DB] hover:text-[#67E8F9]'
                        }`}
                      >
                        Set
                      </button>
                    </div>
                  </div>
                </div>

                {/* 2. Browser Notifications Channel */}
                <div className="pt-3 border-t border-[#1E232D] flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[#F5F7FA] flex items-center gap-1.5">
                      <Bell
                        className="w-3.5 h-3.5 text-[#22D3EE]"
                        aria-hidden="true"
                      />
                      <span>Browser Notifications</span>
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-[#8B95A7]">
                      Permission: {formatBrowserPermissionLabel(browserPermission)}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={alertConfig.browserNotificationsEnabled}
                    aria-label="Toggle browser notifications for growth alerts"
                    onClick={() => void handleToggleBrowserNotifications()}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                      alertConfig.browserNotificationsEnabled
                        ? 'bg-[#22D3EE]'
                        : 'bg-[#2A303C]'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-[#071318] transition-transform ${
                        alertConfig.browserNotificationsEnabled
                          ? 'translate-x-4.5'
                          : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {/* 3. Test Alert Trigger & 15-Second Verification Diagnostics */}
                <div className="pt-3 border-t border-[#1E232D] space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[#F5F7FA]">
                        Verify Alert Pipeline
                      </p>
                      <p className="text-[11px] text-[#8B95A7]">
                        {isSimulatingSurge
                          ? `Simulating spike · auto-resets in ${testRemainingSeconds}s`
                          : 'Simulate a 7d growth spike for the current threshold'}
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {isSimulatingSurge && (
                        <button
                          type="button"
                          onClick={handleEndTestAlert}
                          className="h-8 px-2.5 inline-flex items-center gap-1 text-xs font-medium text-[#FCD34D] bg-[#1F1A10] border border-[#F59E0B]/50 hover:border-[#F59E0B] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Square className="w-3 h-3" aria-hidden="true" />
                          <span className="font-mono tabular-nums">
                            End Test ({testRemainingSeconds}s)
                          </span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleRunTestAlert()}
                        className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <FlaskConical
                          className="w-3.5 h-3.5"
                          aria-hidden="true"
                        />
                        <span>Test Alert</span>
                      </button>
                    </div>
                  </div>

                  {/* Verification Diagnostic Checklist */}
                  {testDiagnostics && diagnosticSummary && (
                    <div className="p-3 bg-[#13161C] border border-[#1E232D] rounded-md space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-[#1E232D] font-mono text-[11px] text-[#8B95A7] tabular-nums">
                        <span>Last Verified</span>
                        <span>{testDiagnostics.testedAtLabel}</span>
                      </div>

                      <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                        <span className="text-[#A0AABB] inline-flex items-center gap-1.5">
                          <CheckCircle2
                            className="w-3.5 h-3.5 text-[#34D399] shrink-0"
                            aria-hidden="true"
                          />
                          <span>Banner Rendering</span>
                        </span>
                        <span className="text-[#34D399]">
                          +{testDiagnostics.simulatedGrowthPct.toFixed(1)}% vs +
                          {testDiagnostics.thresholdTested}%
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                        <span className="text-[#A0AABB] inline-flex items-center gap-1.5">
                          <CheckCircle2
                            className="w-3.5 h-3.5 text-[#34D399] shrink-0"
                            aria-hidden="true"
                          />
                          <span>Chart Target Line</span>
                        </span>
                        <span className="text-[#67E8F9]">
                          {testDiagnostics.targetSubscribers} subs
                        </span>
                      </div>

                      <div className="space-y-1 pt-1 border-t border-[#1E232D]">
                        <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                          <span className="text-[#A0AABB] inline-flex items-center gap-1.5">
                            {testDiagnostics.browserOutcome ===
                            'granted-sent' ? (
                              <CheckCircle2
                                className="w-3.5 h-3.5 text-[#34D399] shrink-0"
                                aria-hidden="true"
                              />
                            ) : (
                              <AlertTriangle
                                className="w-3.5 h-3.5 text-[#F59E0B] shrink-0"
                                aria-hidden="true"
                              />
                            )}
                            <span>Browser Channel</span>
                          </span>
                          <span className={diagnosticSummary.toneClass}>
                            {diagnosticSummary.label}
                          </span>
                        </div>
                        <p className="text-[11px] text-[#8B95A7] leading-relaxed">
                          {diagnosticSummary.detail}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* 4. Alert History CSV Export Shortcut inside Settings Menu */}
                <div className="pt-3 border-t border-[#1E232D] flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[#F5F7FA]">
                      Alert History Ledger
                    </p>
                    <p className="font-mono text-[11px] text-[#8B95A7] tabular-nums">
                      {visibleAlertHistory.length}{' '}
                      {visibleAlertHistory.length === 1 ? 'event' : 'events'} (
                      {includeTestAlerts ? 'organic + tests' : 'organic 90d'})
                      {hasPendingAlerts ? ` · ${pendingAlertCount} pending` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setIsHistoryOpen(true);
                        setIsSettingsOpen(false);
                        window.setTimeout(() => {
                          alertDrawerRef.current?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'nearest',
                          });
                        }, 80);
                      }}
                      className="h-8 px-2.5 text-xs font-medium text-[#A0AABB] hover:text-[#F5F7FA] bg-[#13161C] border border-[#262B36] hover:border-[#3A4150] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Open Drawer
                    </button>
                    <button
                      type="button"
                      onClick={handleExportAlertHistoryCsv}
                      disabled={visibleAlertHistory.length === 0}
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/45 hover:border-[#22D3EE] hover:text-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {csvExportFlashCount !== null ? (
                        <Check
                          className="w-3.5 h-3.5 text-[#34D399]"
                          aria-hidden="true"
                        />
                      ) : (
                        <FileSpreadsheet
                          className="w-3.5 h-3.5 text-[#22D3EE]"
                          aria-hidden="true"
                        />
                      )}
                      <span>
                        {csvExportFlashCount !== null
                          ? `Exported (${csvExportFlashCount})`
                          : 'Export Alert History'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Triggered 7-Day Subscriber Growth Alert Notification Banner (Organic or 15s Test Spike) */}
      {shouldShowAlertBanner && (
        <div
          role="status"
          aria-live="polite"
          className={`m-5 mb-0 p-4 rounded-lg border flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
            isSimulatingSurge
              ? 'bg-[#0D1E26] border-[#22D3EE]/50'
              : 'bg-[#0B211D] border-[#34D399]/45'
          }`}
        >
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums">
              <BellRing
                className={`w-4 h-4 shrink-0 ${
                  isSimulatingSurge ? 'text-[#22D3EE]' : 'text-[#34D399]'
                }`}
                aria-hidden="true"
              />
              <span
                className={`font-semibold ${
                  isSimulatingSurge ? 'text-[#67E8F9]' : 'text-[#6EE7B7]'
                }`}
              >
                {isSimulatingSurge
                  ? 'Simulated 7-Day Growth Spike Verification'
                  : '7-Day Subscriber Growth Threshold Exceeded'}
              </span>
              <span className="text-[#6E788A]" aria-hidden="true">
                ·
              </span>
              <span className="text-[#F5F7FA]">
                +{sevenDayGrowthPct.toFixed(1)}% vs +
                {alertConfig.thresholdPercent}% target
                {thresholdExcessPct > 0
                  ? ` (+${thresholdExcessPct.toFixed(1)}% over threshold)`
                  : ''}
              </span>
              {isSimulatingSurge && (
                <>
                  <span className="text-[#6E788A]" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-[#FCD34D]">
                    Auto-resets in {testRemainingSeconds}s
                  </span>
                </>
              )}
            </div>

            <p className="text-xs text-[#D1D5DB] leading-relaxed">
              {isSimulatingSurge
                ? 'Test spike previewing '
                : 'Your private podcast feed gained '}
              <span className="font-mono font-medium text-[#F5F7FA] tabular-nums">
                +{sevenDayNetNewSubscribers} net new{' '}
                {sevenDayNetNewSubscribers === 1 ? 'subscriber' : 'subscribers'}
              </span>{' '}
              over the trailing 7 days (
              <span className="font-mono tabular-nums">
                {sevenDayStartSubscribers.toLocaleString()} &rarr;{' '}
                {currentSubscribers.toLocaleString()}
              </span>
              ).
              {isSimulatingSurge && diagnosticSummary ? (
                <>
                  {' '}
                  Browser permission check:{' '}
                  <span className={`font-mono ${diagnosticSummary.toneClass}`}>
                    {diagnosticSummary.label}
                  </span>
                  .
                </>
              ) : (
                topDriverEpisode && (
                  <>
                    {' '}
                    Top driver edition:{' '}
                    <span className="font-serif text-[#F5F7FA]">
                      {topDriverEpisode.editionTitle}
                    </span>
                    .
                  </>
                )
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {topDriverEpisode && (
              <button
                type="button"
                onClick={() => onOpenBriefing(topDriverEpisode)}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#34D399] hover:bg-[#6EE7B7] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Headphones className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Open Driver Edition</span>
              </button>
            )}

            {windowMode !== '7d' && (
              <button
                type="button"
                onClick={() => setWindowMode('7d')}
                className="h-8 px-3 text-xs font-medium text-[#F5F7FA] bg-[#0F1218] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Inspect 7D Chart
              </button>
            )}

            {isSimulatingSurge ? (
              <button
                type="button"
                onClick={handleEndTestAlert}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#FCD34D] bg-[#1F1A10] border border-[#F59E0B]/50 hover:border-[#F59E0B] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Square className="w-3 h-3" aria-hidden="true" />
                <span className="font-mono tabular-nums">
                  End Test ({testRemainingSeconds}s)
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleAcknowledgeAlert}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#A7F3D0] hover:text-[#F5F7FA] bg-transparent border border-[#34D399]/35 hover:border-[#34D399] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Acknowledge</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 4-Column Growth KPI Strip */}
      <div
        className={`grid grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[#1E232D] border-b border-[#1E232D] bg-[#0F1218]/60 ${
          shouldShowAlertBanner ? 'mt-5 border-t' : ''
        }`}
      >
        <div className="p-4">
          <div className="flex items-center justify-between gap-2 text-xs text-[#8B95A7]">
            <span>Active Subscribers</span>
            <Users className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
            <span className="text-2xl font-semibold text-[#F5F7FA]">
              {currentSubscribers.toLocaleString()}
            </span>
            <span
              className={`text-xs font-medium ${
                subscriberNetChange >= 0 ? 'text-[#34D399]' : 'text-[#F87171]'
              }`}
            >
              {subscriberNetChange >= 0
                ? `+${subscriberNetChange}`
                : subscriberNetChange}{' '}
              (
              {subscriberGrowthPct >= 0
                ? `+${subscriberGrowthPct}%`
                : `${subscriberGrowthPct}%`}
              )
            </span>
          </div>
          <p className="mt-1 text-[11px] text-[#6E788A] font-mono tabular-nums">
            7d rate:{' '}
            {sevenDayGrowthPct >= 0
              ? `+${sevenDayGrowthPct.toFixed(1)}%`
              : `${sevenDayGrowthPct.toFixed(1)}%`}{' '}
            · {windowMode} delta shown above
          </p>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between gap-2 text-xs text-[#8B95A7]">
            <span>Total Downloads ({windowMode})</span>
            <Download
              className="w-3.5 h-3.5 text-[#34D399]"
              aria-hidden="true"
            />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
            <span className="text-2xl font-semibold text-[#F5F7FA]">
              {totalWindowDownloads.toLocaleString()}
            </span>
            {liveAnalytics && liveAnalytics.totalLiveDownloads > 0 && (
              <span className="text-xs text-[#67E8F9]">
                +{liveAnalytics.totalLiveDownloads} live
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-[#6E788A]">
            Stitched full-edition WAV enclosures
          </p>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between gap-2 text-xs text-[#8B95A7]">
            <span>Downloads / Subscriber</span>
            <TrendingUp
              className="w-3.5 h-3.5 text-[#67E8F9]"
              aria-hidden="true"
            />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
            <span className="text-2xl font-semibold text-[#F5F7FA]">
              {downloadsPerSubscriber.toFixed(1)}x
            </span>
            <span className="text-xs text-[#A0AABB]">avg velocity</span>
          </div>
          <p className="mt-1 text-[11px] text-[#6E788A]">
            Episodes pulled per active subscriber
          </p>
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between gap-2 text-xs text-[#8B95A7]">
            <span>Peak Daily Volume</span>
            <Radio className="w-3.5 h-3.5 text-[#F59E0B]" aria-hidden="true" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
            <span className="text-2xl font-semibold text-[#F5F7FA]">
              {peakDayDownloads.toLocaleString()}
            </span>
            <span className="text-xs text-[#F59E0B]">on {peakDayLabel}</span>
          </div>
          <p className="mt-1 text-[11px] text-[#6E788A]">
            Highest single-day download surge
          </p>
        </div>
      </div>

      {/* Recharts Dual-Axis ComposedChart */}
      <div ref={chartSectionRef} className="p-5 border-b border-[#1E232D]">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3 text-xs">
          <div className="flex flex-wrap items-center gap-4">
            {showSubscribers && (
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-3 h-0.5 bg-[#22D3EE]"
                  aria-hidden="true"
                />
                <span className="text-[#D1D5DB]">
                  Active Subscribers (Left Axis)
                </span>
              </div>
            )}
            {showDownloads && (
              <div className="flex items-center gap-2">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-xs bg-[#34D399]"
                  aria-hidden="true"
                />
                <span className="text-[#D1D5DB]">
                  Daily Episode Downloads (Right Axis)
                </span>
              </div>
            )}
            {effectiveAlertActive && showSubscribers && (
              <div className="flex items-center gap-2 font-mono tabular-nums">
                <span
                  className="inline-block w-3 border-t border-dashed border-[#F59E0B]"
                  aria-hidden="true"
                />
                <span className="text-[#FCD34D]">
                  7d Alert Line: {targetSubscriberThresholdCount} subs (+
                  {alertConfig.thresholdPercent}%)
                </span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums">
            {focusedAlertEntry && focusedChartPoint ? (
              <>
                <span className="text-[#67E8F9]">
                  Focused Alert: {focusedChartPoint.shortLabel} (+
                  {focusedAlertEntry.growthPct.toFixed(1)}%)
                </span>
                <span className="text-[#6E788A]" aria-hidden="true">
                  ·
                </span>
                <button
                  type="button"
                  onClick={() => setFocusedAlertId(null)}
                  className="text-[#A0AABB] hover:text-[#F5F7FA] underline underline-offset-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Clear Focus
                </button>
              </>
            ) : (
              <span className="text-[#6E788A]">
                Hover any day for rolling 7d growth &amp; cumulative downloads
              </span>
            )}
          </div>
        </div>

        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
            >
              <defs>
                <linearGradient
                  id="feedPerfSubscribersFill"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor="#22D3EE" stopOpacity={0.32} />
                  <stop offset="95%" stopColor="#22D3EE" stopOpacity={0.0} />
                </linearGradient>
              </defs>

              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#1E232D"
                vertical={false}
              />

              <XAxis
                dataKey="shortLabel"
                stroke="#6E788A"
                tick={{ fill: '#8B95A7', fontSize: 11, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={{ stroke: '#1E232D' }}
                minTickGap={windowMode === '90d' ? 28 : 16}
              />

              <YAxis
                yAxisId="subscribers"
                orientation="left"
                hide={!showSubscribers}
                stroke="#22D3EE"
                tick={{ fill: '#67E8F9', fontSize: 11, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
                width={42}
                domain={subscriberAxisDomain}
              />

              <YAxis
                yAxisId="downloads"
                orientation="right"
                hide={!showDownloads}
                stroke="#34D399"
                tick={{ fill: '#6EE7B7', fontSize: 11, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
                width={42}
              />

              <Tooltip
                content={
                  <FeedPerformanceTooltip
                    alertEnabled={effectiveAlertActive}
                    thresholdPercent={alertConfig.thresholdPercent}
                  />
                }
                cursor={{ fill: 'rgba(34, 211, 238, 0.06)' }}
              />

              {showDownloads && (
                <Bar
                  yAxisId="downloads"
                  dataKey="dailyDownloads"
                  name="Daily Downloads"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={
                    windowMode === '7d' ? 32 : windowMode === '30d' ? 14 : 6
                  }
                >
                  {chartData.map((entry) => (
                    <Cell
                      key={entry.dateKey}
                      fill={
                        entry.isPeakDownloadDay
                          ? '#F59E0B'
                          : entry.liveDownloadsOnDay > 0
                            ? '#6EE7B7'
                            : '#34D399'
                      }
                      fillOpacity={entry.isPeakDownloadDay ? 0.95 : 0.78}
                    />
                  ))}
                </Bar>
              )}

              {effectiveAlertActive && showSubscribers && (
                <ReferenceLine
                  yAxisId="subscribers"
                  y={targetSubscriberThresholdCount}
                  stroke={isThresholdExceeded ? '#34D399' : '#F59E0B'}
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  label={{
                    value: `7d Target: ${targetSubscriberThresholdCount} (+${alertConfig.thresholdPercent}%)`,
                    position: 'insideTopLeft',
                    fill: isThresholdExceeded ? '#6EE7B7' : '#FCD34D',
                    fontSize: 11,
                    fontFamily: 'monospace',
                  }}
                />
              )}

              {focusedChartPoint && focusedAlertEntry && (
                <ReferenceLine
                  x={focusedChartPoint.shortLabel}
                  yAxisId={showSubscribers ? 'subscribers' : 'downloads'}
                  stroke="#67E8F9"
                  strokeDasharray="3 3"
                  strokeWidth={1.5}
                  label={{
                    value: `Focused: +${focusedAlertEntry.growthPct.toFixed(1)}%`,
                    position: 'insideTopRight',
                    fill: '#67E8F9',
                    fontSize: 11,
                    fontFamily: 'monospace',
                  }}
                />
              )}

              {showSubscribers && (
                <Area
                  yAxisId="subscribers"
                  type="monotone"
                  dataKey="activeSubscribers"
                  name="Active Subscribers"
                  stroke="#22D3EE"
                  strokeWidth={2.25}
                  fillOpacity={1}
                  fill="url(#feedPerfSubscribersFill)"
                  activeDot={{
                    r: 4.5,
                    fill: '#22D3EE',
                    stroke: '#0B0D10',
                    strokeWidth: 2,
                  }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 2-Column Companion Insights: Top Downloaded Episodes & Podcast App Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-[#1E232D]">
        {/* Left Column (7 cols): Top Downloaded Episodes */}
        <div className="lg:col-span-7 p-5 space-y-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-xs font-medium text-[#A0AABB]">
              Top Downloaded Episodes
            </h3>
            <span className="font-mono text-[11px] text-[#6E788A]">
              Click any edition to open in Studio
            </span>
          </div>

          {topEpisodes.length === 0 ? (
            <div className="p-4 bg-[#0B0D10] border border-[#1E232D] rounded-md text-xs text-[#8B95A7]">
              No archived briefings yet. Generate an audio briefing to track episode download performance.
            </div>
          ) : (
            <ul className="space-y-2.5">
              {topEpisodes.map((row, idx) => (
                <li
                  key={row.briefing.id}
                  className="p-3 bg-[#0B0D10] border border-[#1E232D] hover:border-[#22D3EE]/40 rounded-md transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#8B95A7] font-mono tabular-nums">
                        <span className="text-[#22D3EE]">0{idx + 1}.</span>
                        <span>{row.formatLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatClock(row.durationSeconds)}</span>
                        {row.liveDownloads > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-[#34D399]">
                              +{row.liveDownloads} live WAV
                            </span>
                          </>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => onOpenBriefing(row.briefing)}
                        className="mt-0.5 text-left font-serif text-sm font-medium text-[#F5F7FA] hover:text-[#67E8F9] transition-colors line-clamp-1 cursor-pointer"
                      >
                        {row.briefing.editionTitle}
                      </button>
                    </div>

                    <div className="text-right shrink-0">
                      <span className="font-mono text-sm font-semibold text-[#34D399] tabular-nums">
                        {row.totalDownloads.toLocaleString()}
                      </span>
                      <span className="block font-mono text-[10px] text-[#6E788A]">
                        Downloads
                      </span>
                    </div>
                  </div>

                  {/* Relative Download Volume Progress Bar */}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-[#171C24] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          row.sharePercent >= 90
                            ? 'w-full bg-[#34D399]'
                            : row.sharePercent >= 75
                              ? 'w-4/5 bg-[#34D399]'
                              : row.sharePercent >= 55
                                ? 'w-3/5 bg-[#22D3EE]'
                                : 'w-2/5 bg-[#22D3EE]'
                        }`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenBriefing(row.briefing)}
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-[#A0AABB] hover:text-[#67E8F9] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Headphones className="w-3 h-3" aria-hidden="true" />
                      <span>Open</span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Right Column (5 cols): Podcast App Client Distribution */}
        <div className="lg:col-span-5 p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-xs font-medium text-[#A0AABB]">
                Podcast App Breakdown
              </h3>
              <span className="font-mono text-[11px] text-[#6E788A]">
                User-Agent distribution
              </span>
            </div>

            <ul className="space-y-3">
              {clientBreakdownRows.map((client) => (
                <li key={client.family} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-[#E5E7EB]">
                      {client.family}
                    </span>
                    <div className="flex items-center gap-2 font-mono tabular-nums">
                      <span className="text-[#8B95A7]">
                        {client.count.toLocaleString()} reqs
                      </span>
                      <span className="text-[#F5F7FA] font-medium w-9 text-right">
                        {client.sharePercent}%
                      </span>
                    </div>
                  </div>
                  <div className="h-2 bg-[#0B0D10] border border-[#1E232D] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${client.barClass} ${
                        client.sharePercent >= 40
                          ? 'w-5/12'
                          : client.sharePercent >= 25
                            ? 'w-3/12'
                            : client.sharePercent >= 15
                              ? 'w-2/12'
                              : 'w-1/12'
                      }`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="pt-3 border-t border-[#1E232D] flex items-center justify-between gap-3 text-xs">
            <span className="text-[#8B95A7]">
              {rssFeedConfig
                ? rssFeedConfig.passwordProtected
                  ? 'Protected via Basic Auth / Signed Key'
                  : 'Private token link active'
                : 'Ready to provision private RSS URL'}
            </span>
            <button
              type="button"
              onClick={onOpenRssModal}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#0B0D10] border border-[#22D3EE]/40 hover:border-[#22D3EE] hover:text-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Rss className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              <span>{rssFeedConfig ? 'Feed Settings' : 'Export as RSS'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Collapsible Recent Subscriber Growth Alerts Drawer */}
      <div
        ref={alertDrawerRef}
        className="border-t border-[#1E232D] bg-[#0F1218]/90 rounded-b-lg"
      >
        <div className="px-5 py-3 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setIsHistoryOpen((prev) => !prev)}
            aria-expanded={isHistoryOpen}
            aria-controls="subscriber-growth-alerts-drawer"
            className="inline-flex flex-wrap items-center gap-2 text-left text-xs text-[#E5E7EB] hover:text-[#67E8F9] transition-colors cursor-pointer"
          >
            <History
              className="w-3.5 h-3.5 text-[#22D3EE] shrink-0"
              aria-hidden="true"
            />
            <span className="font-medium text-[#F5F7FA]">
              Subscriber Growth Alerts
            </span>
            <span className="text-[#6E788A]" aria-hidden="true">
              ·
            </span>
            <span className="font-mono text-[#A0AABB] tabular-nums">
              {organicCrossingEntries.length} organic 90d{' '}
              {organicCrossingEntries.length === 1 ? 'alert' : 'alerts'} at &ge;
              +{alertConfig.thresholdPercent}%
              {hasPendingAlerts ? (
                <>
                  {' · '}
                  <span className="text-[#FCD34D]">
                    {pendingAlertCount} pending
                  </span>
                </>
              ) : null}
              {alertTabCounts.active > 0
                ? ` · ${alertTabCounts.active} active`
                : ''}
              {storedHistoryState.testEntries.length > 0
                ? ` · ${storedHistoryState.testEntries.length} logged ${
                    storedHistoryState.testEntries.length === 1
                      ? 'test'
                      : 'tests'
                  }`
                : ''}
            </span>
            <ChevronDown
              className={`w-3.5 h-3.5 shrink-0 alert-drawer-chevron ${
                isHistoryOpen ? 'is-open text-[#67E8F9]' : 'text-[#8B95A7]'
              }`}
              aria-hidden="true"
            />
          </button>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Optional Include Test Runs Switch */}
            <div className="inline-flex items-center gap-2 text-xs text-[#A0AABB]">
              <button
                type="button"
                role="switch"
                aria-checked={includeTestAlerts}
                aria-label="Include simulated test alerts in drawer table and CSV export"
                onClick={() =>
                  setIncludeTestAlerts((prev) => {
                    const next = !prev;
                    if (!next && alertFilterTab === 'test') {
                      setAlertFilterTab('all');
                    }
                    return next;
                  })
                }
                className={`relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                  includeTestAlerts ? 'bg-[#22D3EE]' : 'bg-[#2A303C]'
                }`}
              >
                <span
                  className={`inline-block h-3 w-3 rounded-full bg-[#071318] transition-transform ${
                    includeTestAlerts ? 'translate-x-4' : 'translate-x-1'
                  }`}
                />
              </button>
              <span className="whitespace-nowrap shrink-0">
                Include Test Runs
              </span>
            </div>

            {includeTestAlerts && storedHistoryState.testEntries.length > 0 && (
              <button
                type="button"
                onClick={handleClearTestHistory}
                className="h-8 px-2.5 inline-flex items-center gap-1 text-xs font-medium text-[#8B95A7] hover:text-[#FCA5A5] bg-[#0B0D10] border border-[#262B36] hover:border-[#F87171]/40 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" aria-hidden="true" />
                <span>Clear Tests</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleExportAlertHistoryCsv}
              disabled={visibleAlertHistory.length === 0}
              aria-label="Export Alert History as CSV"
              className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {csvExportFlashCount !== null ? (
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <FileSpreadsheet className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span className="font-mono tabular-nums">
                {csvExportFlashCount !== null
                  ? `Exported ${csvExportFlashCount} Rows`
                  : `Export Alert History (${visibleAlertHistory.length})`}
              </span>
            </button>
          </div>
        </div>

        <div
          id="subscriber-growth-alerts-drawer"
          aria-hidden={!isHistoryOpen}
          inert={!isHistoryOpen}
          className={`alert-drawer-collapse ${isHistoryOpen ? 'is-open' : ''}`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="alert-drawer-slide-fade border-t border-[#1E232D] px-5 py-4 space-y-3.5">
            {firestoreAckError && (
              <div className="px-3.5 py-2 bg-[#2B1215] border border-[#F87171]/40 rounded-md flex items-center justify-between gap-3 text-xs text-[#FECACA]">
                <div className="flex items-center gap-2">
                  <AlertTriangle
                    className="w-3.5 h-3.5 text-[#F87171] shrink-0"
                    aria-hidden="true"
                  />
                  <span>{firestoreAckError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setFirestoreAckError(null)}
                  className="text-[#FCA5A5] hover:text-[#F5F7FA] font-medium whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Filter by Acknowledgment/Status/Type, Search Input, Result Summary, and Export Alert History Bar */}
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
              <div
                className="inline-flex flex-wrap items-center gap-1 p-0.5 bg-[#0B0D10] border border-[#262B36] rounded-md"
                role="group"
                aria-label="Filter subscriber growth alerts by acknowledgment status or event type"
              >
                {(
                  [
                    { id: 'all', label: 'All', count: alertTabCounts.all },
                    {
                      id: 'Pending',
                      label: 'Pending',
                      count: alertTabCounts.pending,
                    },
                    {
                      id: 'Acknowledged',
                      label: 'Acknowledged',
                      count: alertTabCounts.acknowledged,
                    },
                    {
                      id: 'Active',
                      label: 'Active',
                      count: alertTabCounts.active,
                    },
                    {
                      id: 'Historical',
                      label: 'Historical',
                      count: alertTabCounts.historical,
                    },
                    {
                      id: 'test',
                      label: 'Test Runs',
                      count: alertTabCounts.test,
                    },
                  ] as const
                ).map((tab) => {
                  const isActiveTab = alertFilterTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => handleSelectAlertFilterTab(tab.id)}
                      className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        isActiveTab
                          ? 'bg-[#171C24] text-[#67E8F9] border border-[#22D3EE]/40'
                          : 'text-[#8B95A7] hover:text-[#F5F7FA]'
                      }`}
                    >
                      <span>{tab.label}</span>
                      <span className="ml-1.5 font-mono text-[11px] opacity-80 tabular-nums">
                        {tab.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <div className="relative flex-1 sm:flex-initial sm:w-64">
                  <Search
                    className="w-3.5 h-3.5 text-[#6E788A] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={alertSearchQuery}
                    onChange={(e) => setAlertSearchQuery(e.target.value)}
                    placeholder="Search edition, status, client, ID..."
                    aria-label="Search subscriber growth alerts"
                    className="w-full h-8 pl-8 pr-7 text-xs text-[#F5F7FA] placeholder-[#6E788A] bg-[#0B0D10] border border-[#262B36] focus:border-[#22D3EE] focus:outline-none rounded-md"
                  />
                  {alertSearchQuery.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setAlertSearchQuery('')}
                      aria-label="Clear alert search query"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8B95A7] hover:text-[#F5F7FA] cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>

                <span className="font-mono text-[11px] text-[#6E788A] tabular-nums whitespace-nowrap shrink-0">
                  Showing {visibleAlertHistory.length} of{' '}
                  {baseAlertHistory.length}
                </span>

                <button
                  type="button"
                  onClick={handleExportAlertHistoryCsv}
                  disabled={visibleAlertHistory.length === 0}
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#0B0D10] border border-[#22D3EE]/45 hover:border-[#22D3EE] hover:text-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {csvExportFlashCount !== null ? (
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
                  <span className="font-mono tabular-nums">
                    {csvExportFlashCount !== null
                      ? `Exported ${csvExportFlashCount} Rows`
                      : `Export Alert History (${visibleAlertHistory.length})`}
                  </span>
                </button>
              </div>
            </div>

            {/* Range Slider Bound to Current Maximum 7-Day Subscriber Growth Percentage (0.5% steps) */}
            <div className="px-3.5 py-2.5 bg-[#0B0D10] border border-[#262B36] rounded-md flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <SlidersHorizontal
                  className="w-3.5 h-3.5 text-[#22D3EE] shrink-0"
                  aria-hidden="true"
                />
                <label
                  htmlFor="alert-min-growth-slider"
                  className="font-medium text-[#F5F7FA] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  7d Subscriber Growth Filter
                </label>
                <span className="text-[#4B5563]" aria-hidden="true">
                  &middot;
                </span>
                <span className="text-[#8B95A7] font-mono text-[11px] tabular-nums whitespace-nowrap shrink-0">
                  Current max 7d growth +{currentMax7dGrowthPct.toFixed(1)}%
                </span>
                <span className="text-[#4B5563]" aria-hidden="true">
                  &middot;
                </span>
                <span className="text-[#6E788A] font-mono text-[11px] whitespace-nowrap shrink-0">
                  {canUseFirestoreAck
                    ? 'Firestore ack sync active'
                    : 'Local browser ack cache'}
                </span>
              </div>

              <div className="flex flex-wrap sm:flex-nowrap items-center gap-3">
                <div className="flex items-center gap-2.5 flex-1 sm:flex-initial">
                  <span className="font-mono text-[11px] text-[#6E788A] tabular-nums whitespace-nowrap shrink-0">
                    0.0%
                  </span>
                  <input
                    id="alert-min-growth-slider"
                    type="range"
                    min={0}
                    max={maxSliderGrowthPct}
                    step={0.5}
                    value={effectiveMinGrowthPct}
                    onChange={(e) =>
                      setMinGrowthFilterPct(Number(e.target.value))
                    }
                    aria-label="Filter alerts by minimum 7-day subscriber growth percentage up to current maximum"
                    aria-valuemin={0}
                    aria-valuemax={maxSliderGrowthPct}
                    aria-valuenow={effectiveMinGrowthPct}
                    aria-valuetext={
                      effectiveMinGrowthPct > 0
                        ? `At least +${effectiveMinGrowthPct.toFixed(1)}% of +${maxSliderGrowthPct.toFixed(1)}% max 7-day subscriber growth`
                        : `All alerts (0.0% to +${maxSliderGrowthPct.toFixed(1)}% max)`
                    }
                    className="w-full sm:w-56 md:w-64 h-1.5 bg-[#1E232D] rounded-lg appearance-none cursor-pointer accent-[#22D3EE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22D3EE]/60"
                  />
                  <span className="font-mono text-[11px] text-[#6E788A] tabular-nums whitespace-nowrap shrink-0">
                    +{maxSliderGrowthPct.toFixed(1)}%
                  </span>
                </div>

                <div className="flex items-center gap-2 ml-auto sm:ml-0">
                  <span
                    className={`font-mono text-xs font-medium tabular-nums whitespace-nowrap shrink-0 min-w-[6.75rem] text-right ${
                      effectiveMinGrowthPct > 0
                        ? 'text-[#67E8F9]'
                        : 'text-[#A0AABB]'
                    }`}
                  >
                    {effectiveMinGrowthPct > 0
                      ? `\u2265 +${effectiveMinGrowthPct.toFixed(1)}%`
                      : 'All (\u2265 0.0%)'}
                  </span>

                  <button
                    type="button"
                    onClick={() => setMinGrowthFilterPct(0)}
                    disabled={effectiveMinGrowthPct === 0}
                    aria-label="Reset 7-day growth percentage slider filter"
                    className={`h-7 px-2.5 text-xs font-medium rounded border transition-colors whitespace-nowrap shrink-0 ${
                      effectiveMinGrowthPct > 0
                        ? 'text-[#F5F7FA] bg-[#13161C] border-[#22D3EE]/50 hover:border-[#22D3EE] hover:text-[#67E8F9] cursor-pointer'
                        : 'text-[#6E788A] bg-[#0F1218] border-[#1E232D] opacity-50 cursor-not-allowed'
                    }`}
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>

            {baseAlertHistory.length === 0 ? (
              <div className="p-5 bg-[#0B0D10] border border-[#1E232D] rounded-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-[#F5F7FA]">
                    No threshold crossings matched at &ge; +
                    {alertConfig.thresholdPercent}%
                  </p>
                  <p className="text-xs text-[#8B95A7]">
                    Peak organic 7-day subscriber growth over the past 90 days
                    reached{' '}
                    <span className="font-mono text-[#D1D5DB] tabular-nums">
                      +{peak90dRollingGrowthPct.toFixed(1)}%
                    </span>
                    . Lower the threshold or log a simulated test spike to
                    inspect alert metadata.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleSelectPresetThreshold(10)}
                    className="h-8 px-3 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#262B36] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Set 10% Threshold
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIncludeTestAlerts(true);
                      void handleRunTestAlert();
                    }}
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <FlaskConical className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Log Test Alert</span>
                  </button>
                </div>
              </div>
            ) : visibleAlertHistory.length === 0 ? (
              <div className="p-5 bg-[#0B0D10] border border-[#1E232D] rounded-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-[#F5F7FA]">
                    {effectiveMinGrowthPct > 0
                      ? `No subscriber growth alerts reached \u2265 +${effectiveMinGrowthPct.toFixed(1)}% under the active filters`
                      : 'No subscriber growth alerts match your active filter or search'}
                  </p>
                  <p className="text-xs text-[#8B95A7]">
                    {effectiveMinGrowthPct > 0 && baseAlertHistory.length > 0 ? (
                      <>
                        Current maximum 7-day subscriber growth is{' '}
                        <span className="font-mono text-[#D1D5DB] tabular-nums">
                          +{currentMax7dGrowthPct.toFixed(1)}%
                        </span>
                        . Lower the growth slider or reset filters to view
                        recorded threshold crossings.
                      </>
                    ) : (
                      'Clear the search filter or switch back to All alerts to view recorded threshold crossings.'
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleResetAlertFilters}
                  className="h-8 px-3 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#262B36] hover:border-[#22D3EE]/50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Reset Filters
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto border border-[#1E232D] rounded-md bg-[#0B0D10]">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[#1E232D] text-[11px] font-medium text-[#8B95A7] bg-[#13161C]/70">
                      <th
                        scope="col"
                        aria-sort={
                          alertSortField === 'triggeredAt'
                            ? alertSortDirection === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className="py-2.5 px-3 whitespace-nowrap"
                      >
                        <button
                          type="button"
                          onClick={() => handleSortColumn('triggeredAt')}
                          className="inline-flex items-center gap-1 hover:text-[#F5F7FA] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <span>Triggered Date</span>
                          {alertSortField === 'triggeredAt' ? (
                            alertSortDirection === 'asc' ? (
                              <ArrowUp
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowDown
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            )
                          ) : (
                            <ArrowUpDown
                              className="w-3 h-3 opacity-50"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </th>

                      <th
                        scope="col"
                        aria-sort={
                          alertSortField === 'growthPct'
                            ? alertSortDirection === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className="py-2.5 px-3 text-right whitespace-nowrap"
                      >
                        <button
                          type="button"
                          onClick={() => handleSortColumn('growthPct')}
                          className="inline-flex items-center justify-end gap-1 ml-auto hover:text-[#F5F7FA] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <span>7d Growth vs Target</span>
                          {alertSortField === 'growthPct' ? (
                            alertSortDirection === 'asc' ? (
                              <ArrowUp
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowDown
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            )
                          ) : (
                            <ArrowUpDown
                              className="w-3 h-3 opacity-50"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </th>

                      <th
                        scope="col"
                        aria-sort={
                          alertSortField === 'netNewSubscribers'
                            ? alertSortDirection === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className="py-2.5 px-3 text-right whitespace-nowrap"
                      >
                        <button
                          type="button"
                          onClick={() => handleSortColumn('netNewSubscribers')}
                          className="inline-flex items-center justify-end gap-1 ml-auto hover:text-[#F5F7FA] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <span>Subscribers (7d)</span>
                          {alertSortField === 'netNewSubscribers' ? (
                            alertSortDirection === 'asc' ? (
                              <ArrowUp
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowDown
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            )
                          ) : (
                            <ArrowUpDown
                              className="w-3 h-3 opacity-50"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </th>

                      <th
                        scope="col"
                        aria-sort={
                          alertSortField === 'trailing7dDownloads'
                            ? alertSortDirection === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className="py-2.5 px-3 text-right whitespace-nowrap"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            handleSortColumn('trailing7dDownloads')
                          }
                          className="inline-flex items-center justify-end gap-1 ml-auto hover:text-[#F5F7FA] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <span>7d Downloads</span>
                          {alertSortField === 'trailing7dDownloads' ? (
                            alertSortDirection === 'asc' ? (
                              <ArrowUp
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowDown
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            )
                          ) : (
                            <ArrowUpDown
                              className="w-3 h-3 opacity-50"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </th>

                      <th scope="col" className="py-2.5 px-3 whitespace-nowrap">
                        Driver Edition &amp; Client
                      </th>

                      <th
                        scope="col"
                        aria-sort={
                          alertSortField === 'status'
                            ? alertSortDirection === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                        className="py-2.5 px-3 text-right whitespace-nowrap"
                      >
                        <button
                          type="button"
                          onClick={() => handleSortColumn('status')}
                          className="inline-flex items-center justify-end gap-1 ml-auto hover:text-[#F5F7FA] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <span>Status</span>
                          {alertSortField === 'status' ? (
                            alertSortDirection === 'asc' ? (
                              <ArrowUp
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowDown
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                            )
                          ) : (
                            <ArrowUpDown
                              className="w-3 h-3 opacity-50"
                              aria-hidden="true"
                            />
                          )}
                        </button>
                      </th>

                      <th
                        scope="col"
                        className="py-2.5 px-3 text-right whitespace-nowrap"
                      >
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E232D] text-xs">
                    {visibleAlertHistory.map((entry) => {
                      const matchedBriefing = entry.driverBriefingId
                        ? archiveByIdMap.get(entry.driverBriefingId) || null
                        : null;
                      const isExpanded = expandedAlertId === entry.id;
                      const isFocusedOnChart = focusedAlertId === entry.id;
                      const canonicalAckKey = getCanonicalAlertKey(entry);
                      const isRowAcknowledged = Boolean(entry.acknowledged);
                      const isRowSyncing = Boolean(
                        pendingAckKeys[canonicalAckKey]
                      );
                      const lifecycleContextLabel =
                        entry.eventType === 'test'
                          ? 'Test Run'
                          : entry.status === 'Active'
                            ? 'Active Window'
                            : 'Historical';
                      const resolvedTargetSubs =
                        entry.targetSubscribers ??
                        Math.max(
                          entry.startSubscribers + 1,
                          Math.ceil(
                            entry.startSubscribers *
                              (1 + entry.thresholdPercent / 100)
                          )
                        );
                      const resolvedDlPerSub =
                        entry.downloadsPerSubscriber ??
                        (entry.endSubscribers > 0
                          ? Math.round(
                              (entry.trailing7dDownloads /
                                entry.endSubscribers) *
                                10
                            ) / 10
                          : 0);
                      const resolvedClientFamily =
                        entry.topClientFamily ||
                        resolveTopClientForSeed(entry.id);
                      const resolvedFeedAccess =
                        entry.feedAccessLabel ||
                        resolveFeedAccessLabel(rssFeedConfig);
                      const resolvedChannels =
                        entry.deliveryChannelSummary ||
                        'Inline Banner · Chart Target';

                      return (
                        <Fragment key={entry.id}>
                          <tr
                            className={`transition-colors ${
                              isExpanded || isFocusedOnChart
                                ? 'bg-[#13161C]/90'
                                : 'hover:bg-[#13161C]/60'
                            }`}
                          >
                            <td className="py-2.5 px-3 font-mono text-[11px] tabular-nums whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedAlertId((prev) =>
                                    prev === entry.id ? null : entry.id
                                  )
                                }
                                aria-expanded={isExpanded}
                                aria-label={`Inspect metadata for alert on ${entry.dateKey}`}
                                className="inline-flex items-center gap-1.5 text-left hover:text-[#67E8F9] transition-colors cursor-pointer"
                              >
                                {isExpanded ? (
                                  <ChevronDown
                                    className="w-3.5 h-3.5 text-[#22D3EE] shrink-0"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <ChevronRight
                                    className="w-3.5 h-3.5 text-[#6E788A] shrink-0"
                                    aria-hidden="true"
                                  />
                                )}
                                <span className="text-[#F5F7FA]">
                                  {formatHistoryTimestamp(
                                    entry.triggeredAt,
                                    entry.eventType
                                  )}
                                </span>
                                <span
                                  className="text-[#6E788A]"
                                  aria-hidden="true"
                                >
                                  ·
                                </span>
                                <span
                                  className={
                                    entry.eventType === 'test'
                                      ? 'text-[#F59E0B]'
                                      : 'text-[#67E8F9]'
                                  }
                                >
                                  {entry.eventType === 'test'
                                    ? 'Test'
                                    : 'Organic'}
                                </span>
                              </button>
                            </td>

                            <td className="py-2.5 px-3 text-right font-mono text-[11px] tabular-nums whitespace-nowrap">
                              <span className="text-[#34D399] font-medium">
                                +{entry.growthPct.toFixed(1)}%
                              </span>
                              <span className="text-[#8B95A7] ml-1.5">
                                (+{entry.varianceOverThresholdPct.toFixed(1)}%
                                over +{entry.thresholdPercent}%)
                              </span>
                            </td>

                            <td className="py-2.5 px-3 text-right font-mono text-[11px] tabular-nums whitespace-nowrap">
                              <span className="text-[#A0AABB]">
                                {entry.startSubscribers.toLocaleString()} &rarr;{' '}
                                {entry.endSubscribers.toLocaleString()}
                              </span>
                              <span className="text-[#F5F7FA] font-medium ml-1.5">
                                (+{entry.netNewSubscribers})
                              </span>
                            </td>

                            <td className="py-2.5 px-3 text-right font-mono text-[11px] tabular-nums whitespace-nowrap">
                              <span className="text-[#E5E7EB]">
                                {entry.trailing7dDownloads.toLocaleString()}
                              </span>
                              <span className="text-[#6E788A] ml-1">
                                ({entry.dailyDownloads}/d)
                              </span>
                            </td>

                            <td className="py-2.5 px-3 max-w-[240px]">
                              {matchedBriefing ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onOpenBriefing(matchedBriefing)
                                  }
                                  className="font-serif text-xs text-[#E5E7EB] hover:text-[#67E8F9] truncate block max-w-full text-left transition-colors cursor-pointer"
                                >
                                  {entry.driverEpisodeTitle}
                                </button>
                              ) : (
                                <span className="font-serif text-xs text-[#A0AABB] truncate block">
                                  {entry.driverEpisodeTitle}
                                </span>
                              )}
                              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-[#6E788A] truncate">
                                <span>{resolvedClientFamily}</span>
                                <span aria-hidden="true">·</span>
                                <span className="tabular-nums">
                                  {resolvedDlPerSub.toFixed(1)}x vel
                                </span>
                              </div>
                            </td>

                            <td className="py-2.5 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex flex-col items-end gap-0.5">
                                {isRowAcknowledged ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[#34D399]/40 bg-[#064E3B]/35 text-[#6EE7B7] font-mono text-[11px] font-medium whitespace-nowrap shrink-0">
                                    <CheckCircle2
                                      className="w-3 h-3 text-[#34D399] shrink-0"
                                      aria-hidden="true"
                                    />
                                    <span>Acknowledged</span>
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[#F59E0B]/40 bg-[#78350F]/30 text-[#FCD34D] font-mono text-[11px] font-medium whitespace-nowrap shrink-0">
                                    <Clock
                                      className="w-3 h-3 text-[#FBBF24] shrink-0"
                                      aria-hidden="true"
                                    />
                                    <span>Pending</span>
                                  </span>
                                )}
                                <span className="font-mono text-[10px] text-[#6E788A] whitespace-nowrap">
                                  {lifecycleContextLabel}
                                  {entry.ackSyncSource === 'firestore'
                                    ? ' · Firestore'
                                    : ''}
                                </span>
                              </div>
                            </td>

                            <td className="py-2.5 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center justify-end gap-2">
                                <div className="inline-flex items-center gap-1.5 px-2 h-7 rounded border border-[#262B36] bg-[#0F1218]">
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={isRowAcknowledged}
                                    disabled={isRowSyncing}
                                    onClick={() =>
                                      handleToggleRowAcknowledge(entry)
                                    }
                                    aria-label={`Toggle acknowledgment status for alert on ${entry.dateKey}`}
                                    className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
                                      isRowAcknowledged
                                        ? 'bg-[#22D3EE]'
                                        : 'bg-[#2A303C]'
                                    }`}
                                  >
                                    <span
                                      className={`inline-block h-2.5 w-2.5 rounded-full bg-[#071318] transition-transform ${
                                        isRowAcknowledged
                                          ? 'translate-x-3.5'
                                          : 'translate-x-0.5'
                                      }`}
                                    />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isRowSyncing}
                                    onClick={() =>
                                      handleToggleRowAcknowledge(entry)
                                    }
                                    className={`text-[11px] font-medium whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 ${
                                      isRowAcknowledged
                                        ? 'text-[#67E8F9] hover:text-[#F5F7FA]'
                                        : 'text-[#A0AABB] hover:text-[#F5F7FA]'
                                    }`}
                                  >
                                    {isRowSyncing
                                      ? 'Syncing...'
                                      : isRowAcknowledged
                                        ? 'Acknowledged'
                                        : 'Mark Ack'}
                                  </button>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => handleFocusAlertOnChart(entry)}
                                  title="Highlight this alert date on the Feed Performance chart"
                                  className={`h-7 px-2 inline-flex items-center gap-1 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                    isFocusedOnChart
                                      ? 'bg-[#171C24] border-[#22D3EE] text-[#67E8F9]'
                                      : 'bg-[#0F1218] border-[#262B36] text-[#A0AABB] hover:border-[#22D3EE]/50 hover:text-[#F5F7FA]'
                                  }`}
                                >
                                  <Crosshair
                                    className="w-3 h-3"
                                    aria-hidden="true"
                                  />
                                  <span>
                                    {isFocusedOnChart
                                      ? 'Focused'
                                      : 'Focus Chart'}
                                  </span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedAlertId((prev) =>
                                      prev === entry.id ? null : entry.id
                                    )
                                  }
                                  aria-expanded={isExpanded}
                                  className={`h-7 px-2 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                    isExpanded
                                      ? 'bg-[#171C24] border-[#22D3EE]/50 text-[#F5F7FA]'
                                      : 'bg-[#0F1218] border-[#262B36] text-[#8B95A7] hover:text-[#F5F7FA]'
                                  }`}
                                >
                                  {isExpanded ? 'Hide Meta' : 'Metadata'}
                                </button>
                              </div>
                            </td>
                          </tr>

                          {isExpanded && (
                            <tr className="bg-[#0F1218]">
                              <td colSpan={7} className="p-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 text-xs">
                                  {/* Column 1: Window & Event Identity */}
                                  <div className="space-y-1.5 sm:pr-4 sm:border-r border-[#1E232D]">
                                    <p className="text-[11px] font-medium text-[#8B95A7]">
                                      Evaluation Window &amp; ID
                                    </p>
                                    <p className="font-mono text-[#F5F7FA] tabular-nums">
                                      {entry.windowStartDate} &rarr;{' '}
                                      {entry.dateKey}
                                    </p>
                                    <p className="font-mono text-[11px] text-[#6E788A] tabular-nums break-all">
                                      ID: {entry.id} ·{' '}
                                      {entry.triggeredAt
                                        .replace('T', ' ')
                                        .replace('.000Z', 'Z')}
                                    </p>
                                  </div>

                                  {/* Column 2: Subscriber Threshold Math */}
                                  <div className="space-y-1.5 xl:pr-4 xl:border-r border-[#1E232D]">
                                    <p className="text-[11px] font-medium text-[#8B95A7]">
                                      Subscriber Threshold Math
                                    </p>
                                    <p className="font-mono text-[#F5F7FA] tabular-nums">
                                      Target &ge;{' '}
                                      {resolvedTargetSubs.toLocaleString()} subs
                                      (+{entry.thresholdPercent}%)
                                    </p>
                                    <p className="font-mono text-[11px] text-[#A0AABB] tabular-nums">
                                      Baseline {entry.startSubscribers} &rarr;
                                      Peak {entry.endSubscribers} (
                                      <span className="text-[#34D399]">
                                        +{entry.netNewSubscribers} subs · +
                                        {entry.varianceOverThresholdPct.toFixed(
                                          1
                                        )}
                                        % over rule
                                      </span>
                                      )
                                    </p>
                                  </div>

                                  {/* Column 3: Download Velocity & Client Attribution */}
                                  <div className="space-y-1.5 sm:pr-4 sm:border-r border-[#1E232D]">
                                    <p className="text-[11px] font-medium text-[#8B95A7]">
                                      Download Velocity &amp; Client
                                    </p>
                                    <p className="font-mono text-[#F5F7FA] tabular-nums">
                                      {entry.trailing7dDownloads.toLocaleString()}{' '}
                                      7d DLs · {resolvedDlPerSub.toFixed(1)}x
                                      per sub
                                    </p>
                                    <p className="font-mono text-[11px] text-[#A0AABB] tabular-nums">
                                      Trigger day: {entry.dailyDownloads} WAVs ·
                                      Lead app:{' '}
                                      <span className="text-[#67E8F9]">
                                        {resolvedClientFamily}
                                      </span>
                                    </p>
                                  </div>

                                  {/* Column 4: Feed Posture, Firestore Ack State & Edition Link */}
                                  <div className="space-y-1.5">
                                    <p className="text-[11px] font-medium text-[#8B95A7]">
                                      Feed &amp; Acknowledgment Sync
                                    </p>
                                    <p className="font-mono text-[#F5F7FA] truncate">
                                      {entry.feedTitle} · {resolvedFeedAccess}
                                    </p>
                                    <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                                      <span className="font-mono text-[11px] text-[#8B95A7] tabular-nums">
                                        {isRowAcknowledged
                                          ? `Acknowledged${
                                              entry.acknowledgedAt
                                                ? ` ${formatHistoryTimestamp(
                                                    entry.acknowledgedAt,
                                                    'test'
                                                  )}`
                                                : ''
                                            }`
                                          : 'Pending review'}{' '}
                                        ·{' '}
                                        {entry.ackSyncSource === 'firestore'
                                          ? 'Firestore'
                                          : 'Local'}{' '}
                                        · {resolvedChannels}
                                      </span>
                                      {matchedBriefing && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            onOpenBriefing(matchedBriefing)
                                          }
                                          className="inline-flex items-center gap-1 font-mono text-[11px] text-[#67E8F9] hover:text-[#F5F7FA] underline underline-offset-2 whitespace-nowrap shrink-0 cursor-pointer"
                                        >
                                          <Headphones
                                            className="w-3 h-3"
                                            aria-hidden="true"
                                          />
                                          <span>Open Edition</span>
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
