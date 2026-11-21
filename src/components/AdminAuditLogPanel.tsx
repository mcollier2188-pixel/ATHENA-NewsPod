import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Download,
  FileJson,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  X,
} from 'lucide-react';
import type { AuditClipboardFormat } from '../utils/auditLogClipboardFormat';
import type {
  AuditAccountabilityDomain,
  AuditLogCategory,
  AuditSeverity,
  OwnerActivityLogEntry,
  OwnerAuditedUser,
  SystemConfigFieldDiff,
} from '../services/suiteApi';

export type AuditDomainFilter = 'all' | AuditAccountabilityDomain;
export type AuditWindowFilter = 'all' | 24 | 168 | 720;
export type AuditSortOrder = 'desc' | 'asc';

interface AdminAuditLogPanelProps {
  logs: OwnerActivityLogEntry[];
  users: OwnerAuditedUser[];
  isLoading: boolean;
  domainFilter: AuditDomainFilter;
  onDomainFilterChange: (next: AuditDomainFilter) => void;
  categoryFilter: 'all' | AuditLogCategory;
  onCategoryFilterChange: (next: 'all' | AuditLogCategory) => void;
  authFilter: 'all' | 'verified' | 'unverified' | 'suspended';
  onAuthFilterChange: (next: 'all' | 'verified' | 'unverified' | 'suspended') => void;
  userIdFilter: number | 'all';
  onUserIdFilterChange: (next: number | 'all') => void;
  windowFilter: AuditWindowFilter;
  onWindowFilterChange: (next: AuditWindowFilter) => void;
  sortOrder: AuditSortOrder;
  onSortOrderChange: (next: AuditSortOrder) => void;
  fromDate: string;
  onFromDateChange: (next: string) => void;
  toDate: string;
  onToDateChange: (next: string) => void;
  searchQuery: string;
  onSearchQueryChange: (next: string) => void;
  onReload: () => void;
  onResetFilters: () => void;
  onExportCsv: (entries: OwnerActivityLogEntry[]) => void;
  onSurfaceNotice: (msg: string) => void;
  onOpenSystemConfig?: () => void;
  auditClipboardFormat?: AuditClipboardFormat;
  onAuditClipboardFormatChange?: (next: AuditClipboardFormat) => void;
  onCopyFullAuditLog?: (format: AuditClipboardFormat) => void;
  copyingAuditFormat?: AuditClipboardFormat | null;
  copiedAuditFormat?: AuditClipboardFormat | null;
}

const DOMAIN_LABELS: Record<AuditAccountabilityDomain, string> = {
  auth_history: 'User Login & Auth',
  privilege_modifications: 'Privilege Change',
  system_config: 'System Config Update',
  system_data_changes: 'Workspace Data Event',
};

const CATEGORY_LABELS: Record<AuditLogCategory, string> = {
  auth: 'Authentication',
  governance: 'Governance & RBAC',
  system_config: 'System Configuration',
  ai_desk: 'AI Desk',
  media_lab: 'Media Lab',
  mockup: 'Site Mockup',
  spatial: 'Spatial & Map',
  share: 'Public Shares',
};

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
    second: '2-digit',
  }).format(date);
}

function formatUtcTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.toISOString().slice(11, 19)} UTC`;
}

function formatRelativeAge(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatRoleLabel(role: 'owner' | 'admin' | 'member' | 'guest' | string): string {
  if (role === 'owner') return 'Ultra Owner';
  if (role === 'admin') return 'Studio Admin';
  if (role === 'guest') return 'Guest';
  if (role === 'member') return 'Member';
  return role || 'Member';
}

function formatSeverityLabel(severity: AuditSeverity): string {
  if (severity === 'critical') return 'Critical';
  if (severity === 'elevated') return 'Elevated';
  return 'Standard';
}

function highlightQueryMatch(text: string, rawQuery: string): ReactNode {
  const q = rawQuery.trim();
  if (!q || !text) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  if (parts.length <= 1) return text;
  const lowerQ = q.toLowerCase();
  return parts.map((part, idx) =>
    part.toLowerCase() === lowerQ ? (
      <mark
        key={`${idx}-${part}`}
        className="bg-[#22D3EE]/25 text-[#F5F7FA] rounded-xs px-0.5"
      >
        {part}
      </mark>
    ) : (
      <Fragment key={`${idx}-${part}`}>{part}</Fragment>
    )
  );
}

function extractConfigChangesList(
  meta: Record<string, unknown>
): SystemConfigFieldDiff[] {
  if (!Array.isArray(meta.changes)) return [];
  const list: SystemConfigFieldDiff[] = [];
  for (const item of meta.changes) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.key === 'string') {
        list.push({
          key: obj.key,
          label: typeof obj.label === 'string' ? obj.label : obj.key,
          before:
            typeof obj.before === 'boolean' ||
            typeof obj.before === 'number' ||
            typeof obj.before === 'string'
              ? obj.before
              : String(obj.before ?? '—'),
          after:
            typeof obj.after === 'boolean' ||
            typeof obj.after === 'number' ||
            typeof obj.after === 'string'
              ? obj.after
              : String(obj.after ?? '—'),
        });
      }
    }
  }
  return list;
}

export function extractAuditStateTransition(
  entry: OwnerActivityLogEntry
): { label: string; before: string; after: string } | null {
  const meta = entry.metadata || {};

  if (
    typeof meta.previousRole === 'string' &&
    typeof meta.nextRole === 'string' &&
    meta.previousRole !== meta.nextRole
  ) {
    return {
      label: 'Privilege Role Transition',
      before: formatRoleLabel(meta.previousRole),
      after: formatRoleLabel(meta.nextRole),
    };
  }

  if (
    typeof meta.previousStatus === 'string' &&
    typeof meta.nextStatus === 'string' &&
    meta.previousStatus !== meta.nextStatus
  ) {
    return {
      label: 'Account Status Transition',
      before: meta.previousStatus,
      after: meta.nextStatus,
    };
  }

  if (entry.action === 'auth.force_logout') {
    const prevSession =
      typeof meta.previousSessionState === 'string'
        ? meta.previousSessionState
        : 'active';
    const fsCleared = meta.firestoreAuthCleared === true;
    return {
      label: 'Session & Firestore Auth Revocation',
      before: `${prevSession} session`,
      after: fsCleared ? 'revoked · /userProfiles cleared' : 'revoked · tokens invalidated',
    };
  }

  if (entry.action === 'share.scrubbed_relinked') {
    const prevPath =
      typeof meta.previousSharePath === 'string'
        ? meta.previousSharePath
        : 'compromised share';
    const nextPath =
      typeof meta.nextSharePath === 'string' ? meta.nextSharePath : 'relinked share';
    const findingsCount = Number(meta.scrubbedFindingCount) || 0;
    return {
      label: 'Share Payload Scrubbed & Re-Linked',
      before: `${prevPath} (${findingsCount} ${findingsCount === 1 ? 'finding' : 'findings'})`,
      after: `${nextPath} (0 findings · scrubbed)`,
    };
  }

  if (entry.action === 'share.security_scanned') {
    const scanned = Number(meta.scannedCount) || 0;
    const flagged = Number(meta.flaggedCount) || 0;
    const findings = Number(meta.findingCount) || 0;
    return {
      label: 'Firestore Public Share Security Scan',
      before: `${scanned} ${scanned === 1 ? 'link' : 'links'} inspected`,
      after:
        flagged > 0
          ? `${flagged} flagged · ${findings} ${findings === 1 ? 'finding' : 'findings'}`
          : '0 exposures · verified clean',
    };
  }

  const configDiffs = extractConfigChangesList(meta);
  if (configDiffs.length > 0) {
    if (configDiffs.length === 1) {
      const only = configDiffs[0];
      return {
        label: only.label,
        before: String(only.before),
        after: String(only.after),
      };
    }
    return {
      label: `${configDiffs.length} System Settings Updated`,
      before: configDiffs.map((c) => `${c.key}=${String(c.before)}`).join(', '),
      after: configDiffs.map((c) => `${c.key}=${String(c.after)}`).join(', '),
    };
  }

  if (
    (entry.category === 'system_config' || entry.action.startsWith('config.')) &&
    meta.previousValue !== undefined &&
    meta.nextValue !== undefined
  ) {
    return {
      label:
        typeof meta.settingLabel === 'string'
          ? meta.settingLabel
          : 'Configuration Change',
      before: String(meta.previousValue),
      after: String(meta.nextValue),
    };
  }

  if (typeof meta.assignedRole === 'string') {
    return {
      label: 'Initial Role Provisioned',
      before: 'unregistered',
      after: formatRoleLabel(meta.assignedRole),
    };
  }

  if (
    (entry.action === 'auth.sign_in' || entry.action === 'auth.blocked_suspended') &&
    typeof meta.loginCount === 'number'
  ) {
    const provider =
      typeof meta.authProvider === 'string' ? meta.authProvider : 'google.com';
    return {
      label: 'Authenticated Login Session',
      before: provider,
      after: `Session #${meta.loginCount}`,
    };
  }

  if (
    typeof meta.firestoreCreated === 'number' ||
    typeof meta.firestoreRepaired === 'number' ||
    typeof meta.orphansRemoved === 'number'
  ) {
    const created = Number(meta.firestoreCreated) || 0;
    const repaired = Number(meta.firestoreRepaired) || 0;
    const recreated = Number(meta.corruptedRecreated) || 0;
    const orphans = Number(meta.orphansRemoved) || 0;
    return {
      label: 'Identity Link Reconciliation',
      before: `${Number(meta.firestoreScanned) || 0} evaluated`,
      after: `${created} created · ${repaired} synced${recreated > 0 ? ` · ${recreated} recreated` : ''}${orphans > 0 ? ` · ${orphans} orphans removed` : ''}`,
    };
  }

  return null;
}

function formatMetadataValue(val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return val.toLocaleString();
  if (typeof val === 'string') return val || '—';
  return JSON.stringify(val);
}

