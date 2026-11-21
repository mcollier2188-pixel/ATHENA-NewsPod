import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileSearch,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type {
  ActiveView,
  SharedBriefingManifest,
  SiteMockupProject,
} from '../types';
import {
  backfillServerSharesIntoFirestore,
  commitFirestoreScrubAndRelink,
  firestoreDocToSharedBriefingManifest,
  firestoreDocToSharedMockupManifest,
  scanFirestorePublicShareLinks,
  type ScannedFirestoreShareItem,
  type ServerRawShareSnapshot,
} from '../services/firestorePublicShares';
import {
  fetchOwnerShareSecuritySnapshots,
  logOwnerShareSecurityScan,
  scrubAndRelinkOwnerShare,
  type OwnerAuditedShare,
  type OwnerAuditedUser,
} from '../services/suiteApi';
import type { ShareFindingSeverity } from '../utils/sharePayloadInspector';

interface ShareSecurityScannerPanelProps {
  currentUser: User;
  isOwner: boolean;
  overviewUsers: OwnerAuditedUser[];
  overviewShares: OwnerAuditedShare[];
  getIdToken: () => Promise<string | null>;
  onNavigateView: (view: ActiveView) => void;
  onPreviewSharedBriefing: (shareId: string) => void;
  onPreviewSharedMockup: (shareId: string) => void;
  onAfterScrubRelink: () => Promise<void>;
  onOpenSecurityAuditLog: () => void;
  onFlaggedCountChange: (count: number) => void;
  onSurfaceError: (msg: string | null) => void;
  onSurfaceNotice: (msg: string | null) => void;
}

type ScannerFilterMode =
  | 'all'
  | 'flagged'
  | 'critical'
  | 'clean'
  | 'briefing'
  | 'mockup';

interface RemediationReceipt {
  title: string;
  kind: 'briefing' | 'mockup';
  oldShareId: string;
  oldSharePath: string;
  newShareId: string;
  newSharePath: string;
  scrubbedFindingCount: number;
  completedAtIso: string;
}

