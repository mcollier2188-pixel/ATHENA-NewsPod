import { useCallback, useEffect, useMemo, useState } from 'react';
import { reload } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowRightLeft,
  Ban,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileSearch,
  FileText,
  HardDrive,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Trash2,
  UserCheck,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import type { ActiveView } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { auth } from '../lib/firebase';
import {
  clearFirestoreLinkedAuthState,
  fetchFirestoreUserProfilesMap,
  PRINCIPAL_OWNER_EMAIL,
  syncCallerFirestoreProfile,
  upsertFirestoreProfileAsPrincipalOwner,
  type FirestoreUserProfileDoc,
} from '../services/firestoreUserProfile';
import {
  extendOwnerShare,
  fetchOwnerAuditLogs,
  fetchOwnerOverview,
  fetchOwnerUserAuditDetail,
  forceLogoutOwnerUser,
  logOwnerFirestoreRepairSync,
  purgeExpiredOwnerShares,
  revokeOwnerShare,
  runOwnerRepairAuth,
  SUITE_CHAT_MODELS,
  updateOwnerSystemConfig,
  updateOwnerUserRole,
  updateOwnerUserStatus,
  type AuditLogCategory,
  type OwnerActivityLogEntry,
  type OwnerAuditedShare,
  type OwnerAuditedUser,
  type OwnerOverviewResponse,
  type StudioSystemConfig,
  type SuiteChatModelId,
} from '../services/suiteApi';
import {
  AdminAuditLogPanel,
  extractAuditStateTransition,
  type AuditDomainFilter,
  type AuditSortOrder,
  type AuditWindowFilter,
} from './AdminAuditLogPanel';
import {
  removePublicShareFromFirestore,
  updateFirestorePublicShareExpiry,
} from '../services/firestorePublicShares';
import { ProfileRepairUtility } from './ProfileRepairUtility';
import { ShareSecurityScannerPanel } from './ShareSecurityScannerPanel';
import { SyncAuthDashboard } from './SyncAuthDashboard';
import {
  UserPrivilegeAuditDashboard,
  type PrivilegeMutationPayload,
} from './UserPrivilegeAuditDashboard';
import {
  formatAuditLogsAsCsv,
  formatAuditLogsAsMarkdown,
  type AuditClipboardFormat,
} from '../utils/auditLogClipboardFormat';
import { copyTextToClipboard } from '../utils/clipboard';

interface OwnerConsoleViewProps {
  onNavigateView: (view: ActiveView) => void;
  onPreviewSharedBriefing: (shareId: string) => void;
  onPreviewSharedMockup: (shareId: string) => void;
}

type ConsoleTab =
  | 'share_security'
  | 'users'
  | 'profile_repair'
  | 'privileges'
  | 'sync_auth'
  | 'activity'
  | 'shares'
  | 'overview';
type AuthPostureFilter =
  | 'all'
  | 'verified'
  | 'active_24h'
  | 'unusual'
  | 'revoked'
  | 'unverified'
  | 'suspended';

interface CombinedRepairRow {
  userId: number;
  uid: string;
  email: string;
  displayName: string;
  authProvider: string;
  emailVerified: boolean;
  isActiveCaller: boolean;
  storedSqlRole: string;
  expectedRole: 'owner' | 'admin' | 'member';
  expectedIsOwner: boolean;
  expectedAccountStatus: 'active' | 'suspended';
  firestoreProfile: FirestoreUserProfileDoc | null;
  firestoreChecked: boolean;
  ownershipMisflagged: boolean;
  issues: string[];
}