export function AdminAuditLogPanel({
  logs,
  users,
  isLoading,
  domainFilter,
  onDomainFilterChange,
  categoryFilter,
  onCategoryFilterChange,
  authFilter,
  onAuthFilterChange,
  userIdFilter,
  onUserIdFilterChange,
  windowFilter,
  onWindowFilterChange,
  sortOrder,
  onSortOrderChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  searchQuery,
  onSearchQueryChange,
  onReload,
  onResetFilters,
  onExportCsv,
  onSurfaceNotice,
  onOpenSystemConfig,
  auditClipboardFormat = 'markdown',
  onAuditClipboardFormatChange,
  onCopyFullAuditLog,
  copyingAuditFormat = null,
  copiedAuditFormat = null,
}: AdminAuditLogPanelProps) {
  const [elevatedOnly, setElevatedOnly] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);

  const visibleLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const nowMs = Date.now();
    const windowMs = windowFilter === 'all' ? null : windowFilter * 3600 * 1000;
    const fromMs = fromDate
      ? new Date(`${fromDate}T00:00:00.000Z`).getTime()
      : null;
    const toMs = toDate
      ? new Date(`${toDate}T23:59:59.999Z`).getTime()
      : null;

    const filtered = logs.filter((entry) => {
      if (domainFilter !== 'all' && entry.domain !== domainFilter) return false;
      if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false;
      if (authFilter !== 'all' && entry.authStatus !== authFilter) return false;
      if (userIdFilter !== 'all' && entry.userId !== userIdFilter) return false;
      if (elevatedOnly && entry.severity === 'standard') return false;

      const ts = new Date(entry.createdAt).getTime();
      if (windowMs !== null) {
        if (!Number.isFinite(ts) || nowMs - ts > windowMs) return false;
      }
      if (fromMs !== null && Number.isFinite(fromMs)) {
        if (!Number.isFinite(ts) || ts < fromMs) return false;
      }
      if (toMs !== null && Number.isFinite(toMs)) {
        if (!Number.isFinite(ts) || ts > toMs) return false;
      }

      if (!q) return true;
      const metaText = JSON.stringify(entry.metadata || {}).toLowerCase();
      const isoStamp = Number.isFinite(ts)
        ? new Date(ts).toISOString().toLowerCase()
        : '';
      const humanStamp = formatDateTime(entry.createdAt).toLowerCase();
      return (
        entry.actorEmail.toLowerCase().includes(q) ||
        entry.actorName.toLowerCase().includes(q) ||
        entry.action.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        entry.resourceType.toLowerCase().includes(q) ||
        entry.resourceId.toLowerCase().includes(q) ||
        entry.clientContext.toLowerCase().includes(q) ||
        isoStamp.includes(q) ||
        humanStamp.includes(q) ||
        metaText.includes(q)
      );
    });

    return [...filtered].sort((a, b) => {
      const diff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (diff !== 0) {
        return sortOrder === 'asc' ? diff : -diff;
      }
      return sortOrder === 'asc'
        ? a.id.localeCompare(b.id)
        : b.id.localeCompare(a.id);
    });
  }, [
    authFilter,
    categoryFilter,
    domainFilter,
    elevatedOnly,
    fromDate,
    logs,
    searchQuery,
    sortOrder,
    toDate,
    userIdFilter,
    windowFilter,
  ]);

  const accountabilityMetrics = useMemo(() => {
    let authHistoryCount = 0;
    let signInCount = 0;
    let signOutCount = 0;
    let blockedAuthCount = 0;
    let latestLoginIso: string | null = null;
    let latestLoginMs = 0;

    let privilegeCount = 0;
    let roleChangeCount = 0;
    let statusToggleCount = 0;
    let syncRemediationCount = 0;

    let systemConfigCount = 0;
    let runtimePolicyUpdateCount = 0;
    let preferenceUpdateCount = 0;

    let systemDataCount = 0;
    let shareMutationCount = 0;
    let deletionCount = 0;

    let criticalOrElevatedCount = 0;

    for (const entry of logs) {
      if (entry.severity === 'critical' || entry.severity === 'elevated') {
        criticalOrElevatedCount += 1;
      }

      if (entry.domain === 'auth_history') {
        authHistoryCount += 1;
        if (entry.action === 'auth.sign_in' || entry.action === 'auth.account_registered') {
          signInCount += 1;
          const ts = new Date(entry.createdAt).getTime();
          if (Number.isFinite(ts) && ts > latestLoginMs) {
            latestLoginMs = ts;
            latestLoginIso = entry.createdAt;
          }
        } else if (entry.action === 'auth.sign_out') {
          signOutCount += 1;
        } else if (entry.action === 'auth.blocked_suspended') {
          blockedAuthCount += 1;
        }
      } else if (entry.domain === 'privilege_modifications') {
        privilegeCount += 1;
        if (entry.action.startsWith('role.')) {
          roleChangeCount += 1;
        } else if (entry.action.startsWith('account.')) {
          statusToggleCount += 1;
        } else {
          syncRemediationCount += 1;
        }
      } else if (entry.domain === 'system_config') {
        systemConfigCount += 1;
        if (
          entry.action === 'config.system_updated' ||
          entry.action === 'config.initialized'
        ) {
          runtimePolicyUpdateCount += 1;
        } else {
          preferenceUpdateCount += 1;
        }
      } else {
        systemDataCount += 1;
        if (entry.category === 'share') {
          shareMutationCount += 1;
        }
        if (
          entry.action.endsWith('.deleted') ||
          entry.action.endsWith('_deleted') ||
          entry.action.endsWith('_cleared') ||
          entry.action === 'share.revoked' ||
          entry.action === 'share.purged_expired'
        ) {
          deletionCount += 1;
        }
      }
    }

    const total = Math.max(
      1,
      authHistoryCount + privilegeCount + systemConfigCount + systemDataCount
    );
    const authWidth = Math.round((authHistoryCount / total) * 1000);
    const privWidth = Math.round((privilegeCount / total) * 1000);
    const cfgWidth = Math.round((systemConfigCount / total) * 1000);
    const sysWidth = Math.max(0, 1000 - authWidth - privWidth - cfgWidth);

    return {
      authHistoryCount,
      signInCount,
      signOutCount,
      blockedAuthCount,
      latestLoginIso,
      privilegeCount,
      roleChangeCount,
      statusToggleCount,
      syncRemediationCount,
      systemConfigCount,
      runtimePolicyUpdateCount,
      preferenceUpdateCount,
      systemDataCount,
      shareMutationCount,
      deletionCount,
      criticalOrElevatedCount,
      authWidth,
      privWidth,
      cfgWidth,
      sysWidth,
    };
  }, [logs]);

  const hasActiveFilters =
    domainFilter !== 'all' ||
    categoryFilter !== 'all' ||
    authFilter !== 'all' ||
    userIdFilter !== 'all' ||
    windowFilter !== 'all' ||
    fromDate !== '' ||
    toDate !== '' ||
    elevatedOnly ||
    searchQuery.trim() !== '';

  const handleExportJsonLedger = () => {
    if (visibleLogs.length === 0) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      sortOrder,
      recordCount: visibleLogs.length,
      filters: {
        domain: domainFilter,
        category: categoryFilter,
        authStatus: authFilter,
        userId: userIdFilter,
        windowHours: windowFilter,
        fromDate: fromDate || null,
        toDate: toDate || null,
        elevatedOnly,
        search: searchQuery.trim() || null,
      },
      entries: visibleLogs.map((entry) => ({
        id: entry.id,
        createdAtIso: new Date(entry.createdAt).toISOString(),
        domain: entry.domain,
        severity: entry.severity,
        category: entry.category,
        action: entry.action,
        actor: {
          userId: entry.userId,
          name: entry.actorName || 'Dispatch Member',
          email: entry.actorEmail,
          role: entry.actorRole,
          authStatus: entry.authStatus,
        },
        target: {
          resourceType: entry.resourceType || null,
          resourceId: entry.resourceId || null,
        },
        stateTransition: extractAuditStateTransition(entry),
        summary: entry.summary,
        clientContext: entry.clientContext || 'Studio Web',
        metadata: entry.metadata || {},
      })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `dispatch-activity-audit-${dateStamp}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    onSurfaceNotice(
      `Exported ${visibleLogs.length} timestamp-sorted audit records to JSON.`
    );
  };

  const handleCopyEventJson = async (entry: OwnerActivityLogEntry) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
      setCopiedEventId(entry.id);
      window.setTimeout(() => {
        setCopiedEventId((prev) => (prev === entry.id ? null : prev));
      }, 1800);
    } catch {
      onSurfaceNotice(`Event ID: ${entry.id}`);
    }
  };

  const toggleTimestampSort = () => {
    onSortOrderChange(sortOrder === 'desc' ? 'asc' : 'desc');
  };

  return (
    <section className="space-y-5">
      {/* 4-Pillar Granular Event Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() =>
            onDomainFilterChange(
              domainFilter === 'auth_history' ? 'all' : 'auth_history'
            )
          }
          className={`text-left bg-[#13161C] border rounded-lg p-4 transition-colors cursor-pointer ${
            domainFilter === 'auth_history'
              ? 'border-[#22D3EE]'
              : 'border-[#222833] hover:border-[#22D3EE]/45'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-[#8C96A8]">
            <span>User Login Times &amp; Auth</span>
            <KeyRound className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
            {accountabilityMetrics.authHistoryCount.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-[#8C96A8] font-mono tabular-nums truncate">
            {accountabilityMetrics.signInCount} logins ·{' '}
            {accountabilityMetrics.signOutCount} sign-outs
            {accountabilityMetrics.latestLoginIso
              ? ` · Latest ${formatRelativeAge(accountabilityMetrics.latestLoginIso)}`
              : ''}
          </div>
        </button>

        <button
          type="button"
          onClick={() =>
            onDomainFilterChange(
              domainFilter === 'privilege_modifications'
                ? 'all'
                : 'privilege_modifications'
            )
          }
          className={`text-left bg-[#13161C] border rounded-lg p-4 transition-colors cursor-pointer ${
            domainFilter === 'privilege_modifications'
              ? 'border-[#22D3EE]'
              : 'border-[#222833] hover:border-[#22D3EE]/45'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-[#8C96A8]">
            <span>Privilege Changes</span>
            <ShieldCheck className="w-4 h-4 text-amber-300" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
            {accountabilityMetrics.privilegeCount.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-[#8C96A8] font-mono tabular-nums">
            {accountabilityMetrics.roleChangeCount} role ·{' '}
            {accountabilityMetrics.statusToggleCount} status ·{' '}
            {accountabilityMetrics.syncRemediationCount} sync
          </div>
        </button>

        <button
          type="button"
          onClick={() =>
            onDomainFilterChange(
              domainFilter === 'system_config' ? 'all' : 'system_config'
            )
          }
          className={`text-left bg-[#13161C] border rounded-lg p-4 transition-colors cursor-pointer ${
            domainFilter === 'system_config'
              ? 'border-[#22D3EE]'
              : 'border-[#222833] hover:border-[#22D3EE]/45'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-[#8C96A8]">
            <span>System Configuration Updates</span>
            <Sliders className="w-4 h-4 text-sky-300" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
            {accountabilityMetrics.systemConfigCount.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-[#8C96A8] font-mono tabular-nums">
            {accountabilityMetrics.runtimePolicyUpdateCount} global policies ·{' '}
            {accountabilityMetrics.preferenceUpdateCount} runtime toggles
          </div>
        </button>

        <button
          type="button"
          onClick={() =>
            onDomainFilterChange(
              domainFilter === 'system_data_changes' ? 'all' : 'system_data_changes'
            )
          }
          className={`text-left bg-[#13161C] border rounded-lg p-4 transition-colors cursor-pointer ${
            domainFilter === 'system_data_changes'
              ? 'border-[#22D3EE]'
              : 'border-[#222833] hover:border-[#22D3EE]/45'
          }`}
        >
          <div className="flex items-center justify-between text-xs text-[#8C96A8]">
            <span>Workspace &amp; Share Events</span>
            <Database className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
            {accountabilityMetrics.systemDataCount.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-[#8C96A8] font-mono tabular-nums">
            {accountabilityMetrics.shareMutationCount} shares ·{' '}
            {accountabilityMetrics.deletionCount} removals/purges
          </div>
        </button>
      </div>

      {/* Proportional Event Distribution & Timestamp Sort Posture Bar */}
      <div className="bg-[#13161C] border border-[#222833] rounded-lg px-4 py-3 space-y-2">
        <div className="flex items-center justify-between gap-4 flex-wrap text-xs">
          <div className="flex items-center gap-2 flex-wrap text-[#C7D0DF] font-medium">
            <span>Searchable Activity Stream</span>
            <span className="text-[#6E788A]" aria-hidden="true">
              ·
            </span>
            <span className="font-mono text-[#8C96A8] tabular-nums">
              Showing {visibleLogs.length.toLocaleString()} of {logs.length.toLocaleString()} events
            </span>
            <span className="text-[#6E788A]" aria-hidden="true">
              ·
            </span>
            <span className="font-mono text-[#67E8F9] tabular-nums">
              {sortOrder === 'desc'
                ? 'Sorted by Timestamp (Newest First)'
                : 'Sorted by Timestamp (Oldest First)'}
            </span>
          </div>

          <div className="flex items-center gap-3 flex-wrap text-[11px] font-mono text-[#8C96A8] tabular-nums">
            <span>
              <span className="text-[#67E8F9]">Logins &amp; Auth</span>{' '}
              {accountabilityMetrics.authHistoryCount}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <span className="text-amber-300">Privileges</span>{' '}
              {accountabilityMetrics.privilegeCount}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <span className="text-sky-300">System Config</span>{' '}
              {accountabilityMetrics.systemConfigCount}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <span className="text-emerald-300">Data</span>{' '}
              {accountabilityMetrics.systemDataCount}
            </span>
            {onOpenSystemConfig && (
              <>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={onOpenSystemConfig}
                  className="text-[#67E8F9] hover:underline font-sans font-medium whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Edit System Config
                </button>
              </>
            )}
          </div>
        </div>

        <svg
          viewBox="0 0 1000 8"
          preserveAspectRatio="none"
          className="w-full h-2 rounded overflow-hidden bg-[#1A202C]"
          aria-label="Proportional breakdown of login times, privilege changes, system configuration updates, and workspace data events"
        >
          {accountabilityMetrics.authWidth > 0 && (
            <rect
              x={0}
              y={0}
              width={accountabilityMetrics.authWidth}
              height={8}
              className="fill-[#22D3EE]"
            />
          )}
          {accountabilityMetrics.privWidth > 0 && (
            <rect
              x={accountabilityMetrics.authWidth}
              y={0}
              width={accountabilityMetrics.privWidth}
              height={8}
              className="fill-amber-400"
            />
          )}
          {accountabilityMetrics.cfgWidth > 0 && (
            <rect
              x={accountabilityMetrics.authWidth + accountabilityMetrics.privWidth}
              y={0}
              width={accountabilityMetrics.cfgWidth}
              height={8}
              className="fill-sky-400"
            />
          )}
          {accountabilityMetrics.sysWidth > 0 && (
            <rect
              x={
                accountabilityMetrics.authWidth +
                accountabilityMetrics.privWidth +
                accountabilityMetrics.cfgWidth
              }
              y={0}
              width={accountabilityMetrics.sysWidth}
              height={8}
              className="fill-emerald-400"
            />
          )}
        </svg>
      </div>

      {/* Granular Event Class Segmented Control + Timestamp Sort & Exports */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md overflow-x-auto">
          {(
            [
              { id: 'all', label: 'All Events' },
              { id: 'auth_history', label: 'User Login Times' },
              { id: 'privilege_modifications', label: 'Privilege Changes' },
              { id: 'system_config', label: 'System Config Updates' },
              { id: 'system_data_changes', label: 'Workspace Data' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onDomainFilterChange(item.id)}
              className={`h-7 px-3 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                domainFilter === item.id
                  ? 'bg-[#1C2533] text-[#67E8F9]'
                  : 'text-[#8C96A8] hover:text-[#F5F7FA]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {/* Timestamp Sort Direction Segmented Control */}
          <div
            role="group"
            aria-label="Sort activity log by timestamp"
            className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md"
          >
            <button
              type="button"
              onClick={() => onSortOrderChange('desc')}
              className={`h-7 px-2.5 inline-flex items-center gap-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                sortOrder === 'desc'
                  ? 'bg-[#1C2533] text-[#67E8F9]'
                  : 'text-[#8C96A8] hover:text-[#F5F7FA]'
              }`}
            >
              <ArrowDown className="w-3 h-3" aria-hidden="true" />
              Newest First
            </button>
            <button
              type="button"
              onClick={() => onSortOrderChange('asc')}
              className={`h-7 px-2.5 inline-flex items-center gap-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                sortOrder === 'asc'
                  ? 'bg-[#1C2533] text-[#67E8F9]'
                  : 'text-[#8C96A8] hover:text-[#F5F7FA]'
              }`}
            >
              <ArrowUp className="w-3 h-3" aria-hidden="true" />
              Oldest First
            </button>
          </div>

          {/* Time Window Segmented Control */}
          <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md">
            {(
              [
                { id: 'all', label: 'All Time' },
                { id: 24, label: '24h' },
                { id: 168, label: '7d' },
                { id: 720, label: '30d' },
              ] as const
            ).map((win) => (
              <button
                key={String(win.id)}
                type="button"
                onClick={() => onWindowFilterChange(win.id)}
                className={`h-7 px-2.5 text-xs font-mono font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${
                  windowFilter === win.id
                    ? 'bg-[#1C2533] text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                {win.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setElevatedOnly((prev) => !prev)}
            className={`h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              elevatedOnly
                ? 'bg-[#2A1216] text-[#FCA5A5] border-[#F87171]'
                : 'bg-[#13161C] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5 text-[#F87171]" aria-hidden="true" />
            Elevated ({accountabilityMetrics.criticalOrElevatedCount})
          </button>

          {onCopyFullAuditLog && (
            <div className="inline-flex items-center bg-[#13161C] border border-[#22D3EE]/40 rounded-md p-0.5">
              {onAuditClipboardFormatChange && (
                <div
                  role="group"
                  aria-label="Clipboard audit log format"
                  className="inline-flex items-center pr-1 mr-1 border-r border-[#222833]"
                >
                  {(
                    [
                      { id: 'markdown', label: 'MD' },
                      { id: 'csv', label: 'CSV' },
                    ] as const
                  ).map((fmt) => (
                    <button
                      key={fmt.id}
                      type="button"
                      onClick={() => onAuditClipboardFormatChange(fmt.id)}
                      title={`Format copied audit log as ${
                        fmt.id === 'markdown' ? 'Markdown' : 'CSV'
                      }`}
                      className={`h-7 px-2 text-[11px] font-mono font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        auditClipboardFormat === fmt.id
                          ? 'bg-[#1C2533] text-[#67E8F9]'
                          : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                      }`}
                    >
                      {fmt.label}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                disabled={copyingAuditFormat !== null || logs.length === 0}
                onClick={() => onCopyFullAuditLog(auditClipboardFormat)}
                title={`Copy full activity audit log as ${
                  auditClipboardFormat === 'markdown' ? 'Markdown' : 'CSV'
                } to clipboard`}
                className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45 ${
                  copiedAuditFormat !== null
                    ? 'bg-[#132422] text-[#34D399]'
                    : 'text-[#F5F7FA] hover:bg-[#1C2533]'
                }`}
              >
                {copyingAuditFormat !== null ? (
                  <>
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin text-[#22D3EE]"
                      aria-hidden="true"
                    />
                    Copying...
                  </>
                ) : copiedAuditFormat !== null ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#34D399]" aria-hidden="true" />
                    Copied {copiedAuditFormat === 'markdown' ? 'MD' : 'CSV'}
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    Copy Full Log ({auditClipboardFormat === 'markdown' ? 'MD' : 'CSV'})
                  </>
                )}
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => onExportCsv(visibleLogs)}
            disabled={visibleLogs.length === 0}
            className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 disabled:opacity-45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Export CSV
          </button>

          <button
            type="button"
            onClick={handleExportJsonLedger}
            disabled={visibleLogs.length === 0}
            className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 disabled:opacity-45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileJson className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Export JSON
          </button>
        </div>
      </div>

      {/* Search Input + Quick Query Presets + Actor, Auth Posture, and Date Bounds */}
      <div className="space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 flex-wrap flex-1">
            <div className="relative flex-1 min-w-[260px] max-w-lg">
              <Search
                className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="Search granular activity logs"
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onReload();
                  }
                }}
                placeholder="Search login times, IP address, device, actor email, role changes, or timestamps..."
                className="w-full h-9 pl-8 pr-8 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] placeholder:text-[#6E788A] focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchQueryChange('')}
                  aria-label="Clear search query"
                  className="p-1 text-[#8C96A8] hover:text-[#F5F7FA] absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>

            {/* Actor / User Selector */}
            <select
              aria-label="Filter audit logs by actor account"
              value={userIdFilter === 'all' ? 'all' : String(userIdFilter)}
              onChange={(e) => {
                const val = e.target.value;
                onUserIdFilterChange(val === 'all' ? 'all' : Number(val));
              }}
              className="h-9 px-3 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] focus:outline-none cursor-pointer"
            >
              <option value="all">All Actors &amp; Users</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName ? `${u.displayName} (${u.email})` : u.email}
                </option>
              ))}
            </select>

            {/* Auth Token Posture Selector */}
            <select
              aria-label="Filter audit logs by authentication posture"
              value={authFilter}
              onChange={(e) =>
                onAuthFilterChange(
                  e.target.value as 'all' | 'verified' | 'unverified' | 'suspended'
                )
              }
              className="h-9 px-3 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] focus:outline-none cursor-pointer"
            >
              <option value="all">All Auth Postures</option>
              <option value="verified">Verified Token</option>
              <option value="unverified">Unverified Token</option>
              <option value="suspended">Suspended Session</option>
            </select>

            {/* Date Range Bounds */}
            <div className="flex items-center gap-1.5 text-xs text-[#8C96A8]">
              <label htmlFor="audit-from-date" className="whitespace-nowrap">
                From
              </label>
              <input
                id="audit-from-date"
                type="date"
                value={fromDate}
                onChange={(e) => onFromDateChange(e.target.value)}
                className="h-9 px-2.5 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs font-mono text-[#F5F7FA] tabular-nums focus:outline-none"
              />
              <label htmlFor="audit-to-date" className="whitespace-nowrap">
                To
              </label>
              <input
                id="audit-to-date"
                type="date"
                value={toDate}
                onChange={(e) => onToDateChange(e.target.value)}
                className="h-9 px-2.5 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs font-mono text-[#F5F7FA] tabular-nums focus:outline-none"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => {
                  setElevatedOnly(false);
                  onResetFilters();
                }}
                className="h-9 px-3 text-xs text-[#8C96A8] hover:text-[#F5F7FA] border border-[#222833] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
              >
                Reset Filters
              </button>
            )}
            <button
              type="button"
              disabled={isLoading}
              onClick={onReload}
              className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-[#22D3EE]' : ''}`}
                aria-hidden="true"
              />
              Reload Ledger
            </button>
          </div>
        </div>

        {/* Quick Search Shortcuts + Subsystem Category Segmented Control */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md overflow-x-auto">
            {(
              [
                { id: 'all', label: 'All Subsystems' },
                { id: 'auth', label: 'Auth & Logins' },
                { id: 'governance', label: 'Governance & RBAC' },
                { id: 'system_config', label: 'System Config' },
                { id: 'share', label: 'Public Shares' },
                { id: 'mockup', label: 'Site Mockups' },
                { id: 'ai_desk', label: 'AI Desk' },
                { id: 'media_lab', label: 'Media Lab' },
                { id: 'spatial', label: 'Spatial & Map' },
              ] as const
            ).map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => onCategoryFilterChange(cat.id)}
                className={`h-7 px-3 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  categoryFilter === cat.id
                    ? 'bg-[#1C2533] text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto text-[11px]">
            <span className="text-[#6E788A] whitespace-nowrap shrink-0">Quick search:</span>
            {[
              { label: 'auth.sign_in', query: 'auth.sign_in' },
              { label: 'role.updated', query: 'role.' },
              { label: 'config.', query: 'config.' },
              { label: 'adaptiveQuality', query: 'adaptiveQuality' },
              { label: 'share.', query: 'share.' },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() =>
                  onSearchQueryChange(
                    searchQuery.trim() === preset.query ? '' : preset.query
                  )
                }
                className={`h-6 px-2 font-mono rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  searchQuery.trim() === preset.query
                    ? 'bg-[#1C2533] text-[#67E8F9] border-[#22D3EE]/50'
                    : 'bg-[#13161C] text-[#8C96A8] hover:text-[#F5F7FA] border-[#222833]'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* High-Density Timestamp-Sorted Activity Log Table with Forensic Row Expansion */}
      <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                <th
                  className="py-3 px-4"
                  aria-sort={sortOrder === 'desc' ? 'descending' : 'ascending'}
                >
                  <button
                    type="button"
                    onClick={toggleTimestampSort}
                    className="inline-flex items-center gap-1.5 text-left font-medium text-[#D5DCE6] hover:text-[#67E8F9] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    title="Toggle chronological sort order"
                  >
                    <span>Timestamp</span>
                    {sortOrder === 'desc' ? (
                      <ArrowDown className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    ) : (
                      <ArrowUp className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                    )}
                    <ArrowUpDown className="w-3 h-3 text-[#6E788A]" aria-hidden="true" />
                  </button>
                </th>
                <th className="py-3 px-4">Actor &amp; Login Posture</th>
                <th className="py-3 px-4">Event Class</th>
                <th className="py-3 px-4">Granular Event &amp; State Diff</th>
                <th className="py-3 px-4">Resource &amp; Device / IP</th>
                <th className="py-3 px-4 text-right">Forensics</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1C212C] text-xs">
              {isLoading && visibleLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-[#8C96A8]">
                    Loading timestamp-sorted login times, privilege changes, and system configuration logs...
                  </td>
                </tr>
              ) : visibleLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-[#8C96A8] space-y-2">
                    <div>
                      No activity records match the active search query or timestamp filters.
                    </div>
                    {hasActiveFilters && (
                      <button
                        type="button"
                        onClick={() => {
                          setElevatedOnly(false);
                          onResetFilters();
                        }}
                        className="h-8 px-3 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 rounded whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Clear All Filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                visibleLogs.map((entry) => {
                  const isExpanded = expandedLogId === entry.id;
                  const stateDiff = extractAuditStateTransition(entry);
                  const meta = entry.metadata || {};
                  const configDiffList = extractConfigChangesList(meta);
                  const metaEntries = Object.entries(meta).filter(
                    ([k]) => k !== 'changes' && k !== 'nextConfig'
                  );
                  const sessionNum =
                    entry.domain === 'auth_history' &&
                    typeof meta.loginCount === 'number'
                      ? meta.loginCount
                      : null;

                  return (
                    <Fragment key={entry.id}>
                      <tr
                        className={`transition-colors ${
                          isExpanded ? 'bg-[#18212E]/75' : 'hover:bg-[#171B23]'
                        }`}
                      >
                        {/* Timestamp (Sorted Primary Key) */}
                        <td className="py-3 px-4 font-mono text-[11px] text-[#9BA6B8] tabular-nums whitespace-nowrap">
                          <div className="text-[#F5F7FA] font-medium">
                            {formatDateTime(entry.createdAt)}
                          </div>
                          <div className="text-[#6E788A]">
                            {formatUtcTime(entry.createdAt)} ·{' '}
                            {formatRelativeAge(entry.createdAt)}
                          </div>
                        </td>

                        {/* Actor & Login Posture */}
                        <td className="py-3 px-4 whitespace-nowrap">
                          {entry.userId ? (
                            <button
                              type="button"
                              onClick={() => onUserIdFilterChange(entry.userId as number)}
                              className="text-left group cursor-pointer"
                              title="Filter activity log to this actor"
                            >
                              <div className="font-medium text-[#F5F7FA] group-hover:text-[#67E8F9] truncate max-w-[195px]">
                                {highlightQueryMatch(
                                  entry.actorName || entry.actorEmail,
                                  searchQuery
                                )}
                              </div>
                              <div className="text-[11px] font-mono text-[#8C96A8] truncate max-w-[220px]">
                                {highlightQueryMatch(entry.actorEmail, searchQuery)} ·{' '}
                                {formatRoleLabel(entry.actorRole)}
                              </div>
                            </button>
                          ) : (
                            <div>
                              <div className="font-medium text-[#F5F7FA]">
                                {highlightQueryMatch(
                                  entry.actorName || entry.actorEmail,
                                  searchQuery
                                )}
                              </div>
                              <div className="text-[11px] font-mono text-[#8C96A8]">
                                {formatRoleLabel(entry.actorRole)}
                              </div>
                            </div>
                          )}

                          <div className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                            {entry.authStatus === 'suspended' ? (
                              <span className="inline-flex items-center gap-1 text-[#FCA5A5]">
                                <ShieldAlert className="w-3 h-3 shrink-0" aria-hidden="true" />
                                Suspended
                              </span>
                            ) : entry.authStatus === 'unverified' ? (
                              <span className="inline-flex items-center gap-1 text-amber-300">
                                <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                                Unverified
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[#8C96A8]">
                                <CheckCircle2
                                  className="w-3 h-3 text-[#16A34A] shrink-0"
                                  aria-hidden="true"
                                />
                                Verified
                              </span>
                            )}
                            {sessionNum !== null && (
                              <>
                                <span className="text-[#6E788A]" aria-hidden="true">
                                  ·
                                </span>
                                <span className="font-mono text-[#9BA6B8] tabular-nums">
                                  Session #{sessionNum}
                                </span>
                              </>
                            )}
                          </div>
                        </td>

                        {/* Event Class & Severity */}
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div
                            className={`font-medium ${
                              entry.domain === 'privilege_modifications'
                                ? 'text-amber-300'
                                : entry.domain === 'system_config'
                                  ? 'text-sky-300'
                                  : entry.domain === 'auth_history'
                                    ? 'text-[#67E8F9]'
                                    : 'text-emerald-300'
                            }`}
                          >
                            {DOMAIN_LABELS[entry.domain] || 'Workspace Data Event'}
                          </div>
                          <div className="text-[11px] font-mono text-[#8C96A8]">
                            {CATEGORY_LABELS[entry.category] || entry.category} ·{' '}
                            <span
                              className={
                                entry.severity === 'critical'
                                  ? 'text-[#FCA5A5]'
                                  : entry.severity === 'elevated'
                                    ? 'text-amber-300'
                                    : 'text-[#8C96A8]'
                              }
                            >
                              {formatSeverityLabel(entry.severity)}
                            </span>
                          </div>
                        </td>

                        {/* Granular Event Summary + Inline State Transition */}
                        <td className="py-3 px-4 max-w-md">
                          <div className="text-[#F5F7FA] leading-snug">
                            {highlightQueryMatch(entry.summary, searchQuery)}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-[11px] font-mono text-[#6E788A]">
                            <span>{highlightQueryMatch(entry.action, searchQuery)}</span>
                            {stateDiff && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="inline-flex items-center gap-1 text-[#67E8F9]">
                                  <span>{stateDiff.before}</span>
                                  <ArrowRight className="w-3 h-3" aria-hidden="true" />
                                  <span>{stateDiff.after}</span>
                                </span>
                              </>
                            )}
                          </div>
                        </td>

                        {/* Target Resource & Device / IP Context */}
                        <td className="py-3 px-4 whitespace-nowrap font-mono text-[11px]">
                          <div className="text-[#D5DCE6] tabular-nums">
                            {entry.resourceType
                              ? `${entry.resourceType}${entry.resourceId ? ` · #${entry.resourceId}` : ''}`
                              : 'workspace'}
                          </div>
                          <div className="text-[#9BA6B8] truncate max-w-[235px] tabular-nums">
                            {highlightQueryMatch(
                              entry.clientContext || 'Studio Web',
                              searchQuery
                            )}
                          </div>
                        </td>

                        {/* Expand Forensic Details */}
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedLogId((prev) =>
                                prev === entry.id ? null : entry.id
                              )
                            }
                            className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                              isExpanded
                                ? 'bg-[#22D3EE] text-[#071318] border-[#22D3EE] font-semibold'
                                : 'bg-[#0E1116] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#2A3342] hover:border-[#22D3EE]/45'
                            }`}
                          >
                            {isExpanded ? (
                              <>
                                Hide
                                <ChevronUp className="w-3 h-3" aria-hidden="true" />
                              </>
                            ) : (
                              <>
                                Inspect
                                <ChevronDown className="w-3 h-3" aria-hidden="true" />
                              </>
                            )}
                          </button>
                        </td>
                      </tr>

                      {/* Forensic Event Drawer Row */}
                      {isExpanded && (
                        <tr className="bg-[#0F131A]">
                          <td colSpan={6} className="px-5 py-4 border-t border-[#1F2532]">
                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                              {/* Left: Timestamp Precision, Actor & Execution Context */}
                              <div className="lg:col-span-5 space-y-2 text-xs divide-y divide-[#1C212C]">
                                <div className="pb-2 flex items-center justify-between gap-3">
                                  <span className="font-semibold text-[#F5F7FA]">
                                    Forensic Event Record
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => void handleCopyEventJson(entry)}
                                    className="inline-flex items-center gap-1 text-[11px] font-mono text-[#67E8F9] hover:underline cursor-pointer whitespace-nowrap shrink-0"
                                  >
                                    {copiedEventId === entry.id ? (
                                      <>
                                        <Check className="w-3 h-3 text-emerald-400" />
                                        Copied JSON
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="w-3 h-3" />
                                        Copy Event JSON
                                      </>
                                    )}
                                  </button>
                                </div>

                                <div className="py-1.5 flex items-center justify-between gap-3">
                                  <span className="text-[#8C96A8]">Event Identifier</span>
                                  <span className="font-mono text-[#F5F7FA] tabular-nums">
                                    {entry.id}
                                  </span>
                                </div>

                                <div className="py-1.5 flex items-center justify-between gap-3">
                                  <span className="text-[#8C96A8]">UTC ISO Timestamp</span>
                                  <span className="font-mono text-[#D5DCE6] tabular-nums">
                                    {new Date(entry.createdAt).toISOString()}
                                  </span>
                                </div>

                                {typeof meta.tokenIssuedAtIso === 'string' && (
                                  <div className="py-1.5 flex items-center justify-between gap-3">
                                    <span className="text-[#8C96A8]">ID Token Auth Time</span>
                                    <span className="font-mono text-[#67E8F9] tabular-nums">
                                      {meta.tokenIssuedAtIso}
                                    </span>
                                  </div>
                                )}

                                <div className="py-1.5 flex items-center justify-between gap-3">
                                  <span className="text-[#8C96A8]">Actor Identity</span>
                                  <span className="font-mono text-[#F5F7FA] text-right">
                                    {entry.actorEmail}
                                    {entry.userId ? ` (ID #${entry.userId})` : ''}
                                  </span>
                                </div>

                                <div className="py-1.5 flex items-center justify-between gap-3">
                                  <span className="text-[#8C96A8]">Role &amp; Token Posture</span>
                                  <span className="text-[#D5DCE6]">
                                    {formatRoleLabel(entry.actorRole)} · {entry.authStatus}
                                  </span>
                                </div>

                                <div className="pt-1.5 flex items-center justify-between gap-3">
                                  <span className="text-[#8C96A8]">Session Device &amp; IP</span>
                                  <span className="font-mono text-[#C7D0DF] tabular-nums text-right">
                                    {entry.clientContext || 'Studio Web'}
                                  </span>
                                </div>
                              </div>

                              {/* Right: State Transition Diff & Structured Metadata */}
                              <div className="lg:col-span-7 border-t lg:border-t-0 lg:border-l border-[#1F2532] pt-4 lg:pt-0 lg:pl-6 space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-xs font-semibold text-[#F5F7FA]">
                                    Target Resource &amp; Change Payload
                                  </span>
                                  <span className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
                                    {entry.resourceType || 'system'}
                                    {entry.resourceId ? ` · #${entry.resourceId}` : ''}
                                  </span>
                                </div>

                                {configDiffList.length > 0 ? (
                                  <div className="divide-y divide-[#1C212C] border border-[#243042] rounded-md bg-[#131923] px-3.5 py-2">
                                    {configDiffList.map((diffItem) => (
                                      <div
                                        key={diffItem.key}
                                        className="py-1.5 flex items-center justify-between gap-3 flex-wrap text-xs"
                                      >
                                        <div>
                                          <span className="text-[#D5DCE6]">
                                            {diffItem.label}
                                          </span>{' '}
                                          <span className="font-mono text-[11px] text-[#6E788A]">
                                            ({diffItem.key})
                                          </span>
                                        </div>
                                        <div className="inline-flex items-center gap-2 font-mono text-[#F5F7FA] tabular-nums">
                                          <span className="text-[#9BA6B8]">
                                            {String(diffItem.before)}
                                          </span>
                                          <ArrowRight
                                            className="w-3.5 h-3.5 text-[#22D3EE]"
                                            aria-hidden="true"
                                          />
                                          <span className="text-[#67E8F9] font-semibold">
                                            {String(diffItem.after)}
                                          </span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  stateDiff && (
                                    <div className="px-3.5 py-2.5 bg-[#131923] border border-[#243042] rounded-md flex items-center justify-between gap-3 flex-wrap text-xs">
                                      <span className="text-[#8C96A8]">{stateDiff.label}</span>
                                      <div className="inline-flex items-center gap-2 font-mono text-[#F5F7FA] tabular-nums">
                                        <span className="text-[#9BA6B8]">
                                          {stateDiff.before}
                                        </span>
                                        <ArrowRight
                                          className="w-3.5 h-3.5 text-[#22D3EE]"
                                          aria-hidden="true"
                                        />
                                        <span className="text-[#67E8F9] font-semibold">
                                          {stateDiff.after}
                                        </span>
                                      </div>
                                    </div>
                                  )
                                )}

                                {metaEntries.length === 0 ? (
                                  <p className="text-xs text-[#8C96A8]">
                                    No additional structured metadata attributes recorded for this event.
                                  </p>
                                ) : (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                                    {metaEntries.map(([key, value]) => (
                                      <div
                                        key={key}
                                        className="py-1 border-b border-[#1C212C] flex items-center justify-between gap-3"
                                      >
                                        <span className="font-mono text-[11px] text-[#8C96A8]">
                                          {key}
                                        </span>
                                        <span className="font-mono text-[11px] text-[#E2E8F0] tabular-nums truncate max-w-[220px]">
                                          {formatMetadataValue(value)}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
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