const CATEGORY_SHORT_LABELS: Record<string, string> = {
  secret_credential: 'Secret / Token',
  financial_card: 'Payment Card',
  pii_government_id: 'Gov / Tax ID',
  unauthorized_field: 'Private Field',
  internal_network: 'Internal IP',
  pii_email: 'Email PII',
  pii_phone: 'Phone PII',
  pii_address: 'Address PII',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatRemainingWindow(expiresAtIso: string): string {
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'Expired';
  const totalHours = Math.floor(diffMs / (3600 * 1000));
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  if (days >= 1) return `${days}d ${remHours}h left`;
  const mins = Math.max(1, Math.floor((diffMs % (3600 * 1000)) / 60000));
  return totalHours >= 1 ? `${totalHours}h ${mins}m left` : `${mins}m left`;
}

function formatSeverityText(severity: ShareFindingSeverity): string {
  if (severity === 'critical') return 'Critical';
  if (severity === 'high') return 'High';
  return 'Medium';
}

export function ShareSecurityScannerPanel({
  currentUser,
  isOwner,
  overviewUsers,
  overviewShares,
  getIdToken,
  onNavigateView,
  onPreviewSharedBriefing,
  onPreviewSharedMockup,
  onAfterScrubRelink,
  onOpenSecurityAuditLog,
  onFlaggedCountChange,
  onSurfaceError,
  onSurfaceNotice,
}: ShareSecurityScannerPanelProps) {
  const [scannedItems, setScannedItems] = useState<ScannedFirestoreShareItem[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [hasCompletedInitialScan, setHasCompletedInitialScan] = useState(false);
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<ScannerFilterMode>('all');
  const [expandedShareId, setExpandedShareId] = useState<string | null>(null);
  const [scrubbingShareId, setScrubbingShareId] = useState<string | null>(null);
  const [isBatchScrubbing, setIsBatchScrubbing] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [recentReceipts, setRecentReceipts] = useState<RemediationReceipt[]>([]);

  const initialScanTriggeredRef = useRef(false);

  const knownStudioEmails = useMemo(() => {
    const set = new Set<string>();
    if (currentUser.email) {
      set.add(currentUser.email.toLowerCase());
    }
    for (const u of overviewUsers) {
      if (u.email) {
        set.add(u.email.toLowerCase());
      }
    }
    return set;
  }, [currentUser.email, overviewUsers]);

  const knownShareIds = useMemo(
    () => overviewShares.map((s) => s.shareId),
    [overviewShares]
  );

  const executeScan = useCallback(
    async (recordAuditEntry: boolean) => {
      if (!currentUser.emailVerified) return;
      setIsScanning(true);
      onSurfaceError(null);

      try {
        const token = await getIdToken();
        let backfilledCount = 0;
        let extraKnownIds = [...knownShareIds];

        // 1. Fetch active server share snapshots so any pre-existing /tmp shares are mirrored into Firestore before scanning
        if (token) {
          try {
            const { snapshots } = await fetchOwnerShareSecuritySnapshots(token);
            if (snapshots.length > 0) {
              const prePassItems = await scanFirestorePublicShareLinks({
                callerUser: currentUser,
                isPrincipalOwner: isOwner,
                knownShareIds: snapshots.map((s) => s.shareId),
                knownStudioEmails,
              });
              const existingIds = new Set(prePassItems.map((item) => item.doc.shareId));
              const typedSnapshots: ServerRawShareSnapshot[] = snapshots.map((snap) => ({
                shareId: snap.shareId,
                kind: snap.kind,
                sharePath: snap.sharePath,
                creatorUid: snap.creatorUid,
                creatorEmail: snap.creatorEmail,
                createdAt: snap.createdAt,
                expiresAt: snap.expiresAt,
                ttlHours: snap.ttlHours,
                note: snap.note,
                briefingManifest: snap.briefingManifest as unknown as
                  | SharedBriefingManifest
                  | undefined,
                mockupProject: snap.mockupProject as unknown as
                  | SiteMockupProject
                  | undefined,
              }));

              backfilledCount = await backfillServerSharesIntoFirestore({
                callerUser: currentUser,
                serverSnapshots: typedSnapshots,
                existingFirestoreIds: existingIds,
              });

              extraKnownIds = Array.from(
                new Set([...extraKnownIds, ...snapshots.map((s) => s.shareId)])
              );
            }
          } catch {
            // Proceed with direct Firestore scan even if server snapshot endpoint is transiently busy
          }
        }

        // 2. Scan all active Firestore /publicShareLinks documents for PII & unauthorized sensitive fields
        const results = await scanFirestorePublicShareLinks({
          callerUser: currentUser,
          isPrincipalOwner: isOwner,
          knownShareIds: extraKnownIds,
          knownStudioEmails,
        });

        setScannedItems(results);
        setLastScannedAt(new Date().toISOString());
        setHasCompletedInitialScan(true);

        const flagged = results.filter((r) => !r.report.clean);
        onFlaggedCountChange(flagged.length);

        // Auto-expand the highest-severity flagged share on first scan so findings are immediately actionable
        if (flagged.length > 0) {
          setExpandedShareId((prev) =>
            prev && results.some((r) => r.doc.shareId === prev)
              ? prev
              : flagged[0].doc.shareId
          );
        }

        if (recordAuditEntry && token) {
          const totalFindings = results.reduce(
            (sum, r) => sum + r.report.findingCount,
            0
          );
          const criticalFindings = results.reduce(
            (sum, r) => sum + r.report.criticalCount,
            0
          );
          await logOwnerShareSecurityScan(token, {
            scannedCount: results.length,
            flaggedCount: flagged.length,
            findingCount: totalFindings,
            criticalCount: criticalFindings,
            backfilledToFirestore: backfilledCount,
          }).catch(() => {});

          onSurfaceNotice(
            flagged.length > 0
              ? `Scanned ${results.length} public share ${results.length === 1 ? 'link' : 'links'} in Firestore: detected ${totalFindings} PII or sensitive data ${totalFindings === 1 ? 'finding' : 'findings'} across ${flagged.length} ${flagged.length === 1 ? 'link' : 'links'}.`
              : `Scanned ${results.length} public share ${results.length === 1 ? 'link' : 'links'} in Firestore: 0 PII or unauthorized sensitive fields detected.`
          );
        }
      } catch (err) {
        onSurfaceError(
          err instanceof Error
            ? err.message
            : 'Could not complete Firestore public share security scan.'
        );
      } finally {
        setIsScanning(false);
      }
    },
    [
      currentUser,
      getIdToken,
      isOwner,
      knownShareIds,
      knownStudioEmails,
      onFlaggedCountChange,
      onSurfaceError,
      onSurfaceNotice,
    ]
  );

  useEffect(() => {
    if (initialScanTriggeredRef.current) return;
    initialScanTriggeredRef.current = true;
    void executeScan(false);
  }, [executeScan]);

  const executeSingleScrubAndRelink = async (
    item: ScannedFirestoreShareItem,
    tokenOverride?: string
  ): Promise<RemediationReceipt> => {
    const token = tokenOverride ?? (await getIdToken());
    if (!token) {
      throw new Error('Authentication session expired. Please refresh and sign in again.');
    }

    const fallbackBriefing =
      item.doc.kind === 'briefing'
        ? (firestoreDocToSharedBriefingManifest(item.doc) as unknown as Record<
            string,
            unknown
          >)
        : undefined;

    const fallbackMockupProject =
      item.doc.kind === 'mockup'
        ? (firestoreDocToSharedMockupManifest(item.doc).project as unknown as Record<
            string,
            unknown
          >)
        : undefined;

    // 1. Rotate share ID on server, migrate any recorded audio chapters, scrub server manifest, and delete old server share
    const serverRotated = await scrubAndRelinkOwnerShare(
      token,
      item.doc.kind,
      item.doc.shareId,
      {
        ttlHours: item.doc.ttlHours,
        note: item.doc.note,
        title: item.doc.title,
        scrubbedFindingCount: item.report.findingCount,
        categories: item.report.categories,
        briefingManifest: fallbackBriefing,
        mockupProject: fallbackMockupProject,
      }
    );

    // 2. Atomically delete /publicShareLinks/{oldShareId} and create scrubbed /publicShareLinks/{newShareId} in Firestore
    const firestoreCommitted = await commitFirestoreScrubAndRelink({
      callerUser: currentUser,
      sourceDoc: item.doc,
      newShareId: serverRotated.newShareId,
      newExpiresAtIso: serverRotated.expiresAt,
      scrubbedFindingCount: item.report.findingCount,
    });

    return {
      title: item.doc.title,
      kind: item.doc.kind,
      oldShareId: item.doc.shareId,
      oldSharePath: item.doc.sharePath,
      newShareId: firestoreCommitted.newShareId,
      newSharePath: firestoreCommitted.newSharePath,
      scrubbedFindingCount: item.report.findingCount,
      completedAtIso: new Date().toISOString(),
    };
  };

  const handleScrubSingle = async (item: ScannedFirestoreShareItem) => {
    setScrubbingShareId(item.doc.shareId);
    onSurfaceError(null);
    onSurfaceNotice(null);

    try {
      const receipt = await executeSingleScrubAndRelink(item);
      setRecentReceipts((prev) => [receipt, ...prev].slice(0, 6));
      if (expandedShareId === item.doc.shareId) {
        setExpandedShareId(receipt.newShareId);
      }

      await executeScan(false);
      await onAfterScrubRelink();

      onSurfaceNotice(
        `Scrubbed ${receipt.scrubbedFindingCount} sensitive ${
          receipt.scrubbedFindingCount === 1 ? 'field' : 'fields'
        } from "${receipt.title}", invalidated ${receipt.oldSharePath}, and issued clean link ${receipt.newSharePath}.`
      );
    } catch (err) {
      onSurfaceError(
        err instanceof Error
          ? err.message
          : 'Could not scrub and re-link the selected share payload.'
      );
    } finally {
      setScrubbingShareId(null);
    }
  };

  const flaggedItems = useMemo(
    () => scannedItems.filter((item) => !item.report.clean),
    [scannedItems]
  );

  const handleBatchScrubFlagged = async () => {
    if (flaggedItems.length === 0) return;
    setIsBatchScrubbing(true);
    onSurfaceError(null);
    onSurfaceNotice(null);

    try {
      const token = await getIdToken();
      if (!token) {
        throw new Error('Authentication session expired. Please refresh and sign in again.');
      }

      const receipts: RemediationReceipt[] = [];
      for (const item of flaggedItems) {
        setScrubbingShareId(item.doc.shareId);
        const receipt = await executeSingleScrubAndRelink(item, token);
        receipts.push(receipt);
      }

      setRecentReceipts((prev) => [...receipts, ...prev].slice(0, 8));
      setExpandedShareId(null);

      await executeScan(false);
      await onAfterScrubRelink();

      const totalScrubbedFindings = receipts.reduce(
        (sum, r) => sum + r.scrubbedFindingCount,
        0
      );
      onSurfaceNotice(
        `Scrubbed ${totalScrubbedFindings} PII/sensitive ${
          totalScrubbedFindings === 1 ? 'finding' : 'findings'
        } and rotated ${receipts.length} public share ${
          receipts.length === 1 ? 'link' : 'links'
        } to clean capability URLs.`
      );
    } catch (err) {
      onSurfaceError(
        err instanceof Error
          ? err.message
          : 'Batch Scrub & Re-Link encountered an error.'
      );
    } finally {
      setScrubbingShareId(null);
      setIsBatchScrubbing(false);
    }
  };

  const handleCopyPath = async (sharePath: string) => {
    const fullUrl = `${window.location.origin}${sharePath}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopiedPath(sharePath);
      window.setTimeout(() => {
        setCopiedPath((prev) => (prev === sharePath ? null : prev));
      }, 2000);
    } catch {
      onSurfaceError(`Clipboard unavailable. Clean URL: ${fullUrl}`);
    }
  };

  const summaryStats = useMemo(() => {
    let criticalFindings = 0;
    let highFindings = 0;
    let mediumFindings = 0;
    let cleanLinks = 0;
    let relinkedLinks = 0;

    for (const item of scannedItems) {
      if (item.report.clean) cleanLinks += 1;
      if (item.doc.relinkedFromShareId) relinkedLinks += 1;
      criticalFindings += item.report.criticalCount;
      highFindings += item.report.highCount;
      mediumFindings += item.report.mediumCount;
    }

    return {
      totalLinks: scannedItems.length,
      flaggedLinks: flaggedItems.length,
      cleanLinks,
      relinkedLinks,
      totalFindings: criticalFindings + highFindings + mediumFindings,
      criticalFindings,
      highFindings,
      mediumFindings,
    };
  }, [flaggedItems.length, scannedItems]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return scannedItems.filter((item) => {
      if (filterMode === 'flagged' && item.report.clean) return false;
      if (filterMode === 'critical' && item.report.criticalCount === 0) return false;
      if (filterMode === 'clean' && !item.report.clean) return false;
      if (filterMode === 'briefing' && item.doc.kind !== 'briefing') return false;
      if (filterMode === 'mockup' && item.doc.kind !== 'mockup') return false;

      if (!q) return true;
      const findingPaths = item.report.findings
        .map((f) => `${f.fieldPath} ${f.categoryLabel} ${f.reason}`)
        .join(' ')
        .toLowerCase();
      return (
        item.doc.title.toLowerCase().includes(q) ||
        item.doc.subtitle.toLowerCase().includes(q) ||
        item.doc.shareId.toLowerCase().includes(q) ||
        item.doc.sharePath.toLowerCase().includes(q) ||
        item.doc.relinkedFromShareId.toLowerCase().includes(q) ||
        findingPaths.includes(q)
      );
    });
  }, [filterMode, scannedItems, searchQuery]);

  return (
    <section className="space-y-5">
      {/* Scanner Header & Telemetry Strip */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-[#1F2532]">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <FileSearch className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-[#F5F7FA]">
              Public Share Payload PII &amp; Sensitive Data Scanner
            </h2>
          </div>
          <p className="text-xs text-[#8C96A8] max-w-3xl leading-relaxed">
            Automatically inspects active Firestore{' '}
            <span className="font-mono text-[#C7D0DF]">/publicShareLinks</span> documents
            for serialized personal emails, phone numbers, street addresses, Luhn-valid
            payment cards, government IDs, API credentials, and private studio notes.
            Scrub &amp; Re-Link strips detected fields, deletes the exposed document, and
            mints a fresh capability URL.
          </p>

          <div className="flex items-center gap-2.5 flex-wrap pt-1 text-xs text-[#8C96A8] font-mono tabular-nums">
            <span>
              <strong className="text-[#F5F7FA] font-semibold">
                {summaryStats.totalLinks}
              </strong>{' '}
              active {summaryStats.totalLinks === 1 ? 'share' : 'shares'}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={
                summaryStats.flaggedLinks > 0 ? 'text-[#FCA5A5]' : 'text-emerald-300'
              }
            >
              <strong className="font-semibold">{summaryStats.flaggedLinks}</strong>{' '}
              flagged
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <strong className="text-[#F5F7FA] font-semibold">
                {summaryStats.criticalFindings}
              </strong>{' '}
              critical /{' '}
              <strong className="text-[#F5F7FA] font-semibold">
                {summaryStats.highFindings}
              </strong>{' '}
              high /{' '}
              <strong className="text-[#F5F7FA] font-semibold">
                {summaryStats.mediumFindings}
              </strong>{' '}
              medium
            </span>
            <span aria-hidden="true">·</span>
            <span className="text-emerald-300">
              <strong className="font-semibold">{summaryStats.cleanLinks}</strong>{' '}
              verified clean
            </span>
            {summaryStats.relinkedLinks > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[#67E8F9]">
                  <strong className="font-semibold">
                    {summaryStats.relinkedLinks}
                  </strong>{' '}
                  scrubbed &amp; rotated
                </span>
              </>
            )}
            {lastScannedAt && (
              <>
                <span aria-hidden="true">·</span>
                <span>Scanned {formatDateTime(lastScannedAt)}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button
            type="button"
            onClick={onOpenSecurityAuditLog}
            className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            View Share Audit Trail
          </button>

          {flaggedItems.length > 0 && (
            <button
              type="button"
              disabled={isBatchScrubbing || isScanning || Boolean(scrubbingShareId)}
              onClick={() => void handleBatchScrubFlagged()}
              className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-amber-400 hover:bg-amber-300 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums"
            >
              {isBatchScrubbing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span className="font-sans">
                Scrub &amp; Re-Link All Flagged ({flaggedItems.length})
              </span>
            </button>
          )}

          <button
            type="button"
            disabled={isScanning || isBatchScrubbing}
            onClick={() => void executeScan(true)}
            className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Run Security Scan
          </button>
        </div>
      </div>

      {/* Recent Scrub & Re-Link Receipts */}
      {recentReceipts.length > 0 && (
        <div className="bg-[#0F2429] border border-[#22D3EE]/40 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#67E8F9]">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>
                Completed Scrub &amp; Re-Link Rotations ({recentReceipts.length})
              </span>
            </div>
            <button
              type="button"
              onClick={() => setRecentReceipts([])}
              className="text-xs text-[#8C96A8] hover:text-[#F5F7FA] whitespace-nowrap shrink-0 cursor-pointer"
            >
              Clear Receipts
            </button>
          </div>

          <div className="divide-y divide-[#1A353D] text-xs">
            {recentReceipts.map((rec) => {
              const isCopied = copiedPath === rec.newSharePath;
              return (
                <div
                  key={`${rec.oldShareId}-${rec.newShareId}`}
                  className="py-2.5 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-[#F5F7FA] truncate max-w-[260px]">
                        {rec.title}
                      </span>
                      <span className="text-[#8C96A8]" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-mono tabular-nums text-emerald-300">
                        {rec.scrubbedFindingCount}{' '}
                        {rec.scrubbedFindingCount === 1 ? 'finding' : 'findings'} scrubbed
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap font-mono text-[11px] tabular-nums">
                      <span className="line-through text-[#FCA5A5]">
                        {rec.oldSharePath}
                      </span>
                      <ArrowRight
                        className="w-3 h-3 text-[#67E8F9] shrink-0"
                        aria-hidden="true"
                      />
                      <span className="text-[#67E8F9] font-medium">
                        {rec.newSharePath}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleCopyPath(rec.newSharePath)}
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#F5F7FA] bg-[#13161C] border border-[#22D3EE]/45 hover:border-[#22D3EE] rounded whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {isCopied ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                      )}
                      {isCopied ? 'Copied New URL' : 'Copy New Link'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        rec.kind === 'briefing'
                          ? onPreviewSharedBriefing(rec.newShareId)
                          : onPreviewSharedMockup(rec.newShareId)
                      }
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      Open Clean Preview
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Search & Segmented Filter Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search
            className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search share ID, title, field path (e.g. payload.siteNotes)..."
            className="w-full h-9 pl-8 pr-3 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] placeholder:text-[#6E788A] focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md overflow-x-auto">
          {(
            [
              { id: 'all', label: `All (${summaryStats.totalLinks})` },
              { id: 'flagged', label: `Flagged (${summaryStats.flaggedLinks})` },
              {
                id: 'critical',
                label: `Critical (${
                  scannedItems.filter((i) => i.report.criticalCount > 0).length
                })`,
              },
              { id: 'clean', label: `Verified Clean (${summaryStats.cleanLinks})` },
              { id: 'briefing', label: 'Briefings' },
              { id: 'mockup', label: 'Site Mockups' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterMode(tab.id)}
              className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums ${
                filterMode === tab.id
                  ? 'bg-[#1C2533] text-[#67E8F9]'
                  : 'text-[#8C96A8] hover:text-[#F5F7FA]'
              }`}
            >
              <span className="font-sans">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Main Firestore Share Inspection Table */}
      <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                <th className="py-3 px-4">Firestore Share Document</th>
                <th className="py-3 px-4">Type &amp; Window</th>
                <th className="py-3 px-4">Security Posture</th>
                <th className="py-3 px-4">Detected Categories</th>
                <th className="py-3 px-4 text-right">Payload</th>
                <th className="py-3 px-4 text-right">Remediation Controls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1C212C] text-xs">
              {!hasCompletedInitialScan && isScanning ? (
                Array.from({ length: 3 }).map((_, idx) => (
                  <tr key={`skeleton-${idx}`} className="h-14">
                    <td colSpan={6} className="py-3.5 px-4">
                      <div className="flex items-center justify-between gap-4">
                        <div className="h-3.5 w-48 bg-[#1B202B] rounded" />
                        <div className="h-3.5 w-28 bg-[#1B202B] rounded" />
                        <div className="h-3.5 w-32 bg-[#1B202B] rounded" />
                        <div className="h-7 w-36 bg-[#1B202B] rounded" />
                      </div>
                    </td>
                  </tr>
                ))
              ) : scannedItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 px-6 text-center">
                    <div className="max-w-md mx-auto space-y-3">
                      <div className="w-10 h-10 mx-auto rounded-md bg-[#18212E] border border-[#22D3EE]/35 flex items-center justify-center">
                        <ShieldCheck
                          className="w-5 h-5 text-[#22D3EE]"
                          aria-hidden="true"
                        />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-[#F5F7FA]">
                          No Active Public Share Links in Firestore
                        </p>
                        <p className="text-xs text-[#8C96A8] leading-relaxed">
                          Published Audio Briefings and Site Mockup preview links are
                          stored in{' '}
                          <span className="font-mono text-[#C7D0DF]">
                            /publicShareLinks
                          </span>{' '}
                          and scanned automatically here for PII, credentials, and private
                          notes.
                        </p>
                      </div>
                      <div className="flex items-center justify-center gap-2.5 pt-1">
                        <button
                          type="button"
                          onClick={() => onNavigateView('mockup')}
                          className="h-9 px-3.5 text-xs font-medium text-[#F5F7FA] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Open Site Mockup Studio
                        </button>
                        <button
                          type="button"
                          disabled={isScanning}
                          onClick={() => void executeScan(true)}
                          className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`}
                            aria-hidden="true"
                          />
                          Re-Scan Firestore
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 px-4 text-center text-[#8C96A8]">
                    No Firestore share links match the current filter or search query.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => {
                  const { doc: shareDoc, report } = item;
                  const isExpanded = expandedShareId === shareDoc.shareId;
                  const isScrubbingThis = scrubbingShareId === shareDoc.shareId;
                  const isCopied = copiedPath === shareDoc.sharePath;

                  return (
                    <Fragment key={shareDoc.shareId}>
                      <tr className="hover:bg-[#171B23] transition-colors">
                        {/* Column 1: Document Title, Path & Lineage */}
                        <td className="py-3.5 px-4 align-top">
                          <div className="font-medium text-[#F5F7FA] truncate max-w-[260px]">
                            {shareDoc.title}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 flex-wrap font-mono text-[11px] text-[#8C96A8] tabular-nums">
                            <span className="text-[#C7D0DF]">{shareDoc.sharePath}</span>
                            {shareDoc.relinkedFromShareId && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-[#67E8F9]">
                                  Rotated from {shareDoc.relinkedFromShareId}
                                </span>
                              </>
                            )}
                          </div>
                        </td>

                        {/* Column 2: Type & Expiration */}
                        <td className="py-3.5 px-4 align-top whitespace-nowrap">
                          <div className="text-[#D5DCE6]">
                            {shareDoc.kind === 'briefing'
                              ? 'Audio Briefing'
                              : 'Site Mockup'}
                          </div>
                          <div className="mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] text-[#8C96A8] tabular-nums">
                            <Clock className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                            <span>{formatRemainingWindow(shareDoc.expiresAtIso)}</span>
                          </div>
                        </td>

                        {/* Column 3: Security Posture (Icon + Text Label, Zero Static Pills) */}
                        <td className="py-3.5 px-4 align-top whitespace-nowrap">
                          {report.clean ? (
                            <div className="space-y-0.5">
                              <div className="inline-flex items-center gap-1.5 text-emerald-300 font-medium">
                                <ShieldCheck
                                  className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                                  aria-hidden="true"
                                />
                                <span>Verified Clean</span>
                              </div>
                              <div className="text-[11px] font-mono text-[#6E788A] tabular-nums">
                                0 findings
                                {shareDoc.scrubbedFindingCount > 0
                                  ? ` · ${shareDoc.scrubbedFindingCount} scrubbed`
                                  : ''}
                              </div>
                            </div>
                          ) : report.highestSeverity === 'critical' ? (
                            <div className="space-y-0.5">
                              <div className="inline-flex items-center gap-1.5 text-[#FCA5A5] font-semibold">
                                <ShieldAlert
                                  className="w-3.5 h-3.5 text-[#F87171] shrink-0"
                                  aria-hidden="true"
                                />
                                <span>Critical Exposure</span>
                              </div>
                              <div className="text-[11px] font-mono text-[#FCA5A5] tabular-nums">
                                {report.findingCount}{' '}
                                {report.findingCount === 1 ? 'finding' : 'findings'} (
                                {report.criticalCount} critical)
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              <div className="inline-flex items-center gap-1.5 text-amber-300 font-medium">
                                <AlertTriangle
                                  className="w-3.5 h-3.5 text-amber-400 shrink-0"
                                  aria-hidden="true"
                                />
                                <span>PII / Sensitive Data</span>
                              </div>
                              <div className="text-[11px] font-mono text-amber-200/90 tabular-nums">
                                {report.findingCount}{' '}
                                {report.findingCount === 1 ? 'finding' : 'findings'}
                              </div>
                            </div>
                          )}
                        </td>

                        {/* Column 4: Unboxed Category Metadata */}
                        <td className="py-3.5 px-4 align-top">
                          {report.categories.length === 0 ? (
                            <span className="text-[#6E788A]">
                              No PII or internal fields serialized
                            </span>
                          ) : (
                            <div className="text-[#C7D0DF] leading-relaxed max-w-[260px]">
                              {report.categories
                                .map((cat) => CATEGORY_SHORT_LABELS[cat] || cat)
                                .join(' · ')}
                            </div>
                          )}
                        </td>

                        {/* Column 5: Payload Size */}
                        <td className="py-3.5 px-4 align-top text-right font-mono text-[11px] text-[#C7D0DF] tabular-nums whitespace-nowrap">
                          {formatBytes(item.estimatedBytes)}
                        </td>

                        {/* Column 6: Actions */}
                        <td className="py-3.5 px-4 align-top text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedShareId((prev) =>
                                  prev === shareDoc.shareId ? null : shareDoc.shareId
                                )
                              }
                              className={`h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                isExpanded
                                  ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]'
                                  : 'bg-[#0E1116] text-[#C7D0DF] hover:text-[#F5F7FA] border-[#2A3342]'
                              }`}
                            >
                              <Eye className="w-3 h-3 text-[#22D3EE]" aria-hidden="true" />
                              <span>
                                {report.findingCount > 0
                                  ? `Findings (${report.findingCount})`
                                  : 'Inspect'}
                              </span>
                              {isExpanded ? (
                                <ChevronUp className="w-3 h-3" aria-hidden="true" />
                              ) : (
                                <ChevronDown className="w-3 h-3" aria-hidden="true" />
                              )}
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                shareDoc.kind === 'briefing'
                                  ? onPreviewSharedBriefing(shareDoc.shareId)
                                  : onPreviewSharedMockup(shareDoc.shareId)
                              }
                              className="h-8 px-2.5 inline-flex items-center gap-1 text-[11px] text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded whitespace-nowrap shrink-0 cursor-pointer"
                              title="Open public share view"
                            >
                              <ExternalLink
                                className="w-3 h-3 text-[#22D3EE]"
                                aria-hidden="true"
                              />
                              Preview
                            </button>

                            <button
                              type="button"
                              onClick={() => void handleCopyPath(shareDoc.sharePath)}
                              className="h-8 px-2.5 inline-flex items-center gap-1 text-[11px] text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded whitespace-nowrap shrink-0 cursor-pointer"
                              title="Copy share URL"
                            >
                              {isCopied ? (
                                <Check
                                  className="w-3 h-3 text-emerald-400"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Copy className="w-3 h-3" aria-hidden="true" />
                              )}
                              {isCopied ? 'Copied' : 'Copy'}
                            </button>

                            {!report.clean ? (
                              <button
                                type="button"
                                disabled={isScrubbingThis || isBatchScrubbing}
                                onClick={() => void handleScrubSingle(item)}
                                className="h-8 px-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#071318] bg-amber-400 hover:bg-amber-300 disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                {isScrubbingThis ? (
                                  <Loader2
                                    className="w-3 h-3 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
                                )}
                                Scrub &amp; Re-Link
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={isScrubbingThis || isBatchScrubbing}
                                onClick={() => void handleScrubSingle(item)}
                                className="h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/35 hover:border-[#22D3EE] disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                title="Rotate capability URL and re-verify scrubbed payload"
                              >
                                {isScrubbingThis ? (
                                  <Loader2
                                    className="w-3 h-3 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
                                )}
                                Rotate Link
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expandable Forensics Drawer */}
                      {isExpanded && (
                        <tr className="bg-[#0E1116]">
                          <td colSpan={6} className="px-5 py-4">
                            <div className="space-y-3">
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-[#1F2532]">
                                <div className="flex items-center gap-2 flex-wrap text-xs text-[#9BA6B8] font-mono tabular-nums">
                                  <span className="font-sans font-semibold text-[#F5F7FA]">
                                    Payload Inspection Detail
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <span>
                                    /publicShareLinks/{shareDoc.shareId}
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <span>Owner UID: {shareDoc.ownerId}</span>
                                  {shareDoc.scrubbedAtIso && (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="text-emerald-300">
                                        Scrubbed {formatDateTime(shareDoc.scrubbedAtIso)}
                                      </span>
                                    </>
                                  )}
                                </div>

                                {!report.clean && (
                                  <button
                                    type="button"
                                    disabled={isScrubbingThis || isBatchScrubbing}
                                    onClick={() => void handleScrubSingle(item)}
                                    className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    {isScrubbingThis ? (
                                      <Loader2
                                        className="w-3.5 h-3.5 animate-spin"
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <RotateCcw
                                        className="w-3.5 h-3.5"
                                        aria-hidden="true"
                                      />
                                    )}
                                    Scrub {report.findingCount}{' '}
                                    {report.findingCount === 1 ? 'Finding' : 'Findings'}{' '}
                                    &amp; Issue Clean Link
                                  </button>
                                )}
                              </div>

                              {report.findings.length === 0 ? (
                                <div className="py-3 flex items-center gap-2 text-xs text-emerald-300">
                                  <CheckCircle2
                                    className="w-4 h-4 text-emerald-400 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span>
                                    Zero PII patterns, payment card numbers, API tokens, or
                                    unauthorized studio fields were found in this Firestore
                                    share payload.
                                  </span>
                                </div>
                              ) : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-left border-collapse text-xs">
                                    <thead>
                                      <tr className="border-b border-[#1F2532] text-[11px] font-medium text-[#8C96A8]">
                                        <th className="py-2 pr-4">Severity</th>
                                        <th className="py-2 pr-4">Category</th>
                                        <th className="py-2 pr-4">Serialized Field Path</th>
                                        <th className="py-2 pr-4">Masked Match</th>
                                        <th className="py-2">Automated Scrub Action</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#191E28]">
                                      {report.findings.map((finding) => (
                                        <tr key={finding.id}>
                                          <td className="py-2.5 pr-4 whitespace-nowrap font-medium">
                                            {finding.severity === 'critical' ? (
                                              <span className="inline-flex items-center gap-1 text-[#FCA5A5]">
                                                <ShieldAlert
                                                  className="w-3.5 h-3.5 text-[#F87171]"
                                                  aria-hidden="true"
                                                />
                                                {formatSeverityText(finding.severity)}
                                              </span>
                                            ) : finding.severity === 'high' ? (
                                              <span className="inline-flex items-center gap-1 text-amber-300">
                                                <AlertTriangle
                                                  className="w-3.5 h-3.5 text-amber-400"
                                                  aria-hidden="true"
                                                />
                                                {formatSeverityText(finding.severity)}
                                              </span>
                                            ) : (
                                              <span className="inline-flex items-center gap-1 text-[#67E8F9]">
                                                <AlertTriangle
                                                  className="w-3.5 h-3.5 text-[#22D3EE]"
                                                  aria-hidden="true"
                                                />
                                                {formatSeverityText(finding.severity)}
                                              </span>
                                            )}
                                          </td>
                                          <td className="py-2.5 pr-4 whitespace-nowrap text-[#F5F7FA]">
                                            {finding.categoryLabel}
                                          </td>
                                          <td className="py-2.5 pr-4 font-mono text-[11px] text-[#67E8F9]">
                                            {finding.fieldPath}
                                          </td>
                                          <td className="py-2.5 pr-4 font-mono text-[11px] text-[#D5DCE6] tabular-nums whitespace-nowrap">
                                            {finding.maskedPreview}
                                          </td>
                                          <td className="py-2.5 text-[#9BA6B8]">
                                            <div>{finding.reason}</div>
                                            <div className="text-[11px] text-[#6E788A] mt-0.5">
                                              Action: {finding.remediation}
                                            </div>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