const CATEGORY_LABELS: Record<AuditLogCategory, string> = {
  auth: 'Authentication',
  governance: 'Governance',
  system_config: 'System Configuration',
  ai_desk: 'AI Desk',
  media_lab: 'Media Lab',
  mockup: 'Site Mockup',
  spatial: 'Spatial & Map',
  share: 'Public Shares',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
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

function formatRemainingWindow(expiresAtIso: string): string {
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 'Expired';
  const totalHours = Math.floor(diffMs / (3600 * 1000));
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  if (days >= 1) return `${days}d ${remHours}h left`;
  const mins = Math.max(1, Math.floor((diffMs % (3600 * 1000)) / 60000));
  return totalHours > 0 ? `${totalHours}h ${mins}m left` : `${mins}m left`;
}

function formatProviderName(provider: string): string {
  const clean = (provider || 'google.com').toLowerCase();
  if (clean.includes('google')) return 'Google OAuth';
  if (clean.includes('password')) return 'Email';
  return provider || 'Google OAuth';
}

function formatRoleLabel(role: 'owner' | 'admin' | 'member' | 'guest'): string {
  if (role === 'owner') return 'Ultra Owner';
  if (role === 'admin') return 'Studio Admin';
  if (role === 'guest') return 'Guest';
  return 'Member';
}

function formatSessionLabel(sessionState: OwnerAuditedUser['sessionState']): string {
  switch (sessionState) {
    case 'suspended':
      return 'Access suspended';
    case 'revoked':
      return 'Session revoked';
    case 'active_now':
      return 'Active now';
    case 'recent_24h':
      return 'Active in 24h';
    default:
      return 'Idle';
  }
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function OwnerConsoleView({
  onNavigateView,
  onPreviewSharedBriefing,
  onPreviewSharedMockup,
}: OwnerConsoleViewProps) {
  const {
    user,
    role,
    accountStatus,
    isOwner,
    isAdminOrOwner,
    isLoading: authLoading,
    signInWithGoogle,
    getIdToken,
    refreshProfileRole,
    repairCurrentAuthSession,
  } = useAuth();

  const [activeTab, setActiveTab] = useState<ConsoleTab>('share_security');
  const [flaggedShareCount, setFlaggedShareCount] = useState(0);
  const [missingProfileCount, setMissingProfileCount] = useState(0);
  const [syncAuthDiscrepancyCount, setSyncAuthDiscrepancyCount] = useState(0);
  const [overview, setOverview] = useState<OwnerOverviewResponse | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  // Repair Auth diagnostic & re-sync state
  const [showRepairPanel, setShowRepairPanel] = useState(false);
  const [repairRows, setRepairRows] = useState<CombinedRepairRow[]>([]);
  const [isScanningAuth, setIsScanningAuth] = useState(false);
  const [isRepairingAuth, setIsRepairingAuth] = useState(false);
  const [repairingTargetId, setRepairingTargetId] = useState<number | null>(null);
  const [lastRepairScanAt, setLastRepairScanAt] = useState<string | null>(null);
  const [isGateRepairing, setIsGateRepairing] = useState(false);
  const [gateRepairMessage, setGateRepairMessage] = useState<string | null>(null);

  // User Audit & Auth Status filters + inspector state
  const [userQuery, setUserQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'owner' | 'admin' | 'member'>('all');
  const [authPostureFilter, setAuthPostureFilter] = useState<AuthPostureFilter>('all');
  const [updatingUserId, setUpdatingUserId] = useState<number | null>(null);
  const [updatingStatusUserId, setUpdatingStatusUserId] = useState<number | null>(null);
  const [forcingLogoutUserId, setForcingLogoutUserId] = useState<number | null>(null);
  const [inspectedUserId, setInspectedUserId] = useState<number | null>(null);
  const [inspectedDetail, setInspectedDetail] = useState<{
    user: OwnerAuditedUser;
    logs: OwnerActivityLogEntry[];
  } | null>(null);
  const [isLoadingInspector, setIsLoadingInspector] = useState(false);
  const [copiedUidId, setCopiedUidId] = useState<number | null>(null);

  // Searchable Activity Log state (sorted by timestamp)
  const [activityLogs, setActivityLogs] = useState<OwnerActivityLogEntry[]>([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logSearch, setLogSearch] = useState('');
  const [logDomainFilter, setLogDomainFilter] = useState<AuditDomainFilter>('all');
  const [logCategoryFilter, setLogCategoryFilter] = useState<'all' | AuditLogCategory>('all');
  const [logAuthFilter, setLogAuthFilter] = useState<
    'all' | 'verified' | 'unverified' | 'suspended'
  >('all');
  const [logUserIdFilter, setLogUserIdFilter] = useState<number | 'all'>('all');
  const [logWindowFilter, setLogWindowFilter] = useState<AuditWindowFilter>('all');
  const [logSortOrder, setLogSortOrder] = useState<AuditSortOrder>('desc');
  const [logFromDate, setLogFromDate] = useState('');
  const [logToDate, setLogToDate] = useState('');
  const [auditClipboardFormat, setAuditClipboardFormat] =
    useState<AuditClipboardFormat>('markdown');
  const [copyingAuditFormat, setCopyingAuditFormat] =
    useState<AuditClipboardFormat | null>(null);
  const [copiedAuditFormat, setCopiedAuditFormat] =
    useState<AuditClipboardFormat | null>(null);

  // Studio System Configuration governance state
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [configDraft, setConfigDraft] = useState<{
    defaultShareTtlHours: 24 | 72 | 168;
    defaultChatModel: SuiteChatModelId;
    adaptiveQualityDefault: boolean;
    requireVerifiedEmailForShares: boolean;
    auditRetentionDays: 90 | 180 | 365;
  }>({
    defaultShareTtlHours: 72,
    defaultChatModel: 'gemini-3.5-flash-lite',
    adaptiveQualityDefault: true,
    requireVerifiedEmailForShares: true,
    auditRetentionDays: 180,
  });
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // Share Governance filters & actions
  const [shareQuery, setShareQuery] = useState('');
  const [shareKindFilter, setShareKindFilter] = useState<'all' | 'briefing' | 'mockup'>('all');
  const [busyShareKey, setBusyShareKey] = useState<string | null>(null);
  const [isPurging, setIsPurging] = useState(false);
  const [copiedShareKey, setCopiedShareKey] = useState<string | null>(null);

  const syncConfigDraftFromServer = useCallback((cfg?: StudioSystemConfig | null) => {
    if (!cfg) return;
    setConfigDraft({
      defaultShareTtlHours: cfg.defaultShareTtlHours,
      defaultChatModel: cfg.defaultChatModel,
      adaptiveQualityDefault: cfg.adaptiveQualityDefault,
      requireVerifiedEmailForShares: cfg.requireVerifiedEmailForShares,
      auditRetentionDays: cfg.auditRetentionDays,
    });
  }, []);

  const loadConsoleData = useCallback(async () => {
    if (!user) return;
    setError(null);
    setIsLoadingData(true);
    try {
      const token = await getIdToken();
      if (!token) {
        throw new Error('Could not obtain a valid authentication token. Try signing in again.');
      }
      const data = await fetchOwnerOverview(token);
      setOverview(data);
      setActivityLogs(data.recentLogs ?? []);
      syncConfigDraftFromServer(data.systemConfig);
      setLastRefreshedAt(new Date().toISOString());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load Owner Console data.'
      );
    } finally {
      setIsLoadingData(false);
    }
  }, [getIdToken, syncConfigDraftFromServer, user]);

  useEffect(() => {
    if (!user || !isAdminOrOwner) return;
    void loadConsoleData();
  }, [user, isAdminOrOwner, loadConsoleData]);

  const loadFilteredLogs = useCallback(
    async (overrides?: {
      userId?: number | 'all';
      domain?: AuditDomainFilter;
      category?: 'all' | AuditLogCategory;
      authStatus?: 'all' | 'verified' | 'unverified' | 'suspended';
      windowHours?: AuditWindowFilter;
      sortOrder?: AuditSortOrder;
      fromDate?: string;
      toDate?: string;
      search?: string;
    }) => {
      if (!user) return;
      setIsLoadingLogs(true);
      setError(null);
      try {
        const token = await getIdToken();
        if (!token) throw new Error('Authentication session expired.');
        const effectiveUserId = overrides?.userId ?? logUserIdFilter;
        const effectiveDomain = overrides?.domain ?? logDomainFilter;
        const effectiveCategory = overrides?.category ?? logCategoryFilter;
        const effectiveAuth = overrides?.authStatus ?? logAuthFilter;
        const effectiveWindow = overrides?.windowHours ?? logWindowFilter;
        const effectiveSort = overrides?.sortOrder ?? logSortOrder;
        const effectiveFrom = overrides?.fromDate ?? logFromDate;
        const effectiveTo = overrides?.toDate ?? logToDate;
        const effectiveSearch = overrides?.search ?? logSearch;

        const rows = await fetchOwnerAuditLogs(token, {
          userId: effectiveUserId === 'all' ? null : effectiveUserId,
          domain: effectiveDomain,
          category: effectiveCategory,
          authStatus: effectiveAuth,
          windowHours: effectiveWindow === 'all' ? null : effectiveWindow,
          fromIso: effectiveFrom ? `${effectiveFrom}T00:00:00.000Z` : null,
          toIso: effectiveTo ? `${effectiveTo}T23:59:59.999Z` : null,
          sortOrder: effectiveSort,
          search: effectiveSearch,
          limit: 250,
        });
        setActivityLogs(rows);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not load administrative audit logs.'
        );
      } finally {
        setIsLoadingLogs(false);
      }
    },
    [
      getIdToken,
      logAuthFilter,
      logCategoryFilter,
      logDomainFilter,
      logFromDate,
      logSearch,
      logSortOrder,
      logToDate,
      logUserIdFilter,
      logWindowFilter,
      user,
    ]
  );

  useEffect(() => {
    if (activeTab !== 'activity' || !user || !isAdminOrOwner) return;
    void loadFilteredLogs();
  }, [
    activeTab,
    isAdminOrOwner,
    loadFilteredLogs,
    logAuthFilter,
    logCategoryFilter,
    logDomainFilter,
    logFromDate,
    logSortOrder,
    logToDate,
    logUserIdFilter,
    logWindowFilter,
    user,
  ]);

  const handleInspectUser = useCallback(
    async (targetUserId: number) => {
      if (inspectedUserId === targetUserId) {
        setInspectedUserId(null);
        setInspectedDetail(null);
        return;
      }
      setInspectedUserId(targetUserId);
      setIsLoadingInspector(true);
      setError(null);
      try {
        const token = await getIdToken();
        if (!token) throw new Error('Authentication session expired.');
        const detail = await fetchOwnerUserAuditDetail(token, targetUserId);
        setInspectedDetail(detail);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not load user audit details.'
        );
      } finally {
        setIsLoadingInspector(false);
      }
    },
    [getIdToken, inspectedUserId]
  );

  const filteredUsers = useMemo<OwnerAuditedUser[]>(() => {
    const list = overview?.users ?? [];
    const q = userQuery.trim().toLowerCase();
    return list.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (authPostureFilter === 'verified' && !u.emailVerified) return false;
      if (authPostureFilter === 'unverified' && u.emailVerified) return false;
      if (authPostureFilter === 'unusual' && !u.accessPattern?.flagged) {
        return false;
      }
      if (authPostureFilter === 'revoked' && u.sessionState !== 'revoked') {
        return false;
      }
      if (authPostureFilter === 'suspended' && u.accountStatus !== 'suspended') {
        return false;
      }
      if (
        authPostureFilter === 'active_24h' &&
        u.sessionState !== 'active_now' &&
        u.sessionState !== 'recent_24h'
      ) {
        return false;
      }
      if (!q) return true;
      const recentIpsJoined = (u.recentIps ?? []).join(' ').toLowerCase();
      const recentDevicesJoined = (u.recentDevices ?? []).join(' ').toLowerCase();
      const reasonsJoined = (u.accessPattern?.reasons ?? []).join(' ').toLowerCase();
      return (
        u.email.toLowerCase().includes(q) ||
        (u.displayName || '').toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q) ||
        (u.lastSeenIp || '').toLowerCase().includes(q) ||
        (u.lastSeenDevice || '').toLowerCase().includes(q) ||
        recentIpsJoined.includes(q) ||
        recentDevicesJoined.includes(q) ||
        reasonsJoined.includes(q)
      );
    });
  }, [authPostureFilter, overview?.users, roleFilter, userQuery]);

  const displayedLogs = useMemo<OwnerActivityLogEntry[]>(() => {
    const q = logSearch.trim().toLowerCase();
    const nowMs = Date.now();
    const windowMs = logWindowFilter === 'all' ? null : logWindowFilter * 3600 * 1000;
    const fromMs = logFromDate
      ? new Date(`${logFromDate}T00:00:00.000Z`).getTime()
      : null;
    const toMs = logToDate
      ? new Date(`${logToDate}T23:59:59.999Z`).getTime()
      : null;

    const filtered = activityLogs.filter((entry) => {
      if (logUserIdFilter !== 'all' && entry.userId !== logUserIdFilter) return false;
      if (logDomainFilter !== 'all' && entry.domain !== logDomainFilter) return false;
      if (logCategoryFilter !== 'all' && entry.category !== logCategoryFilter) {
        return false;
      }
      if (logAuthFilter !== 'all' && entry.authStatus !== logAuthFilter) return false;
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
      return (
        entry.actorEmail.toLowerCase().includes(q) ||
        entry.actorName.toLowerCase().includes(q) ||
        entry.action.toLowerCase().includes(q) ||
        entry.summary.toLowerCase().includes(q) ||
        entry.resourceType.toLowerCase().includes(q) ||
        entry.resourceId.toLowerCase().includes(q) ||
        entry.clientContext.toLowerCase().includes(q) ||
        metaText.includes(q)
      );
    });

    return [...filtered].sort((a, b) => {
      const diff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (diff !== 0) {
        return logSortOrder === 'asc' ? diff : -diff;
      }
      return logSortOrder === 'asc'
        ? a.id.localeCompare(b.id)
        : b.id.localeCompare(a.id);
    });
  }, [
    activityLogs,
    logAuthFilter,
    logCategoryFilter,
    logDomainFilter,
    logFromDate,
    logSearch,
    logSortOrder,
    logToDate,
    logUserIdFilter,
    logWindowFilter,
  ]);

  const filteredShares = useMemo<OwnerAuditedShare[]>(() => {
    const list = overview?.shares ?? [];
    const q = shareQuery.trim().toLowerCase();
    return list.filter((s) => {
      if (shareKindFilter !== 'all' && s.kind !== shareKindFilter) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.shareId.toLowerCase().includes(q) ||
        s.creatorEmail.toLowerCase().includes(q)
      );
    });
  }, [overview?.shares, shareKindFilter, shareQuery]);

  const executeRepairAuthFlow = useCallback(
    async (mode: 'scan' | 'repair', targetUserId?: number) => {
      if (!auth.currentUser) {
        setError('Active Google Sign-In session is required to run Repair Auth.');
        return;
      }

      setError(null);
      if (mode === 'scan') {
        setIsScanningAuth(true);
      } else {
        setIsRepairingAuth(true);
        if (targetUserId) setRepairingTargetId(targetUserId);
      }

      try {
        // 1. Force reload of live Google Sign-In profile & mint a fresh ID token
        await reload(auth.currentUser);
        const liveUser = auth.currentUser;
        const freshToken = await liveUser.getIdToken(true);

        const isVerifiedPrincipalCaller = Boolean(
          liveUser.emailVerified &&
            liveUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
        );

        // 2. Scan or repair Cloud SQL user records against ownership invariants & Google Sign-In state
        const sqlReport = await runOwnerRepairAuth(freshToken, {
          mode,
          targetUserId,
          displayName: liveUser.displayName || '',
          photoUrl: liveUser.photoURL || '',
        });

        // 3. Read Firestore /userProfiles documents permitted by security rules
        let firestoreMap = await fetchFirestoreUserProfilesMap(
          liveUser,
          isVerifiedPrincipalCaller
        );

        const evaluateRowIssues = (
          diag: (typeof sqlReport.users)[number],
          fsDoc: FirestoreUserProfileDoc | undefined
        ) => {
          const firestoreChecked =
            isVerifiedPrincipalCaller || diag.uid === liveUser.uid;
          const fsIssues: string[] = [];
          let ownershipMisflagged =
            (diag.expectedIsOwner && diag.storedRole !== 'owner') ||
            (!diag.expectedIsOwner && diag.storedRole === 'owner');

          if (firestoreChecked) {
            if (!fsDoc) {
              fsIssues.push('Missing Firestore /userProfiles document');
            } else {
              if (
                diag.expectedIsOwner &&
                (!fsDoc.isOwner ||
                  fsDoc.role !== 'owner' ||
                  fsDoc.accountStatus !== 'active')
              ) {
                ownershipMisflagged = true;
                fsIssues.push(
                  `Firestore ownership mis-flagged (role=${fsDoc.role}, isOwner=${String(fsDoc.isOwner)}, status=${fsDoc.accountStatus})`
                );
              } else if (
                !diag.expectedIsOwner &&
                (fsDoc.isOwner || fsDoc.role === 'owner')
              ) {
                ownershipMisflagged = true;
                fsIssues.push(
                  `Rogue ownership flag in Firestore (role=${fsDoc.role}, isOwner=${String(fsDoc.isOwner)})`
                );
              } else if (fsDoc.role !== diag.expectedRole) {
                fsIssues.push(
                  `Firestore role "${fsDoc.role}" out of sync with "${diag.expectedRole}"`
                );
              }

              if (fsDoc.accountStatus !== diag.expectedAccountStatus) {
                fsIssues.push(
                  `Firestore status "${fsDoc.accountStatus}" out of sync with "${diag.expectedAccountStatus}"`
                );
              }
              if (fsDoc.email.trim().toLowerCase() !== diag.email.trim().toLowerCase()) {
                fsIssues.push('Firestore email out of sync with Google Sign-In');
              }
              if (fsDoc.emailVerified !== diag.emailVerified) {
                fsIssues.push('Firestore emailVerified flag out of sync');
              }
            }
          }

          return {
            firestoreChecked,
            ownershipMisflagged,
            fsIssues,
          };
        };

        // 4. If mode === 'repair', force re-sync Firestore /userProfiles with Google Sign-In & Cloud SQL
        if (mode === 'repair') {
          let fsCreated = 0;
          let fsUpdated = 0;
          let misflaggedFixed = 0;

          if (isVerifiedPrincipalCaller) {
            for (const diag of sqlReport.users) {
              const existingFs = firestoreMap.get(diag.uid);
              const preCheck = evaluateRowIssues(diag, existingFs);
              const shouldWrite =
                targetUserId !== undefined ||
                diag.uid === liveUser.uid ||
                diag.sqlRepaired ||
                preCheck.fsIssues.length > 0;

              if (!shouldWrite) continue;

              const writeRes = await upsertFirestoreProfileAsPrincipalOwner(
                {
                  uid: diag.uid,
                  email: diag.email,
                  displayName: diag.displayName,
                  photoUrl: diag.photoUrl,
                  authProvider: diag.authProvider,
                  emailVerified: diag.emailVerified,
                  role: diag.expectedRole,
                  accountStatus: diag.expectedAccountStatus,
                },
                liveUser.uid,
                'repair_auth'
              );

              if (writeRes.action === 'created') fsCreated += 1;
              if (writeRes.action === 'updated') fsUpdated += 1;
              if (preCheck.ownershipMisflagged) misflaggedFixed += 1;
            }
          } else {
            const selfSync = await syncCallerFirestoreProfile(
              liveUser,
              {
                role: role === 'admin' ? 'admin' : 'member',
                accountStatus: 'active',
              },
              'repair_auth'
            );
            if (selfSync.synced) fsUpdated += 1;
          }

          await logOwnerFirestoreRepairSync(freshToken, {
            targetUserId,
            firestoreSummary: {
              scanned: sqlReport.users.length,
              created: fsCreated,
              repaired: fsUpdated + sqlReport.repairedCount,
              misflaggedOwners: misflaggedFixed,
            },
          });

          // Re-read Firestore profiles after repair so table shows verified post-sync state
          firestoreMap = await fetchFirestoreUserProfilesMap(
            liveUser,
            isVerifiedPrincipalCaller
          );

          await refreshProfileRole();
          await loadConsoleData();
          if (inspectedUserId !== null) {
            const refreshedDetail = await fetchOwnerUserAuditDetail(
              freshToken,
              inspectedUserId
            );
            setInspectedDetail(refreshedDetail);
          }

          const totalChanges = sqlReport.repairedCount + fsCreated + fsUpdated;
          setNotice(
            totalChanges > 0
              ? `Repair Auth re-synced ${totalChanges} profile ${totalChanges === 1 ? 'record' : 'records'} (${fsCreated} Firestore created, ${fsUpdated} Firestore updated, ${sqlReport.repairedCount} SQL corrected).`
              : 'Repair Auth verified Google Sign-In, Firestore /userProfiles, and Cloud SQL — all privileges are synchronized.'
          );
        }

        const mergedRows: CombinedRepairRow[] = sqlReport.users.map((diag) => {
          const fsDoc = firestoreMap.get(diag.uid) ?? null;
          const check = evaluateRowIssues(diag, fsDoc ?? undefined);
          const remainingSqlIssues = mode === 'repair' ? [] : diag.sqlIssues;
          return {
            userId: diag.userId,
            uid: diag.uid,
            email: diag.email,
            displayName: diag.displayName,
            authProvider: diag.authProvider,
            emailVerified: diag.emailVerified,
            isActiveCaller: diag.uid === liveUser.uid,
            storedSqlRole: mode === 'repair' ? diag.expectedRole : diag.storedRole,
            expectedRole: diag.expectedRole,
            expectedIsOwner: diag.expectedIsOwner,
            expectedAccountStatus: diag.expectedAccountStatus,
            firestoreProfile: fsDoc,
            firestoreChecked: check.firestoreChecked,
            ownershipMisflagged: check.ownershipMisflagged,
            issues: [...remainingSqlIssues, ...check.fsIssues],
          };
        });

        // When repairing a single targetUserId, merge updated row into existing scan list if present
        if (targetUserId && repairRows.length > 1 && mergedRows.length === 1) {
          setRepairRows((prev) =>
            prev.map((row) => (row.userId === targetUserId ? mergedRows[0] : row))
          );
        } else {
          setRepairRows(mergedRows);
        }
        setLastRepairScanAt(new Date().toISOString());
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Repair Auth scan encountered an error.'
        );
      } finally {
        setIsScanningAuth(false);
        setIsRepairingAuth(false);
        setRepairingTargetId(null);
      }
    },
    [inspectedUserId, loadConsoleData, refreshProfileRole, repairRows.length, role]
  );

  const handleToggleRepairPanel = () => {
    const nextOpen = !showRepairPanel;
    setShowRepairPanel(nextOpen);
    if (nextOpen && repairRows.length === 0 && !isScanningAuth) {
      void executeRepairAuthFlow('scan');
    }
  };

  const handleGateSelfRepair = async () => {
    setGateRepairMessage(null);
    setIsGateRepairing(true);
    try {
      const res = await repairCurrentAuthSession();
      if (res.role !== 'owner' && res.role !== 'admin') {
        setGateRepairMessage(
          `Re-synced Google Sign-In and Firestore profile. Current verified role remains "${formatRoleLabel(res.role)}".`
        );
      }
    } catch (err) {
      setGateRepairMessage(
        err instanceof Error ? err.message : 'Could not complete Repair Auth re-sync.'
      );
    } finally {
      setIsGateRepairing(false);
    }
  };

  const handleRoleToggle = async (
    target: OwnerAuditedUser,
    nextRole: 'admin' | 'member'
  ) => {
    setError(null);
    setNotice(null);
    setUpdatingUserId(target.id);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Authentication session expired.');
      const updated = await updateOwnerUserRole(token, target.id, nextRole);
      if (isOwner && user?.emailVerified) {
        await upsertFirestoreProfileAsPrincipalOwner(
          {
            uid: updated.uid,
            email: updated.email,
            displayName: updated.displayName,
            photoUrl: updated.photoUrl,
            authProvider: updated.authProvider,
            emailVerified: updated.emailVerified,
            role: updated.role,
            accountStatus: updated.accountStatus,
          },
          user.uid,
          'admin_governance'
        ).catch(() => {
          // Repair Auth panel can reconcile if Firestore write is transiently offline
        });
      }
      await loadConsoleData();
      if (inspectedUserId === target.id) {
        const refreshedDetail = await fetchOwnerUserAuditDetail(token, target.id);
        setInspectedDetail(refreshedDetail);
      }
      setNotice(
        `Updated ${target.displayName || target.email} to ${
          updated.role === 'admin' ? 'Studio Admin' : 'Member'
        } and synced Firestore profile.`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not update collaborator role.'
      );
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleAccountStatusToggle = async (
    target: OwnerAuditedUser,
    nextStatus: 'active' | 'suspended'
  ) => {
    setError(null);
    setNotice(null);
    setUpdatingStatusUserId(target.id);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Authentication session expired.');
      const updated = await updateOwnerUserStatus(token, target.id, nextStatus);
      if (isOwner && user?.emailVerified) {
        await upsertFirestoreProfileAsPrincipalOwner(
          {
            uid: updated.uid,
            email: updated.email,
            displayName: updated.displayName,
            photoUrl: updated.photoUrl,
            authProvider: updated.authProvider,
            emailVerified: updated.emailVerified,
            role: updated.role,
            accountStatus: updated.accountStatus,
          },
          user.uid,
          'admin_governance'
        ).catch(() => {
          // Repair Auth panel can reconcile if Firestore write is transiently offline
        });
      }
      await loadConsoleData();
      if (inspectedUserId === target.id) {
        const refreshedDetail = await fetchOwnerUserAuditDetail(token, target.id);
        setInspectedDetail(refreshedDetail);
      }
      setNotice(
        `${nextStatus === 'suspended' ? 'Suspended' : 'Reactivated'} access for ${
          target.displayName || target.email
        } and synced Firestore profile.`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not update account status.'
      );
    } finally {
      setUpdatingStatusUserId(null);
    }
  };

  const handleForceLogoutUser = async (
    target: Pick<OwnerAuditedUser, 'id' | 'uid' | 'email' | 'displayName'>
  ) => {
    if (!user) return;
    setError(null);
    setNotice(null);
    setForcingLogoutUserId(target.id);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Authentication session expired.');

      const isPrincipalCaller = Boolean(
        isOwner &&
          user.emailVerified &&
          user.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
      );

      // 1. Clear Firestore-linked auth profile (/userProfiles/{uid}) when Principal Owner executes containment
      const fsClearResult = await clearFirestoreLinkedAuthState(
        target.uid,
        user.uid,
        isPrincipalCaller
      ).catch(() => ({
        cleared: false,
        mode: 'server_revocation_only' as const,
      }));

      // 2. Revoke active server-side session tokens & record governance audit log
      await forceLogoutOwnerUser(token, target.id, {
        firestoreCleared: fsClearResult.cleared,
        reason: 'Force Logout triggered from Owner Console user audit row',
      });

      await loadConsoleData();
      if (inspectedUserId === target.id) {
        const refreshedDetail = await fetchOwnerUserAuditDetail(token, target.id);
        setInspectedDetail(refreshedDetail);
      }
      if (activeTab === 'activity') {
        await loadFilteredLogs();
      }

      setNotice(
        fsClearResult.cleared
          ? `Forced logout for ${target.displayName || target.email}: revoked active sessions and cleared Firestore /userProfiles/${target.uid} auth state.`
          : `Forced logout for ${target.displayName || target.email}: revoked active server sessions and invalidated pre-revocation tokens.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not revoke user session and clear auth state.'
      );
    } finally {
      setForcingLogoutUserId(null);
    }
  };

  const handleMutateUserPrivilege = async (
    target: OwnerAuditedUser,
    mutation: PrivilegeMutationPayload
  ) => {
    setError(null);
    setNotice(null);
    setUpdatingUserId(target.id);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Authentication session expired.');

      let latestProfile = {
        uid: target.uid,
        email: target.email,
        displayName: target.displayName,
        photoUrl: target.photoUrl,
        authProvider: target.authProvider,
        emailVerified: target.emailVerified,
        role: target.role,
        accountStatus: target.accountStatus,
      };
      const changesSummary: string[] = [];

      if (
        mutation.nextStatus &&
        mutation.nextStatus !== target.accountStatus
      ) {
        const updatedStatusProfile = await updateOwnerUserStatus(
          token,
          target.id,
          mutation.nextStatus
        );
        latestProfile = {
          uid: updatedStatusProfile.uid,
          email: updatedStatusProfile.email,
          displayName: updatedStatusProfile.displayName,
          photoUrl: updatedStatusProfile.photoUrl,
          authProvider: updatedStatusProfile.authProvider,
          emailVerified: updatedStatusProfile.emailVerified,
          role: updatedStatusProfile.role,
          accountStatus: updatedStatusProfile.accountStatus,
        };
        changesSummary.push(
          mutation.nextStatus === 'suspended'
            ? 'status → Suspended'
            : 'status → Active'
        );
      }

      if (mutation.nextRole && mutation.nextRole !== target.role) {
        const updatedRoleProfile = await updateOwnerUserRole(
          token,
          target.id,
          mutation.nextRole
        );
        latestProfile = {
          uid: updatedRoleProfile.uid,
          email: updatedRoleProfile.email,
          displayName: updatedRoleProfile.displayName,
          photoUrl: updatedRoleProfile.photoUrl,
          authProvider: updatedRoleProfile.authProvider,
          emailVerified: updatedRoleProfile.emailVerified,
          role: updatedRoleProfile.role,
          accountStatus: updatedRoleProfile.accountStatus,
        };
        changesSummary.push(
          mutation.nextRole === 'admin'
            ? 'role → Studio Admin'
            : 'role → Member'
        );
      }

      if (changesSummary.length === 0) {
        return;
      }

      if (isOwner && user?.emailVerified) {
        await upsertFirestoreProfileAsPrincipalOwner(
          latestProfile,
          user.uid,
          'admin_governance'
        ).catch(() => {
          // Repair Auth panel can reconcile if Firestore write is transiently offline
        });
      }

      await loadConsoleData();
      if (inspectedUserId === target.id) {
        const refreshedDetail = await fetchOwnerUserAuditDetail(
          token,
          target.id
        );
        setInspectedDetail(refreshedDetail);
      }

      setNotice(
        `Updated ${target.displayName || target.email} (${changesSummary.join(', ')}) and synchronized Firestore profile.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not update user privilege or account status.'
      );
    } finally {
      setUpdatingUserId(null);
    }
  };

  const handleCopyUid = async (account: OwnerAuditedUser) => {
    try {
      await navigator.clipboard.writeText(account.uid);
      setCopiedUidId(account.id);
      window.setTimeout(() => {
        setCopiedUidId((prev) => (prev === account.id ? null : prev));
      }, 1800);
    } catch {
      setError(`Clipboard unavailable. UID: ${account.uid}`);
    }
  };

  const handleCopyFullAuditLog = useCallback(
    async (formatOverride?: AuditClipboardFormat) => {
      const targetFormat = formatOverride ?? auditClipboardFormat;
      if (!user || copyingAuditFormat !== null) return;
      setError(null);
      setCopyingAuditFormat(targetFormat);
      try {
        let fullEntries: OwnerActivityLogEntry[] = activityLogs;
        const token = await getIdToken();
        if (token) {
          const fetched = await fetchOwnerAuditLogs(token, {
            sortOrder: logSortOrder,
            limit: 1500,
          }).catch(() => null);
          if (fetched && fetched.length > 0) {
            fullEntries = fetched;
          }
        }

        if (fullEntries.length === 0) {
          setError('No activity audit log records are available to copy yet.');
          return;
        }

        const formattedPayload =
          targetFormat === 'markdown'
            ? formatAuditLogsAsMarkdown(fullEntries, {
                exportedByEmail: user.email || undefined,
                sortOrder: logSortOrder,
                scopeLabel: 'Full Activity Audit Log',
              })
            : formatAuditLogsAsCsv(fullEntries);

        const ok = await copyTextToClipboard(formattedPayload);
        if (!ok) {
          throw new Error(
            'Clipboard access was blocked by the browser. Use Export Audit CSV to save a local file instead.'
          );
        }

        setCopiedAuditFormat(targetFormat);
        window.setTimeout(() => {
          setCopiedAuditFormat((prev) => (prev === targetFormat ? null : prev));
        }, 2400);

        const formatLabel = targetFormat === 'markdown' ? 'Markdown' : 'CSV';
        setNotice(
          `Copied full activity audit log (${fullEntries.length.toLocaleString()} ${
            fullEntries.length === 1 ? 'event' : 'events'
          }) to clipboard as formatted ${formatLabel}.`
        );
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Could not copy full activity audit log to clipboard.'
        );
      } finally {
        setCopyingAuditFormat(null);
      }
    },
    [
      activityLogs,
      auditClipboardFormat,
      copyingAuditFormat,
      getIdToken,
      logSortOrder,
      user,
    ]
  );

  const handleExportAuditCsv = (entriesOverride?: OwnerActivityLogEntry[]) => {
    const targetEntries = entriesOverride ?? displayedLogs;
    if (targetEntries.length === 0) return;
    const csvContent = formatAuditLogsAsCsv(targetEntries);

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `dispatch-admin-audit-${dateStamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setNotice(`Exported ${targetEntries.length} accountability audit entries to CSV.`);
  };

  const handleExportUserSessionsCsv = () => {
    if (filteredUsers.length === 0) return;
    const headers = [
      'Display Name',
      'Email',
      'Firebase UID',
      'Role',
      'Account Status',
      'Email Verified',
      'Auth Provider',
      'Session State',
      'Last Seen (ISO)',
      'Last Sign-In (ISO)',
      'Sign-In Count',
      'Last Seen Device',
      'Last Seen IP',
      'Recent Observed IPs',
      'Recent Observed Devices',
      'Access Pattern Status',
      'Distinct IPs (24h)',
      'Distinct Devices (24h)',
      'Access Pattern Notes',
    ];
    const rows = filteredUsers.map((account) => [
      account.displayName || 'Dispatch Member',
      account.email,
      account.uid,
      account.role,
      account.accountStatus,
      account.emailVerified ? 'verified' : 'unverified',
      formatProviderName(account.authProvider),
      formatSessionLabel(account.sessionState),
      account.lastActiveAt ? new Date(account.lastActiveAt).toISOString() : '',
      account.lastLoginAt ? new Date(account.lastLoginAt).toISOString() : '',
      account.loginCount,
      account.lastSeenDevice || 'Pending client telemetry',
      account.lastSeenIp || 'Pending capture',
      (account.recentIps ?? []).join(' | '),
      (account.recentDevices ?? []).join(' | '),
      account.accessPattern?.label || 'Consistent Posture',
      account.accessPattern?.distinctIps24h ?? 0,
      account.accessPattern?.distinctDevices24h ?? 0,
      (account.accessPattern?.reasons ?? []).join(' | '),
    ]);

    const csvContent = [
      headers.map(escapeCsvCell).join(','),
      ...rows.map((r) => r.map(escapeCsvCell).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `dispatch-user-sessions-${dateStamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setNotice(
      `Exported ${filteredUsers.length} user session telemetry ${
        filteredUsers.length === 1 ? 'record' : 'records'
      } to CSV.`
    );
  };

  const handleJumpToUserLogs = (targetUserId: number) => {
    setLogUserIdFilter(targetUserId);
    setLogDomainFilter('all');
    setLogCategoryFilter('all');
    setLogAuthFilter('all');
    setLogWindowFilter('all');
    setLogFromDate('');
    setLogToDate('');
    setActiveTab('activity');
  };

  const handleSaveSystemConfig = async () => {
    setError(null);
    setNotice(null);
    setIsSavingConfig(true);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Authentication session expired.');
      const res = await updateOwnerSystemConfig(token, configDraft);
      setOverview((prev) =>
        prev ? { ...prev, systemConfig: res.config } : prev
      );
      syncConfigDraftFromServer(res.config);
      await loadConsoleData();
      if (activeTab === 'activity') {
        await loadFilteredLogs();
      }
      if (res.updated) {
        const summaryDiff = res.changes
          .map((c) => `${c.label}: ${String(c.before)} → ${String(c.after)}`)
          .join(' · ');
        setNotice(`Saved studio system configuration (${summaryDiff}).`);
      } else {
        setNotice('Studio system configuration is already up to date.');
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not update studio system configuration.'
      );
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleExtendShare = async (share: OwnerAuditedShare) => {
    const key = `${share.kind}:${share.shareId}`;
    setError(null);
    setNotice(null);
    setBusyShareKey(key);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Authentication session expired.');
      const res = await extendOwnerShare(token, share.kind, share.shareId, 72);
      if (user?.emailVerified) {
        await updateFirestorePublicShareExpiry(
          user,
          share.shareId,
          res.expiresAt,
          72
        ).catch(() => {});
      }
      setOverview((prev) =>
        prev
          ? {
              ...prev,
              shares: prev.shares.map((item) =>
                item.kind === share.kind && item.shareId === share.shareId
                  ? { ...item, expiresAt: res.expiresAt }
                  : item
              ),
            }
          : prev
      );
      setNotice(`Extended "${share.title}" by 72 hours.`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not extend share link.'
      );
    } finally {
      setBusyShareKey(null);
    }
  };

  const handleRevokeShare = async (share: OwnerAuditedShare) => {
    const key = `${share.kind}:${share.shareId}`;
    setError(null);
    setNotice(null);
    setBusyShareKey(key);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Authentication session expired.');
      await revokeOwnerShare(token, share.kind, share.shareId);
      if (user?.emailVerified) {
        await removePublicShareFromFirestore(user, share.shareId).catch(() => {});
      }
      setOverview((prev) => {
        if (!prev) return prev;
        const remaining = prev.shares.filter(
          (item) => !(item.kind === share.kind && item.shareId === share.shareId)
        );
        return {
          ...prev,
          shares: remaining,
          storage: {
            ...prev.storage,
            activeShareCount: remaining.length,
            briefingShareCount: remaining.filter((s) => s.kind === 'briefing').length,
            mockupShareCount: remaining.filter((s) => s.kind === 'mockup').length,
            totalShareBytes: remaining.reduce((sum, s) => sum + s.sizeBytes, 0),
          },
        };
      });
      setNotice(`Revoked public share link "${share.title}".`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not revoke share link.'
      );
    } finally {
      setBusyShareKey(null);
    }
  };

  const handlePurgeExpired = async () => {
    setError(null);
    setNotice(null);
    setIsPurging(true);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('Authentication session expired.');
      const res = await purgeExpiredOwnerShares(token);
      await loadConsoleData();
      setNotice(
        res.purgedCount > 0
          ? `Purged ${res.purgedCount} expired share ${res.purgedCount === 1 ? 'record' : 'records'}.`
          : 'No expired share files were pending cleanup.'
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not purge expired shares.'
      );
    } finally {
      setIsPurging(false);
    }
  };

  const handleCopyShareUrl = async (share: OwnerAuditedShare) => {
    const url = `${window.location.origin}${share.sharePath}`;
    const key = `${share.kind}:${share.shareId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedShareKey(key);
      window.setTimeout(() => {
        setCopiedShareKey((prev) => (prev === key ? null : prev));
      }, 2000);
    } catch {
      setError(`Clipboard blocked. Share URL: ${url}`);
    }
  };

  // 1. Loading Auth State
  if (authLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="inline-flex items-center gap-2.5 text-sm text-[#8C96A8]">
          <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" />
          Verifying administrator credentials...
        </div>
      </div>
    );
  }

  // 2. Signed-Out Entry State
  if (!user) {
    return (
      <div className="min-h-[65vh] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-[#13161C] border border-[#222833] rounded-lg p-6 space-y-4">
          <div className="w-10 h-10 rounded-md bg-[#18212E] border border-[#22D3EE]/35 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-[#22D3EE]" />
          </div>
          <div className="space-y-1.5">
            <h1 className="font-serif text-xl font-medium text-[#F5F7FA]">
              Admin &amp; Owner Sign-In Required
            </h1>
            <p className="text-xs text-[#9BA6B8] leading-relaxed">
              Sign in with a verified Principal Owner or Studio Admin Google account to
              access the user audit dashboard, authentication status records, and share
              governance controls.
            </p>
          </div>
          <div className="flex items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              className="h-10 px-4 inline-flex items-center gap-2 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogIn className="w-4 h-4" />
              Sign in with Google
            </button>
            <button
              type="button"
              onClick={() => onNavigateView('articles')}
              className="h-10 px-4 text-xs font-medium text-[#9BA6B8] hover:text-[#F5F7FA] border border-[#222833] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              Back to Newsroom
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 3. Standard Member or Suspended Account Restricted State (includes Self Repair Auth recovery)
  if (!isAdminOrOwner) {
    return (
      <div className="min-h-[65vh] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-[#13161C] border border-[#2A3342] rounded-lg p-6 space-y-4">
          <div className="w-10 h-10 rounded-md bg-amber-500/10 border border-amber-400/35 flex items-center justify-center">
            <Lock className="w-5 h-5 text-amber-300" />
          </div>
          <div className="space-y-1.5">
            <h1 className="font-serif text-xl font-medium text-[#F5F7FA]">
              Admin Access Required
            </h1>
            <p className="text-xs text-[#9BA6B8] leading-relaxed">
              Signed in as <span className="text-[#F5F7FA] font-mono">{user.email}</span>{' '}
              ({accountStatus === 'suspended' ? 'Account Suspended' : `Role: ${formatRoleLabel(role)}`}).
              If your ownership privileges were mis-flagged, run Repair Auth to force a
              re-sync between your Google Sign-In state and Firestore profile.
            </p>
          </div>

          {gateRepairMessage && (
            <div className="px-3 py-2 bg-[#0F2429] border border-[#22D3EE]/35 rounded text-xs text-[#67E8F9]">
              {gateRepairMessage}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              type="button"
              disabled={isGateRepairing}
              onClick={() => void handleGateSelfRepair()}
              className="h-10 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isGateRepairing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Wrench className="w-3.5 h-3.5" />
              )}
              Repair Auth &amp; Re-Sync
            </button>
            <button
              type="button"
              onClick={() => void refreshProfileRole()}
              className="h-10 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Re-check Access
            </button>
            <button
              type="button"
              onClick={() => onNavigateView('articles')}
              className="h-10 px-3.5 text-xs font-medium text-[#9BA6B8] hover:text-[#F5F7FA] border border-[#222833] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              Return to Studio
            </button>
          </div>
        </div>
      </div>
    );
  }

  const totalCloudRecords = overview
    ? overview.totals.chatMessages +
      overview.totals.transcriptions +
      overview.totals.mediaItems +
      overview.totals.mapPins +
      overview.totals.savedMockups +
      overview.totals.gameRuns
    : 0;

  const adminCount = (overview?.users ?? []).filter(
    (u) =>
      u.accountStatus !== 'suspended' &&
      (u.role === 'owner' || u.role === 'admin')
  ).length;

  const standardRoleCount = (overview?.users ?? []).filter(
    (u) => u.accountStatus !== 'suspended' && u.role === 'member'
  ).length;

  const activeNowCount = (overview?.users ?? []).filter(
    (u) => u.sessionState === 'active_now'
  ).length;

  const active24hCount =
    overview?.totals.activeUsers24h ??
    (overview?.users ?? []).filter(
      (u) => u.sessionState === 'active_now' || u.sessionState === 'recent_24h'
    ).length;

  const unusualSessionCount =
    overview?.totals.unusualSessions ??
    (overview?.users ?? []).filter((u) => u.accessPattern?.flagged).length;

  const revokedSessionCount = (overview?.users ?? []).filter(
    (u) => u.sessionState === 'revoked'
  ).length;

  const distinctObservedIpCount = new Set(
    (overview?.users ?? [])
      .flatMap((u) => [u.lastSeenIp, ...(u.recentIps ?? [])])
      .map((ip) => (ip || '').trim())
      .filter((ip) => ip.length > 0)
  ).size;

  const authAndGovernanceLogCount = (overview?.recentLogs ?? []).filter(
    (l) =>
      l.category === 'auth' ||
      l.category === 'governance' ||
      l.category === 'system_config'
  ).length;

  const isConfigDirty = overview?.systemConfig
    ? configDraft.defaultShareTtlHours !==
        overview.systemConfig.defaultShareTtlHours ||
      configDraft.defaultChatModel !== overview.systemConfig.defaultChatModel ||
      configDraft.adaptiveQualityDefault !==
        overview.systemConfig.adaptiveQualityDefault ||
      configDraft.requireVerifiedEmailForShares !==
        overview.systemConfig.requireVerifiedEmailForShares ||
      configDraft.auditRetentionDays !== overview.systemConfig.auditRetentionDays
    : false;

  const repairIssueRowCount = repairRows.filter((r) => r.issues.length > 0).length;
  const misflaggedOwnerCount = repairRows.filter((r) => r.ownershipMisflagged).length;

  return (
    <div className="max-w-7xl mx-auto px-5 sm:px-7 py-6 space-y-6">
      {/* Console Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-[#1F2532]">
        <div className="space-y-1">
          <h1 className="font-serif text-2xl font-medium text-[#F5F7FA] tracking-tight">
            Owner Console &amp; User Audit
          </h1>
          <div className="flex items-center gap-2 flex-wrap text-xs text-[#8C96A8]">
            <span className="text-[#67E8F9] font-medium">
              {isOwner ? 'Ultra Owner' : 'Studio Admin'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="text-[#D5DCE6] font-mono">{user.email}</span>
            {lastRefreshedAt && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  Synced {formatDateTime(lastRefreshedAt)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('share_security')}
            className={`h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'share_security'
                ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]'
                : flaggedShareCount > 0
                  ? 'bg-[#2A1216] text-[#FCA5A5] border-[#F87171]/50 hover:border-[#F87171]'
                  : 'bg-[#13161C] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            {flaggedShareCount > 0 ? (
              <ShieldAlert className="w-3.5 h-3.5 text-[#F87171]" aria-hidden="true" />
            ) : (
              <FileSearch className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            )}
            {flaggedShareCount > 0
              ? `Share PII Scanner (${flaggedShareCount})`
              : 'Share PII Scanner'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('privileges')}
            className={`h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'privileges'
                ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]'
                : 'bg-[#13161C] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Privilege Management
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('profile_repair')}
            className={`h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'profile_repair'
                ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]'
                : 'bg-[#13161C] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <UserCheck className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            {missingProfileCount > 0
              ? `Profile Repair (${missingProfileCount})`
              : 'Profile Repair'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('sync_auth')}
            className={`h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeTab === 'sync_auth'
                ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]'
                : 'bg-[#13161C] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            {syncAuthDiscrepancyCount > 0
              ? `Sync Auth (${syncAuthDiscrepancyCount})`
              : 'Sync Auth'}
          </button>
          <button
            type="button"
            onClick={handleToggleRepairPanel}
            className={`h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showRepairPanel
                ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]'
                : 'bg-[#13161C] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <Wrench className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Repair Auth
          </button>
          <button
            type="button"
            onClick={() => setShowConfigPanel((prev) => !prev)}
            className={`h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showConfigPanel
                ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]'
                : 'bg-[#13161C] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <Sliders className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            System Config
          </button>
          {/* Copy Full Activity Audit Log (Markdown / CSV) */}
          <div className="inline-flex items-center bg-[#13161C] border border-[#22D3EE]/45 rounded-md p-0.5">
            <div
              role="group"
              aria-label="Audit log clipboard format"
              className="inline-flex items-center pr-1 mr-1 border-r border-[#222833]"
            >
              {(
                [
                  { id: 'markdown', label: 'Markdown' },
                  { id: 'csv', label: 'CSV' },
                ] as const
              ).map((fmt) => (
                <button
                  key={fmt.id}
                  type="button"
                  onClick={() => setAuditClipboardFormat(fmt.id)}
                  className={`h-7 px-2 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    auditClipboardFormat === fmt.id
                      ? 'bg-[#18212E] text-[#67E8F9]'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                  }`}
                >
                  {fmt.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={
                copyingAuditFormat !== null ||
                (activityLogs.length === 0 && (overview?.totals.activityLogs ?? 0) === 0)
              }
              onClick={() => void handleCopyFullAuditLog(auditClipboardFormat)}
              title={`Copy the full activity audit log as a formatted ${
                auditClipboardFormat === 'markdown' ? 'Markdown' : 'CSV'
              } string to the clipboard`}
              className={`h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-45 ${
                copiedAuditFormat !== null
                  ? 'bg-[#132422] text-[#34D399]'
                  : 'text-[#F5F7FA] hover:bg-[#18212E]'
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
                  Copied {copiedAuditFormat === 'markdown' ? 'Markdown' : 'CSV'}
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                  Copy Audit Log
                </>
              )}
            </button>
          </div>

          <button
            type="button"
            onClick={() => handleExportAuditCsv()}
            disabled={displayedLogs.length === 0}
            className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 disabled:opacity-45 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
            Export Audit CSV
          </button>
          <button
            type="button"
            disabled={isLoadingData}
            onClick={() => void loadConsoleData()}
            className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isLoadingData ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            Refresh Audit
          </button>
        </div>
      </div>

      {/* Feedback Alerts */}
      {error && (
        <div
          role="alert"
          className="px-4 py-3 bg-[#2A1216] border border-[#F87171]/40 rounded-md flex items-center justify-between gap-3 text-xs text-[#FCA5A5]"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-[#FCA5A5] hover:text-white font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="px-4 py-2.5 bg-[#0F2429] border border-[#22D3EE]/40 rounded-md flex items-center justify-between gap-3 text-xs text-[#67E8F9]"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-[#8C96A8] hover:text-[#F5F7FA] whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Collapsible Studio System Configuration Governance Panel */}
      {showConfigPanel && (
        <section className="bg-[#13161C] border border-[#22D3EE]/35 rounded-lg p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[#1F2532]">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-[#F5F7FA]">
                  Studio System Configuration &amp; Runtime Policies
                </h2>
              </div>
              <p className="text-xs text-[#8C96A8]">
                Updates persist in Cloud SQL and append a timestamped{' '}
                <span className="font-mono text-[#C7D0DF]">config.system_updated</span>{' '}
                record with before/after diffs to the Searchable Activity Log.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {isConfigDirty && overview?.systemConfig && (
                <button
                  type="button"
                  onClick={() => syncConfigDraftFromServer(overview.systemConfig)}
                  className="h-8 px-3 text-xs text-[#8C96A8] hover:text-[#F5F7FA] border border-[#222833] rounded whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Revert Draft
                </button>
              )}
              <button
                type="button"
                disabled={isSavingConfig || !isConfigDirty}
                onClick={() => void handleSaveSystemConfig()}
                className="h-8 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isSavingConfig && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Save Configuration
              </button>
              <button
                type="button"
                onClick={() => setShowConfigPanel(false)}
                className="h-8 px-2.5 inline-flex items-center gap-1 text-xs text-[#8C96A8] hover:text-[#F5F7FA] border border-[#222833] rounded whitespace-nowrap shrink-0 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                Close
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 text-xs">
            <div className="space-y-1.5">
              <label
                htmlFor="cfg-share-ttl"
                className="block font-medium text-[#C7D0DF]"
              >
                Default Share Link TTL
              </label>
              <select
                id="cfg-share-ttl"
                value={configDraft.defaultShareTtlHours}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    defaultShareTtlHours: Number(e.target.value) as 24 | 72 | 168,
                  }))
                }
                className="w-full h-9 px-3 bg-[#0E1116] border border-[#222833] focus:border-[#22D3EE] rounded-md font-mono text-xs text-[#F5F7FA] tabular-nums focus:outline-none cursor-pointer"
              >
                <option value={24}>24 hours (1 day)</option>
                <option value={72}>72 hours (3 days)</option>
                <option value={168}>168 hours (7 days)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="cfg-chat-model"
                className="block font-medium text-[#C7D0DF]"
              >
                Default AI Desk Model
              </label>
              <select
                id="cfg-chat-model"
                value={configDraft.defaultChatModel}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    defaultChatModel: e.target.value as SuiteChatModelId,
                  }))
                }
                className="w-full h-9 px-3 bg-[#0E1116] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] focus:outline-none cursor-pointer"
              >
                {SUITE_CHAT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.tier})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="cfg-adaptive-3d"
                className="block font-medium text-[#C7D0DF]"
              >
                3D Adaptive Quality Default
              </label>
              <select
                id="cfg-adaptive-3d"
                value={configDraft.adaptiveQualityDefault ? 'enabled' : 'disabled'}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    adaptiveQualityDefault: e.target.value === 'enabled',
                  }))
                }
                className="w-full h-9 px-3 bg-[#0E1116] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] focus:outline-none cursor-pointer"
              >
                <option value="enabled">Enabled (Auto FPS scaling)</option>
                <option value="disabled">Disabled (Manual tier)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="cfg-verified-shares"
                className="block font-medium text-[#C7D0DF]"
              >
                Public Share Verification
              </label>
              <select
                id="cfg-verified-shares"
                value={
                  configDraft.requireVerifiedEmailForShares ? 'required' : 'optional'
                }
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    requireVerifiedEmailForShares: e.target.value === 'required',
                  }))
                }
                className="w-full h-9 px-3 bg-[#0E1116] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] focus:outline-none cursor-pointer"
              >
                <option value="required">Verified Google Email Required</option>
                <option value="optional">Allow Unverified Accounts</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="cfg-audit-retention"
                className="block font-medium text-[#C7D0DF]"
              >
                Audit Retention Window
              </label>
              <select
                id="cfg-audit-retention"
                value={configDraft.auditRetentionDays}
                onChange={(e) =>
                  setConfigDraft((prev) => ({
                    ...prev,
                    auditRetentionDays: Number(e.target.value) as 90 | 180 | 365,
                  }))
                }
                className="w-full h-9 px-3 bg-[#0E1116] border border-[#222833] focus:border-[#22D3EE] rounded-md font-mono text-xs text-[#F5F7FA] tabular-nums focus:outline-none cursor-pointer"
              >
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>365 days</option>
              </select>
            </div>
          </div>

          {overview?.systemConfig && (
            <div className="pt-1 flex items-center justify-between gap-3 flex-wrap text-[11px] font-mono text-[#8C96A8] tabular-nums">
              <span>
                Active revision by {overview.systemConfig.updatedByEmail} ·{' '}
                {formatDateTime(overview.systemConfig.updatedAt)}
              </span>
              <button
                type="button"
                onClick={() => {
                  setLogDomainFilter('system_config');
                  setActiveTab('activity');
                }}
                className="text-[#67E8F9] hover:underline font-sans whitespace-nowrap shrink-0 cursor-pointer"
              >
                Filter Activity Log to System Config Updates
              </button>
            </div>
          )}
        </section>
      )}

      {/* Repair Auth & Profile Synchronization Utility Panel */}
      {showRepairPanel && (
        <section className="bg-[#13161C] border border-[#22D3EE]/35 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-[#1F2532] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Wrench className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-[#F5F7FA]">
                  Repair Auth &amp; Firestore Profile Re-Sync
                </h2>
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs text-[#8C96A8]">
                <span>
                  Scans Google Sign-In tokens, Firestore <span className="font-mono text-[#C7D0DF]">/userProfiles</span>, and Cloud SQL ownership flags
                </span>
                {lastRepairScanAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-[#D5DCE6]">
                      {repairRows.length} scanned · {repairIssueRowCount} out of sync
                      {misflaggedOwnerCount > 0
                        ? ` · ${misflaggedOwnerCount} ownership mis-flagged`
                        : ''}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isScanningAuth || isRepairingAuth}
                onClick={() => void executeRepairAuthFlow('scan')}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-50 rounded whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isScanningAuth ? 'animate-spin text-[#22D3EE]' : ''}`}
                  aria-hidden="true"
                />
                Scan Metadata
              </button>
              <button
                type="button"
                disabled={isScanningAuth || isRepairingAuth}
                onClick={() => void executeRepairAuthFlow('repair')}
                className="h-8 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isRepairingAuth && repairingTargetId === null ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {repairIssueRowCount > 0
                  ? `Repair & Re-Sync (${repairIssueRowCount})`
                  : 'Force Re-Sync All'}
              </button>
              <button
                type="button"
                onClick={() => setShowRepairPanel(false)}
                className="h-8 px-2.5 inline-flex items-center gap-1 text-xs text-[#8C96A8] hover:text-[#F5F7FA] border border-[#222833] rounded whitespace-nowrap shrink-0 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                Close
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                  <th className="py-2.5 px-4">User Account</th>
                  <th className="py-2.5 px-4">Google Sign-In State</th>
                  <th className="py-2.5 px-4">Firestore Profile (/userProfiles)</th>
                  <th className="py-2.5 px-4">Diagnostic Status</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1C212C] text-xs">
                {isScanningAuth && repairRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[#8C96A8]">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" />
                        Scanning Google Sign-In tokens, Firestore profiles, and ownership flags...
                      </span>
                    </td>
                  </tr>
                ) : repairRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[#8C96A8]">
                      Click Scan Metadata to inspect Firestore profile and ownership alignment.
                    </td>
                  </tr>
                ) : (
                  repairRows.map((row) => {
                    const isRowBusy =
                      isRepairingAuth &&
                      (repairingTargetId === row.userId || repairingTargetId === null);

                    return (
                      <tr key={row.userId} className="hover:bg-[#171B23] transition-colors">
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-[#F5F7FA] truncate max-w-[210px]">
                            {row.displayName || 'Dispatch Member'}
                            {row.isActiveCaller ? ' · Current Session' : ''}
                          </div>
                          <div className="text-[11px] font-mono text-[#8C96A8] truncate max-w-[230px]">
                            {row.email}
                          </div>
                        </td>

                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="text-[#D5DCE6]">
                            {row.emailVerified ? 'Verified' : 'Unverified'} ·{' '}
                            {formatProviderName(row.authProvider)}
                          </div>
                          <div className="text-[11px] font-mono text-[#6E788A] tabular-nums">
                            Expected: {formatRoleLabel(row.expectedRole)} · isOwner:{' '}
                            {String(row.expectedIsOwner)}
                          </div>
                        </td>

                        <td className="py-2.5 px-4 whitespace-nowrap">
                          {!row.firestoreChecked ? (
                            <span className="text-[#8C96A8]">
                              PII Isolated (Principal Owner scope)
                            </span>
                          ) : !row.firestoreProfile ? (
                            <span className="text-amber-300 font-medium">
                              Missing /userProfiles doc
                            </span>
                          ) : (
                            <div>
                              <div className="text-[#D5DCE6] font-mono">
                                role: {row.firestoreProfile.role} · isOwner:{' '}
                                {String(row.firestoreProfile.isOwner)}
                              </div>
                              <div className="text-[11px] font-mono text-[#6E788A] tabular-nums">
                                {row.firestoreProfile.accountStatus} · synced{' '}
                                {formatRelativeAge(row.firestoreProfile.lastSyncedAtIso)}
                              </div>
                            </div>
                          )}
                        </td>

                        <td className="py-2.5 px-4 max-w-sm">
                          {row.issues.length === 0 ? (
                            <span className="inline-flex items-center gap-1.5 text-[#D5DCE6] font-medium">
                              <CheckCircle2
                                className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                                aria-hidden="true"
                              />
                              Synchronized ({formatRoleLabel(row.expectedRole)})
                            </span>
                          ) : (
                            <div className="space-y-0.5">
                              <span
                                className={`inline-flex items-center gap-1.5 font-medium ${
                                  row.ownershipMisflagged
                                    ? 'text-[#FCA5A5]'
                                    : 'text-amber-300'
                                }`}
                              >
                                <AlertTriangle
                                  className="w-3.5 h-3.5 shrink-0"
                                  aria-hidden="true"
                                />
                                {row.ownershipMisflagged
                                  ? 'Ownership Privilege Mis-flagged'
                                  : 'Profile Drift Detected'}
                              </span>
                              <div className="text-[11px] text-[#9BA6B8] leading-snug">
                                {row.issues[0]}
                              </div>
                            </div>
                          )}
                        </td>

                        <td className="py-2.5 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            disabled={isRowBusy || (!isOwner && !row.isActiveCaller)}
                            onClick={() => void executeRepairAuthFlow('repair', row.userId)}
                            className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] disabled:opacity-45 rounded whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            {repairingTargetId === row.userId && (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            )}
                            Re-Sync
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 4-Card KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => setActiveTab('privileges')}
          className="text-left bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 rounded-lg p-4 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between text-xs text-[#8C96A8]">
            <span>Privilege Management</span>
            <ShieldCheck className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
            {overview ? overview.totals.users.toLocaleString() : '—'}
          </div>
          <div className="mt-1 text-[11px] text-[#8C96A8] font-mono tabular-nums">
            <span className="text-[#67E8F9]">{adminCount} Admin-Level</span> ·{' '}
            <span className="text-[#D5DCE6]">{standardRoleCount} Standard</span>
            {(overview?.totals.suspendedUsers ?? 0) > 0
              ? ` · ${overview?.totals.suspendedUsers} suspended`
              : ''}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('users')}
          className="text-left bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 rounded-lg p-4 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between text-xs text-[#8C96A8]">
            <span>User Sessions &amp; Last Seen</span>
            <Users className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
            {overview ? active24hCount.toLocaleString() : '—'}
          </div>
          <div className="mt-1 text-[11px] text-[#8C96A8] font-mono tabular-nums">
            seen in 24h · {distinctObservedIpCount}{' '}
            {distinctObservedIpCount === 1 ? 'IP' : 'IPs'}
            {unusualSessionCount > 0 ? (
              <span className="text-amber-300">
                {' '}
                · {unusualSessionCount} unusual
              </span>
            ) : (
              ' · nominal'
            )}
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('activity')}
          className="text-left bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 rounded-lg p-4 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between text-xs text-[#8C96A8]">
            <span>Administrative Audit Log</span>
            <FileText className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
            {overview ? overview.totals.activityLogs.toLocaleString() : '—'}
          </div>
          <div className="mt-1 text-[11px] text-[#8C96A8] font-mono tabular-nums">
            {authAndGovernanceLogCount} auth &amp; privilege · open full ledger
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('shares')}
          className="text-left bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 rounded-lg p-4 transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between text-xs text-[#8C96A8]">
            <span>Public Links &amp; Storage</span>
            <Database className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
            {overview ? overview.storage.activeShareCount.toLocaleString() : '—'}
          </div>
          <div className="mt-1 text-[11px] text-[#8C96A8] font-mono tabular-nums">
            {overview ? totalCloudRecords.toLocaleString() : 0} records ·{' '}
            {overview ? formatBytes(overview.storage.totalShareBytes) : '0 KB'}
          </div>
        </button>
      </div>

      {/* Section Tabs */}
      <div className="border-b border-[#1F2532] flex items-center gap-6 overflow-x-auto">
        {(
          [
            {
              id: 'share_security',
              label:
                flaggedShareCount > 0
                  ? `Share PII Scanner (${flaggedShareCount} Flagged)`
                  : 'Share PII Scanner',
            },
            {
              id: 'users',
              label: `User Audit & Sessions (${overview?.users.length ?? 0})`,
            },
            {
              id: 'privileges',
              label: `Privilege Management (${overview?.users.length ?? 0})`,
            },
            {
              id: 'profile_repair',
              label:
                missingProfileCount > 0
                  ? `Profile Repair (${missingProfileCount} Missing)`
                  : 'Profile Repair',
            },
            {
              id: 'sync_auth',
              label:
                syncAuthDiscrepancyCount > 0
                  ? `Sync Auth (${syncAuthDiscrepancyCount} Discrepancies)`
                  : 'Sync Auth',
            },
            {
              id: 'activity',
              label: `Searchable Activity Log (${displayedLogs.length})`,
            },
            {
              id: 'shares',
              label: `Share Link Governance (${overview?.shares.length ?? 0})`,
            },
            {
              id: 'overview',
              label: 'Storage & Config Ledger',
            },
          ] as const
        ).map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`relative pb-3 text-xs sm:text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer font-mono tabular-nums ${
                active ? 'text-[#F5F7FA]' : 'text-[#8C96A8] hover:text-[#F5F7FA]'
              }`}
            >
              <span className="font-sans">{tab.label}</span>
              {active && (
                <span className="absolute left-0 right-0 bottom-0 h-[2px] bg-[#22D3EE]" />
              )}
            </button>
          );
        })}
      </div>

      {/* TAB: Share PII Scanner — Automated Firestore Public Share Security Utility & Scrub/Re-Link */}
      {activeTab === 'share_security' && (
        <ShareSecurityScannerPanel
          currentUser={user}
          isOwner={isOwner}
          overviewUsers={overview?.users ?? []}
          overviewShares={overview?.shares ?? []}
          getIdToken={getIdToken}
          onNavigateView={onNavigateView}
          onPreviewSharedBriefing={onPreviewSharedBriefing}
          onPreviewSharedMockup={onPreviewSharedMockup}
          onAfterScrubRelink={async () => {
            await loadConsoleData();
          }}
          onOpenSecurityAuditLog={() => {
            setLogUserIdFilter('all');
            setLogDomainFilter('all');
            setLogCategoryFilter('share');
            setLogAuthFilter('all');
            setLogWindowFilter('all');
            setLogFromDate('');
            setLogToDate('');
            setLogSearch('share.');
            setActiveTab('activity');
            void loadFilteredLogs({
              userId: 'all',
              domain: 'all',
              category: 'share',
              authStatus: 'all',
              windowHours: 'all',
              fromDate: '',
              toDate: '',
              search: 'share.',
            });
          }}
          onFlaggedCountChange={setFlaggedShareCount}
          onSurfaceError={setError}
          onSurfaceNotice={setNotice}
        />
      )}

      {/* TAB: Profile Repair — Active Firebase Auth Sessions <-> Firestore /userProfiles Auto-Backfill */}
      {activeTab === 'profile_repair' && (
        <ProfileRepairUtility
          currentUser={user}
          callerRole={role}
          isOwner={isOwner}
          overviewUsers={overview?.users ?? []}
          onAfterProfileRepair={async () => {
            await refreshProfileRole();
            await loadConsoleData();
          }}
          onOpenRepairAuditLog={() => {
            setLogUserIdFilter('all');
            setLogDomainFilter('all');
            setLogCategoryFilter('governance');
            setLogAuthFilter('all');
            setLogWindowFilter('all');
            setLogFromDate('');
            setLogToDate('');
            setLogSearch('auth.profile_repaired');
            setActiveTab('activity');
            void loadFilteredLogs({
              userId: 'all',
              domain: 'all',
              category: 'governance',
              authStatus: 'all',
              windowHours: 'all',
              fromDate: '',
              toDate: '',
              search: 'auth.profile_repaired',
            });
          }}
          onSurfaceError={setError}
          onSurfaceNotice={setNotice}
          onMissingCountChange={setMissingProfileCount}
        />
      )}

      {/* TAB: Privilege Management — Admin-Level vs Standard Role Control & One-Click Promote/Demote */}
      {activeTab === 'privileges' && (
        <UserPrivilegeAuditDashboard
          currentUser={user}
          callerRole={role}
          isOwner={isOwner}
          users={overview?.users ?? []}
          recentLogs={overview?.recentLogs ?? []}
          isLoadingData={isLoadingData}
          mutatingUserId={updatingUserId ?? updatingStatusUserId}
          forcingLogoutUserId={forcingLogoutUserId}
          onMutateUserPrivilege={handleMutateUserPrivilege}
          onForceLogoutUser={handleForceLogoutUser}
          onInspectUserLogs={handleJumpToUserLogs}
          onSurfaceNotice={setNotice}
          onOpenPrivilegeAuditLog={() => {
            setLogUserIdFilter('all');
            setLogDomainFilter('privilege_modifications');
            setLogCategoryFilter('all');
            setLogAuthFilter('all');
            setLogWindowFilter('all');
            setLogFromDate('');
            setLogToDate('');
            setActiveTab('activity');
            void loadFilteredLogs({
              userId: 'all',
              domain: 'privilege_modifications',
              category: 'all',
              authStatus: 'all',
              windowHours: 'all',
              fromDate: '',
              toDate: '',
            });
          }}
        />
      )}

      {/* TAB 0: Sync Auth — Google Sign-In & Firestore Discrepancy Reconciliation */}
      {activeTab === 'sync_auth' && (
        <SyncAuthDashboard
          currentUser={user}
          callerRole={role}
          isOwner={isOwner}
          overviewUsers={overview?.users ?? []}
          onAfterRemediate={async () => {
            await refreshProfileRole();
            await loadConsoleData();
          }}
          onSurfaceError={setError}
          onSurfaceNotice={setNotice}
          onDiscrepancyCountChange={setSyncAuthDiscrepancyCount}
        />
      )}

      {/* TAB 1: User Audit, Last Seen & Session Device/IP Metadata */}
      {activeTab === 'users' && (
        <section className="space-y-5">
          {/* Session Access & Network Telemetry Summary Strip */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-[#1F2532]">
            <div className="flex items-center gap-2.5 flex-wrap text-xs text-[#8C96A8] font-mono tabular-nums">
              <span className="font-sans font-medium text-[#D5DCE6]">
                Session Telemetry
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="text-[#67E8F9] font-semibold">{activeNowCount}</strong>{' '}
                active now
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="text-[#F5F7FA] font-semibold">{active24hCount}</strong>{' '}
                seen in 24h
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <strong className="text-[#F5F7FA] font-semibold">
                  {distinctObservedIpCount}
                </strong>{' '}
                distinct {distinctObservedIpCount === 1 ? 'IP' : 'IPs'} observed
              </span>
              <span aria-hidden="true">·</span>
              {unusualSessionCount > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    setAuthPostureFilter((prev) =>
                      prev === 'unusual' ? 'all' : 'unusual'
                    )
                  }
                  className="inline-flex items-center gap-1.5 text-amber-300 hover:text-amber-200 font-sans font-medium underline underline-offset-4 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {unusualSessionCount} unusual access{' '}
                  {unusualSessionCount === 1 ? 'pattern' : 'patterns'}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[#D5DCE6] font-sans">
                  <CheckCircle2
                    className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                    aria-hidden="true"
                  />
                  All sessions nominal
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={filteredUsers.length === 0}
                onClick={handleExportUserSessionsCsv}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 disabled:opacity-50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                Export Sessions CSV
              </button>
            </div>
          </div>

          {/* Search + Role & Auth Status Filters */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search
                className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2"
                aria-hidden="true"
              />
              <input
                type="search"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="Search users by name, email, IP address, device, or UID..."
                className="w-full h-9 pl-8 pr-3 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] placeholder:text-[#6E788A] focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              {/* Auth & Session Posture Segmented Control */}
              <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md overflow-x-auto">
                {(
                  [
                    { id: 'all', label: 'All Sessions' },
                    { id: 'active_24h', label: 'Active 24h' },
                    {
                      id: 'unusual',
                      label:
                        unusualSessionCount > 0
                          ? `Unusual Access (${unusualSessionCount})`
                          : 'Unusual Access',
                    },
                    {
                      id: 'revoked',
                      label:
                        revokedSessionCount > 0
                          ? `Revoked (${revokedSessionCount})`
                          : 'Revoked',
                    },
                    { id: 'verified', label: 'Verified' },
                    { id: 'unverified', label: 'Unverified' },
                    { id: 'suspended', label: 'Suspended' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setAuthPostureFilter(item.id)}
                    className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      authPostureFilter === item.id
                        ? 'bg-[#1C2533] text-[#67E8F9]'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {/* Role Segmented Control */}
              <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md">
                {(['all', 'owner', 'admin', 'member'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRoleFilter(r)}
                    className={`h-7 px-2.5 text-xs font-medium capitalize rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      roleFilter === r
                        ? 'bg-[#1C2533] text-[#67E8F9]'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                    }`}
                  >
                    {r === 'all' ? 'All Roles' : r}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* High-Density User Session, Last Seen & Device/IP Directory Table */}
          <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                    <th className="py-3 px-4">Registered User</th>
                    <th className="py-3 px-4">Last Seen</th>
                    <th className="py-3 px-4">Device / IP Metadata</th>
                    <th className="py-3 px-4">Access Pattern</th>
                    <th className="py-3 px-4 text-right">Logged Actions</th>
                    <th className="py-3 px-4 text-right">Audit &amp; Access</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1C212C] text-xs">
                  {isLoadingData && !overview ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-[#8C96A8]">
                        Loading registered studio sessions, Last Seen timestamps, and Device/IP metadata...
                      </td>
                    </tr>
                  ) : filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-[#8C96A8]">
                        No user sessions match the active search, IP/device query, or access posture filter.
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((account) => {
                      const isRoleBusy = updatingUserId === account.id;
                      const isStatusBusy = updatingStatusUserId === account.id;
                      const isForceLogoutBusy = forcingLogoutUserId === account.id;
                      const isInspected = inspectedUserId === account.id;
                      const isSelf = account.uid === user.uid;
                      const canManageStatus =
                        account.role !== 'owner' &&
                        !isSelf &&
                        (isOwner || account.role === 'member');
                      const canForceLogout =
                        account.role !== 'owner' &&
                        !isSelf &&
                        (isOwner || account.role === 'member');
                      const observedIpCount = account.recentIps?.length ?? 0;
                      const observedDeviceCount = account.recentDevices?.length ?? 0;

                      return (
                        <tr
                          key={account.id}
                          className={`transition-colors ${
                            isInspected ? 'bg-[#18212E]/75' : 'hover:bg-[#171B23]'
                          }`}
                        >
                          {/* Registered User + Auth & Role Subline */}
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2.5">
                              {account.photoUrl ? (
                                <img
                                  src={account.photoUrl}
                                  alt={account.displayName || account.email}
                                  className="w-7 h-7 rounded-full object-cover shrink-0"
                                  referrerPolicy="no-referrer"
                                />
                              ) : (
                                <span className="w-7 h-7 rounded-full bg-[#1C2432] text-[#67E8F9] inline-flex items-center justify-center text-[11px] font-semibold shrink-0">
                                  {(account.displayName || account.email || 'U')
                                    .charAt(0)
                                    .toUpperCase()}
                                </span>
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium text-[#F5F7FA] truncate max-w-[190px]">
                                    {account.displayName || 'Dispatch Member'}
                                  </span>
                                  <span className="text-[#6E788A]" aria-hidden="true">
                                    ·
                                  </span>
                                  <span
                                    className={`text-[11px] font-medium whitespace-nowrap ${
                                      account.role === 'owner'
                                        ? 'text-[#67E8F9]'
                                        : account.role === 'admin'
                                          ? 'text-emerald-300'
                                          : 'text-[#9BA6B8]'
                                    }`}
                                  >
                                    {formatRoleLabel(account.role)}
                                  </span>
                                </div>
                                <div className="text-[11px] font-mono text-[#8C96A8] truncate max-w-[240px]">
                                  {account.email}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#6E788A]">
                                  {account.accountStatus === 'suspended' ? (
                                    <>
                                      <Ban
                                        className="w-3 h-3 text-[#F87171] shrink-0"
                                        aria-hidden="true"
                                      />
                                      <span className="text-[#FCA5A5]">Suspended</span>
                                    </>
                                  ) : account.emailVerified ? (
                                    <>
                                      <CheckCircle2
                                        className="w-3 h-3 text-[#16A34A] shrink-0"
                                        aria-hidden="true"
                                      />
                                      <span className="text-[#9BA6B8]">Verified</span>
                                    </>
                                  ) : (
                                    <>
                                      <AlertTriangle
                                        className="w-3 h-3 text-[#D97706] shrink-0"
                                        aria-hidden="true"
                                      />
                                      <span className="text-amber-300">Unverified</span>
                                    </>
                                  )}
                                  <span aria-hidden="true">·</span>
                                  <span>{formatProviderName(account.authProvider)}</span>
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Last Seen Timestamp & Session State */}
                          <td className="py-3 px-4 whitespace-nowrap">
                            <div className="font-mono text-[#F5F7FA] tabular-nums font-medium">
                              {formatDateTime(account.lastActiveAt)}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-mono tabular-nums">
                              <span
                                className={
                                  account.sessionState === 'suspended'
                                    ? 'text-[#FCA5A5]'
                                    : account.sessionState === 'revoked'
                                      ? 'text-amber-300'
                                      : account.sessionState === 'active_now'
                                        ? 'text-[#67E8F9]'
                                        : account.sessionState === 'recent_24h'
                                          ? 'text-[#D5DCE6]'
                                          : 'text-[#8C96A8]'
                                }
                              >
                                {formatSessionLabel(account.sessionState)}
                              </span>
                              <span className="text-[#6E788A]" aria-hidden="true">
                                ·
                              </span>
                              <span className="text-[#8C96A8]">
                                {formatRelativeAge(account.lastActiveAt)}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] font-mono text-[#6E788A] tabular-nums">
                              Sign-in {formatDateTime(account.lastLoginAt)} ({account.loginCount})
                            </div>
                            {account.sessionRevokedAfter && (
                              <div className="mt-0.5 text-[11px] font-mono text-amber-300/90 tabular-nums">
                                Revoked {formatDateTime(account.sessionRevokedAfter)}
                              </div>
                            )}
                          </td>

                          {/* Device / IP Metadata */}
                          <td className="py-3 px-4">
                            <div className="text-[#D5DCE6] font-medium truncate max-w-[230px]">
                              {account.lastSeenDevice || 'Pending client telemetry'}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-[#9BA6B8] tabular-nums whitespace-nowrap">
                              IP {account.lastSeenIp || 'Pending capture'}
                            </div>
                            {(observedIpCount > 1 || observedDeviceCount > 1) && (
                              <div className="mt-0.5 font-mono text-[11px] text-[#6E788A] tabular-nums whitespace-nowrap">
                                {Math.max(1, observedIpCount)}{' '}
                                {Math.max(1, observedIpCount) === 1 ? 'IP' : 'IPs'} ·{' '}
                                {Math.max(1, observedDeviceCount)}{' '}
                                {Math.max(1, observedDeviceCount) === 1
                                  ? 'device'
                                  : 'devices'}{' '}
                                on record
                              </div>
                            )}
                          </td>

                          {/* Access Pattern Assessment */}
                          <td className="py-3 px-4">
                            {account.accessPattern?.flagged ? (
                              <div className="min-w-[180px] max-w-[240px]">
                                <div className="flex items-center gap-1.5">
                                  <AlertTriangle
                                    className={`w-3.5 h-3.5 shrink-0 ${
                                      account.accessPattern.level === 'critical'
                                        ? 'text-[#DC2626]'
                                        : 'text-[#D97706]'
                                    }`}
                                    aria-hidden="true"
                                  />
                                  <span
                                    className={`font-medium whitespace-nowrap ${
                                      account.accessPattern.level === 'critical'
                                        ? 'text-[#FCA5A5]'
                                        : 'text-amber-300'
                                    }`}
                                  >
                                    {account.accessPattern.label}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-[11px] text-[#C7D0DF] leading-snug">
                                  {account.accessPattern.reasons[0] ||
                                    'Review recent session IP and device transitions'}
                                </div>
                                <div className="mt-0.5 font-mono text-[11px] text-[#6E788A] tabular-nums">
                                  24h: {account.accessPattern.distinctIps24h} IP ·{' '}
                                  {account.accessPattern.distinctDevices24h} dev
                                </div>
                              </div>
                            ) : (
                              <div className="whitespace-nowrap">
                                <div className="flex items-center gap-1.5">
                                  <CheckCircle2
                                    className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span className="text-[#D5DCE6] font-medium">
                                    Consistent Posture
                                  </span>
                                </div>
                                <div className="mt-0.5 font-mono text-[11px] text-[#6E788A] tabular-nums">
                                  24h: {Math.max(1, account.accessPattern?.distinctIps24h ?? 1)}{' '}
                                  IP ·{' '}
                                  {Math.max(
                                    1,
                                    account.accessPattern?.distinctDevices24h ?? 1
                                  )}{' '}
                                  device
                                </div>
                              </div>
                            )}
                          </td>

                          {/* Logged Actions */}
                          <td className="py-3 px-4 text-right font-mono text-[11px] text-[#C7D0DF] tabular-nums whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleJumpToUserLogs(account.id)}
                              className="text-[#67E8F9] hover:underline font-semibold cursor-pointer"
                              title="Open filtered activity logs for this user"
                            >
                              {account.counts.activityLogs.toLocaleString()} events
                            </button>
                            <div className="text-[#6E788A]">
                              {account.counts.chatMessages + account.counts.transcriptions} desk
                              {' · '}
                              {account.counts.savedMockups +
                                account.counts.mediaItems +
                                account.counts.mapPins}{' '}
                              assets
                            </div>
                          </td>

                          {/* Audit & Governance Controls */}
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleInspectUser(account.id)}
                                className={`h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                  isInspected
                                    ? 'bg-[#22D3EE] text-[#071318] border-[#22D3EE] font-semibold'
                                    : 'bg-[#0E1116] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#2A3342] hover:border-[#22D3EE]/45'
                                }`}
                              >
                                {isInspected ? 'Close Audit' : 'Inspect'}
                              </button>

                              {account.role === 'owner' ? (
                                <span className="text-[11px] font-mono text-[#6E788A] px-1.5">
                                  Immutable
                                </span>
                              ) : (
                                <>
                                  {!isSelf && (
                                    <button
                                      type="button"
                                      disabled={!canForceLogout || isForceLogoutBusy}
                                      onClick={() => void handleForceLogoutUser(account)}
                                      title={
                                        canForceLogout
                                          ? 'Revoke active sessions and clear Firestore-linked auth state for this account'
                                          : 'Only the Principal Owner can force-logout another Studio Admin'
                                      }
                                      className="h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-200 hover:text-amber-100 bg-amber-500/10 hover:bg-amber-500/18 border border-amber-400/35 hover:border-amber-300 disabled:opacity-45 disabled:cursor-not-allowed rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                    >
                                      {isForceLogoutBusy ? (
                                        <Loader2
                                          className="w-3 h-3 animate-spin text-amber-300"
                                          aria-hidden="true"
                                        />
                                      ) : (
                                        <LogOut
                                          className="w-3 h-3 text-amber-300"
                                          aria-hidden="true"
                                        />
                                      )}
                                      Force Logout
                                    </button>
                                  )}

                                  {isOwner && !isSelf && (
                                    <button
                                      type="button"
                                      disabled={isRoleBusy}
                                      onClick={() =>
                                        void handleRoleToggle(
                                          account,
                                          account.role === 'admin' ? 'member' : 'admin'
                                        )
                                      }
                                      className="h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-50 rounded whitespace-nowrap shrink-0 cursor-pointer"
                                    >
                                      {isRoleBusy && (
                                        <Loader2 className="w-3 h-3 animate-spin text-[#22D3EE]" />
                                      )}
                                      {account.role === 'admin' ? 'Set Member' : 'Make Admin'}
                                    </button>
                                  )}

                                  {canManageStatus && (
                                    <button
                                      type="button"
                                      disabled={isStatusBusy}
                                      onClick={() =>
                                        void handleAccountStatusToggle(
                                          account,
                                          account.accountStatus === 'suspended'
                                            ? 'active'
                                            : 'suspended'
                                        )
                                      }
                                      className={`h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium rounded border disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer ${
                                        account.accountStatus === 'suspended'
                                          ? 'text-emerald-300 bg-emerald-500/10 border-emerald-400/35 hover:border-emerald-300'
                                          : 'text-[#FCA5A5] bg-[#2A1216] border-[#F87171]/35 hover:border-[#F87171]'
                                      }`}
                                    >
                                      {isStatusBusy && (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      )}
                                      {account.accountStatus === 'suspended'
                                        ? 'Reactivate'
                                        : 'Suspend'}
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Per-User Session Telemetry, Device/IP & Activity Drill-Down Inspector */}
          {inspectedUserId !== null && (
            <div className="bg-[#13161C] border border-[#22D3EE]/35 rounded-lg overflow-hidden">
              <div className="px-5 py-3.5 border-b border-[#1F2532] flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0">
                  <UserCheck className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-[#F5F7FA] truncate">
                    Session &amp; Access Audit Record
                    {inspectedDetail?.user
                      ? ` — ${inspectedDetail.user.displayName || inspectedDetail.user.email}`
                      : ''}
                  </h2>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {inspectedDetail?.user &&
                    inspectedDetail.user.role !== 'owner' &&
                    inspectedDetail.user.uid !== user.uid &&
                    (isOwner || inspectedDetail.user.role === 'member') && (
                      <button
                        type="button"
                        disabled={forcingLogoutUserId === inspectedDetail.user.id}
                        onClick={() => void handleForceLogoutUser(inspectedDetail.user)}
                        className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-amber-200 hover:text-amber-100 bg-amber-500/10 hover:bg-amber-500/18 border border-amber-400/35 hover:border-amber-300 disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {forcingLogoutUserId === inspectedDetail.user.id ? (
                          <Loader2
                            className="w-3.5 h-3.5 animate-spin text-amber-300"
                            aria-hidden="true"
                          />
                        ) : (
                          <LogOut className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
                        )}
                        Force Logout
                      </button>
                    )}
                  {inspectedDetail?.user && (isOwner || inspectedDetail.user.uid === user.uid) && (
                    <button
                      type="button"
                      disabled={isRepairingAuth}
                      onClick={() =>
                        void executeRepairAuthFlow('repair', inspectedDetail.user.id)
                      }
                      className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] hover:border-[#22D3EE]/45 disabled:opacity-50 rounded whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Wrench className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
                      Repair Auth
                    </button>
                  )}
                  {inspectedDetail?.user && (
                    <button
                      type="button"
                      onClick={() => handleJumpToUserLogs(inspectedDetail.user.id)}
                      className="h-8 px-3 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 rounded whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Open in Audit Ledger
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setInspectedUserId(null);
                      setInspectedDetail(null);
                    }}
                    className="h-8 px-2.5 inline-flex items-center gap-1 text-xs text-[#8C96A8] hover:text-[#F5F7FA] border border-[#222833] rounded cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                    Close
                  </button>
                </div>
              </div>

              {isLoadingInspector || !inspectedDetail ? (
                <div className="py-10 text-center text-xs text-[#8C96A8] inline-flex items-center justify-center gap-2 w-full">
                  <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" />
                  Loading session Device/IP telemetry and chronological logs...
                </div>
              ) : (
                <div className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-6">
                  {/* Left: Session Device/IP Telemetry & Access Pattern Breakdown */}
                  <div className="lg:col-span-5 space-y-4">
                    <div className="space-y-2.5 text-xs divide-y divide-[#1C212C]">
                      <div className="pb-2 flex items-center justify-between gap-3">
                        <span className="text-[#8C96A8]">Firebase Auth UID</span>
                        <div className="inline-flex items-center gap-1.5 font-mono text-[#F5F7FA]">
                          <span className="truncate max-w-[180px]">
                            {inspectedDetail.user.uid}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleCopyUid(inspectedDetail.user)}
                            className="p-1 text-[#8C96A8] hover:text-[#67E8F9] cursor-pointer"
                            title="Copy Firebase UID"
                          >
                            {copiedUidId === inspectedDetail.user.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>

                      <div className="py-2 flex items-center justify-between gap-3">
                        <span className="text-[#8C96A8]">Email &amp; Verification</span>
                        <span className="font-mono text-[#F5F7FA] text-right">
                          {inspectedDetail.user.email} ·{' '}
                          <span
                            className={
                              inspectedDetail.user.emailVerified
                                ? 'text-[#16A34A]'
                                : 'text-[#D97706]'
                            }
                          >
                            {inspectedDetail.user.emailVerified ? 'Verified' : 'Unverified'}
                          </span>
                        </span>
                      </div>

                      <div className="py-2 flex items-center justify-between gap-3">
                        <span className="text-[#8C96A8]">Last Seen Timestamp</span>
                        <span className="font-mono text-[#F5F7FA] tabular-nums text-right">
                          {formatDateTime(inspectedDetail.user.lastActiveAt)} (
                          {formatRelativeAge(inspectedDetail.user.lastActiveAt)})
                        </span>
                      </div>

                      <div className="py-2 flex items-center justify-between gap-3">
                        <span className="text-[#8C96A8]">Last Sign-In &amp; Sessions</span>
                        <span className="font-mono text-[#C7D0DF] tabular-nums text-right">
                          {formatDateTime(
                            inspectedDetail.user.lastTokenIssuedAt ||
                              inspectedDetail.user.lastLoginAt
                          )}{' '}
                          · {inspectedDetail.user.loginCount} sign-ins
                        </span>
                      </div>

                      <div className="py-2 flex items-center justify-between gap-3">
                        <span className="text-[#8C96A8]">Session Auth State</span>
                        <span
                          className={`font-mono tabular-nums text-right ${
                            inspectedDetail.user.sessionState === 'revoked'
                              ? 'text-amber-300'
                              : inspectedDetail.user.sessionState === 'suspended'
                                ? 'text-[#FCA5A5]'
                                : 'text-[#D5DCE6]'
                          }`}
                        >
                          {inspectedDetail.user.sessionRevokedAfter
                            ? `Revoked (${formatDateTime(inspectedDetail.user.sessionRevokedAfter)})`
                            : formatSessionLabel(inspectedDetail.user.sessionState)}
                        </span>
                      </div>

                      <div className="py-2 flex items-start justify-between gap-3">
                        <span className="text-[#8C96A8] shrink-0">Session Device &amp; OS</span>
                        <div className="text-right">
                          <div className="text-[#F5F7FA] font-medium">
                            {inspectedDetail.user.lastSeenDevice ||
                              'Pending client telemetry'}
                          </div>
                          {(inspectedDetail.user.recentDevices?.length ?? 0) > 1 && (
                            <div className="mt-0.5 text-[11px] font-mono text-[#8C96A8]">
                              Observed: {inspectedDetail.user.recentDevices.join(' · ')}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="py-2 flex items-start justify-between gap-3">
                        <span className="text-[#8C96A8] shrink-0">Session IP Address</span>
                        <div className="text-right font-mono tabular-nums">
                          <div className="text-[#F5F7FA]">
                            {inspectedDetail.user.lastSeenIp || 'Pending capture'}
                          </div>
                          {(inspectedDetail.user.recentIps?.length ?? 0) > 1 && (
                            <div className="mt-0.5 text-[11px] text-[#8C96A8]">
                              Recent IPs: {inspectedDetail.user.recentIps.join(' · ')}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="py-2 flex items-start justify-between gap-3">
                        <span className="text-[#8C96A8] shrink-0">Access Pattern</span>
                        <div className="text-right">
                          <div className="inline-flex items-center gap-1.5 justify-end">
                            {inspectedDetail.user.accessPattern?.flagged ? (
                              <>
                                <AlertTriangle
                                  className={`w-3.5 h-3.5 shrink-0 ${
                                    inspectedDetail.user.accessPattern.level === 'critical'
                                      ? 'text-[#DC2626]'
                                      : 'text-[#D97706]'
                                  }`}
                                  aria-hidden="true"
                                />
                                <span
                                  className={`font-medium ${
                                    inspectedDetail.user.accessPattern.level === 'critical'
                                      ? 'text-[#FCA5A5]'
                                      : 'text-amber-300'
                                  }`}
                                >
                                  {inspectedDetail.user.accessPattern.label}
                                </span>
                              </>
                            ) : (
                              <>
                                <CheckCircle2
                                  className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                                  aria-hidden="true"
                                />
                                <span className="text-[#D5DCE6] font-medium">
                                  Consistent Posture
                                </span>
                              </>
                            )}
                          </div>
                          {(inspectedDetail.user.accessPattern?.reasons?.length ?? 0) > 0 && (
                            <div className="mt-0.5 text-[11px] text-[#C7D0DF]">
                              {inspectedDetail.user.accessPattern.reasons.join(' · ')}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="pt-2 flex items-center justify-between gap-3">
                        <span className="text-[#8C96A8]">Workspace Records</span>
                        <span className="font-mono text-[#C7D0DF] tabular-nums">
                          {inspectedDetail.user.counts.chatMessages} chat ·{' '}
                          {inspectedDetail.user.counts.transcriptions} tr ·{' '}
                          {inspectedDetail.user.counts.savedMockups} mk ·{' '}
                          {inspectedDetail.user.counts.mediaItems} media ·{' '}
                          {inspectedDetail.user.counts.mapPins} pin
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Right: User's Chronological Activity Log Stream */}
                  <div className="lg:col-span-7 border-t lg:border-t-0 lg:border-l border-[#1F2532] pt-4 lg:pt-0 lg:pl-6">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-xs font-semibold text-[#F5F7FA]">
                        Chronological Accountability Stream ({inspectedDetail.logs.length})
                      </h3>
                      <span className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
                        Auth · Device/IP · Privileges
                      </span>
                    </div>

                    {inspectedDetail.logs.length === 0 ? (
                      <p className="text-xs text-[#8C96A8] py-6">
                        No activity events recorded for this user yet.
                      </p>
                    ) : (
                      <div className="max-h-72 overflow-y-auto divide-y divide-[#1C212C]">
                        {inspectedDetail.logs.slice(0, 25).map((entry) => {
                          const diff = extractAuditStateTransition(entry);
                          return (
                            <div
                              key={entry.id}
                              className="py-2.5 flex items-start justify-between gap-4 text-xs"
                            >
                              <div className="min-w-0 space-y-0.5">
                                <div className="text-[#F5F7FA] leading-snug">
                                  {entry.summary}
                                </div>
                                <div className="text-[11px] text-[#6E788A] font-mono">
                                  {CATEGORY_LABELS[entry.category] || entry.category} ·{' '}
                                  {entry.action}
                                  {diff ? ` · ${diff.before} → ${diff.after}` : ''}
                                  {entry.clientContext ? ` · ${entry.clientContext}` : ''}
                                </div>
                              </div>
                              <span className="font-mono text-[11px] text-[#8C96A8] tabular-nums whitespace-nowrap shrink-0">
                                {formatDateTime(entry.createdAt)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* TAB 2: Searchable Granular Activity Log (Sorted by Timestamp) */}
      {activeTab === 'activity' && (
        <AdminAuditLogPanel
          logs={activityLogs}
          users={overview?.users ?? []}
          isLoading={isLoadingLogs}
          domainFilter={logDomainFilter}
          onDomainFilterChange={setLogDomainFilter}
          categoryFilter={logCategoryFilter}
          onCategoryFilterChange={setLogCategoryFilter}
          authFilter={logAuthFilter}
          onAuthFilterChange={setLogAuthFilter}
          userIdFilter={logUserIdFilter}
          onUserIdFilterChange={setLogUserIdFilter}
          windowFilter={logWindowFilter}
          onWindowFilterChange={setLogWindowFilter}
          sortOrder={logSortOrder}
          onSortOrderChange={setLogSortOrder}
          fromDate={logFromDate}
          onFromDateChange={setLogFromDate}
          toDate={logToDate}
          onToDateChange={setLogToDate}
          searchQuery={logSearch}
          onSearchQueryChange={setLogSearch}
          onReload={() => void loadFilteredLogs()}
          onResetFilters={() => {
            setLogUserIdFilter('all');
            setLogDomainFilter('all');
            setLogCategoryFilter('all');
            setLogAuthFilter('all');
            setLogWindowFilter('all');
            setLogFromDate('');
            setLogToDate('');
            setLogSortOrder('desc');
            setLogSearch('');
          }}
          onExportCsv={handleExportAuditCsv}
          onSurfaceNotice={setNotice}
          onOpenSystemConfig={() => setShowConfigPanel(true)}
          auditClipboardFormat={auditClipboardFormat}
          onAuditClipboardFormatChange={setAuditClipboardFormat}
          onCopyFullAuditLog={(fmt) => void handleCopyFullAuditLog(fmt)}
          copyingAuditFormat={copyingAuditFormat}
          copiedAuditFormat={copiedAuditFormat}
        />
      )}

      {/* TAB 3: Share Link Governance */}
      {activeTab === 'shares' && (
        <section className="space-y-4">
          <div className="px-4 py-3 bg-[#13161C] border border-[#222833] rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-[#C7D0DF]">
              <FileSearch className="w-4 h-4 text-[#22D3EE] shrink-0" aria-hidden="true" />
              <span>
                Need to inspect Firestore share payloads for accidentally serialized PII,
                API tokens, or private notes?
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('share_security')}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded whitespace-nowrap shrink-0 cursor-pointer"
            >
              Open Share PII Scanner &amp; Scrub Utility
            </button>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 flex-wrap flex-1">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search
                  className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={shareQuery}
                  onChange={(e) => setShareQuery(e.target.value)}
                  placeholder="Search active share links by title, ID, or creator..."
                  className="w-full h-9 pl-8 pr-3 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] placeholder:text-[#6E788A] focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md">
                {(
                  [
                    { id: 'all', label: 'All Links' },
                    { id: 'briefing', label: 'Briefings' },
                    { id: 'mockup', label: 'Site Mockups' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setShareKindFilter(item.id)}
                    className={`h-7 px-2.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                      shareKindFilter === item.id
                        ? 'bg-[#1C2533] text-[#67E8F9]'
                        : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={isPurging}
              onClick={() => void handlePurgeExpired()}
              className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-50 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isPurging ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#22D3EE]" />
              ) : (
                <Trash2 className="w-3.5 h-3.5 text-[#8C96A8]" />
              )}
              Purge Expired Links
            </button>
          </div>

          <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                    <th className="py-3 px-4">Shared Item</th>
                    <th className="py-3 px-4">Type</th>
                    <th className="py-3 px-4">Creator</th>
                    <th className="py-3 px-4">Expiration</th>
                    <th className="py-3 px-4 text-right">Size</th>
                    <th className="py-3 px-4 text-right">Controls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1C212C] text-xs">
                  {filteredShares.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-[#8C96A8]">
                        No active public share links right now. Links created from Audio
                        Briefings or Site Mockup appear here automatically.
                      </td>
                    </tr>
                  ) : (
                    filteredShares.map((share) => {
                      const key = `${share.kind}:${share.shareId}`;
                      const isBusy = busyShareKey === key;
                      const isCopied = copiedShareKey === key;

                      return (
                        <tr key={key} className="hover:bg-[#171B23] transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-medium text-[#F5F7FA] truncate max-w-[240px]">
                              {share.title}
                            </div>
                            <div className="text-[11px] font-mono text-[#6E788A] truncate max-w-[240px]">
                              {share.sharePath}
                            </div>
                          </td>

                          <td className="py-3 px-4 whitespace-nowrap text-[#C7D0DF]">
                            {share.kind === 'briefing' ? 'Audio Briefing' : 'Site Mockup'}
                          </td>

                          <td className="py-3 px-4 font-mono text-[11px] text-[#9BA6B8] truncate max-w-[190px]">
                            {share.creatorEmail}
                          </td>

                          <td className="py-3 px-4 whitespace-nowrap">
                            <div className="inline-flex items-center gap-1 font-mono text-[11px] text-[#67E8F9] tabular-nums">
                              <Clock className="w-3 h-3" aria-hidden="true" />
                              {formatRemainingWindow(share.expiresAt)}
                            </div>
                            <div className="text-[10px] font-mono text-[#6E788A] tabular-nums">
                              {formatDateTime(share.expiresAt)}
                            </div>
                          </td>

                          <td className="py-3 px-4 text-right font-mono text-[11px] text-[#C7D0DF] tabular-nums whitespace-nowrap">
                            {formatBytes(share.sizeBytes)}
                          </td>

                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  share.kind === 'briefing'
                                    ? onPreviewSharedBriefing(share.shareId)
                                    : onPreviewSharedMockup(share.shareId)
                                }
                                className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded whitespace-nowrap shrink-0 cursor-pointer"
                                title="Open public preview"
                              >
                                <ExternalLink className="w-3 h-3 text-[#22D3EE]" />
                                Preview
                              </button>

                              <button
                                type="button"
                                onClick={() => void handleCopyShareUrl(share)}
                                className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded whitespace-nowrap shrink-0 cursor-pointer"
                                title="Copy public link"
                              >
                                {isCopied ? (
                                  <Check className="w-3 h-3 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                {isCopied ? 'Copied' : 'Copy'}
                              </button>

                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleExtendShare(share)}
                                className="h-7 px-2.5 text-[11px] font-mono text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] disabled:opacity-50 rounded whitespace-nowrap shrink-0 cursor-pointer"
                                title="Extend expiration by 72 hours"
                              >
                                +72h
                              </button>

                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleRevokeShare(share)}
                                className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] text-[#FCA5A5] hover:text-white bg-[#2A1216] border border-[#F87171]/35 hover:border-[#F87171] disabled:opacity-50 rounded whitespace-nowrap shrink-0 cursor-pointer"
                                title="Revoke link immediately"
                              >
                                <Trash2 className="w-3 h-3" />
                                Revoke
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* TAB 4: Storage & Security Ledger */}
      {activeTab === 'overview' && (
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-[#1F2532] flex items-center justify-between">
              <h2 className="text-xs font-semibold text-[#F5F7FA]">
                Cloud SQL Table Ledger
              </h2>
              <span className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
                PostgreSQL · Live Counts
              </span>
            </div>

            <table className="w-full text-left border-collapse text-xs">
              <tbody className="divide-y divide-[#1C212C]">
                {[
                  {
                    label: 'Firestore Identity Links (/userProfiles)',
                    value: overview?.totals.users ?? 0,
                    actionLabel: 'Open Sync Auth',
                    onClick: () => setActiveTab('sync_auth'),
                  },
                  {
                    label: 'Registered Studio Users (users)',
                    value: overview?.totals.users ?? 0,
                    actionLabel: 'Audit Users',
                    onClick: () => setActiveTab('users'),
                  },
                  {
                    label: 'User Activity & Auth Audit Logs (user_activity_logs)',
                    value: overview?.totals.activityLogs ?? 0,
                    actionLabel: 'Search Logs',
                    onClick: () => setActiveTab('activity'),
                  },
                  {
                    label: `Studio System Configuration (${overview?.systemConfig?.defaultShareTtlHours ?? 72}h share TTL · ${overview?.systemConfig?.auditRetentionDays ?? 180}d retention)`,
                    value: 5,
                    actionLabel: 'Configure',
                    onClick: () => setShowConfigPanel(true),
                  },
                  {
                    label: 'AI Desk Multi-Model Chat Messages (chat_messages)',
                    value: overview?.totals.chatMessages ?? 0,
                    actionLabel: 'Open',
                    onClick: () => onNavigateView('chat'),
                  },
                  {
                    label: 'Speech-to-Text Transcriptions (transcriptions)',
                    value: overview?.totals.transcriptions ?? 0,
                    actionLabel: 'Open',
                    onClick: () => onNavigateView('chat'),
                  },
                  {
                    label: 'Media Lab Creations (media_items)',
                    value: overview?.totals.mediaItems ?? 0,
                    actionLabel: 'Open',
                    onClick: () => onNavigateView('media'),
                  },
                  {
                    label: 'Site Mockup Saved Versions (saved_mockups)',
                    value: overview?.totals.savedMockups ?? 0,
                    actionLabel: 'Open',
                    onClick: () => onNavigateView('mockup'),
                  },
                  {
                    label: 'Spatial & Map Saved Pins (map_pins)',
                    value: overview?.totals.mapPins ?? 0,
                    actionLabel: 'Open',
                    onClick: () => onNavigateView('spatial'),
                  },
                  {
                    label: 'Dispatch Run Leaderboard Entries (game_scores)',
                    value: overview?.totals.gameRuns ?? 0,
                    actionLabel: 'Open',
                    onClick: () => onNavigateView('spatial'),
                  },
                ].map((row) => (
                  <tr key={row.label} className="hover:bg-[#171B23]">
                    <td className="py-3 px-4 text-[#C7D0DF]">{row.label}</td>
                    <td className="py-3 px-4 text-right font-mono text-[#F5F7FA] tabular-nums">
                      {row.value.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={row.onClick}
                        className="text-[11px] text-[#67E8F9] hover:underline cursor-pointer"
                      >
                        {row.actionLabel}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="lg:col-span-5 bg-[#13161C] border border-[#222833] rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-[#F5F7FA]">
                Active Access &amp; Audit Controls
              </h2>
              <HardDrive className="w-4 h-4 text-[#22D3EE]" aria-hidden="true" />
            </div>

            <div className="divide-y divide-[#1C212C] text-xs">
              <div className="pb-3 space-y-1">
                <div className="font-medium text-[#F5F7FA]">
                  Cryptographic Admin-Only Gate
                </div>
                <p className="text-[#8C96A8] leading-relaxed">
                  Every <span className="font-mono text-[#C7D0DF]">/api/owner/*</span>{' '}
                  audit endpoint verifies the caller&apos;s Firebase ID token on the server
                  and enforces active Principal Owner or Studio Admin role membership.
                </p>
              </div>

              <div className="py-3 space-y-1">
                <div className="font-medium text-[#F5F7FA]">
                  Token &amp; Session Posture Tracking
                </div>
                <p className="text-[#8C96A8] leading-relaxed">
                  Records email verification claims, OAuth identity provider, token auth
                  timestamps, session counts, and real-time account suspension status in
                  Cloud SQL.
                </p>
              </div>

              <div className="py-3 space-y-1">
                <div className="font-medium text-[#F5F7FA]">
                  Tamper-Evident Activity Stream
                </div>
                <p className="text-[#8C96A8] leading-relaxed">
                  Logs sign-ins, role promotions, account status updates, public share
                  mutations, and workspace saves with CSV export for external review.
                </p>
              </div>

              <div className="pt-3 space-y-1">
                <div className="font-medium text-[#F5F7FA]">
                  Share Mutation &amp; Leaderboard Privacy
                </div>
                <p className="text-[#8C96A8] leading-relaxed">
                  Public share manifests strip internal creator tokens, and Dispatch Run
                  leaderboards redact raw member email addresses.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
