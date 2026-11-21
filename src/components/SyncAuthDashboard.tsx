import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { reload, type User } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Link2Off,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  Zap,
} from 'lucide-react';
import { auth } from '../lib/firebase';
import {
  fetchInspectedFirestoreProfilesMap,
  PRINCIPAL_OWNER_EMAIL,
  removeOrphanedFirestoreProfileAsPrincipalOwner,
  subscribeToFirestoreUserProfiles,
  syncCallerFirestoreProfile,
  upsertFirestoreProfileAsPrincipalOwner,
  type InspectedFirestoreUserProfile,
} from '../services/firestoreUserProfile';
import {
  logOwnerFirestoreRepairSync,
  runOwnerRepairAuth,
  type OwnerAuditedUser,
  type SqlUserRepairDiagnostic,
} from '../services/suiteApi';

export type LinkDiscrepancyState =
  | 'healthy'
  | 'missing_firestore'
  | 'corrupted_link'
  | 'metadata_drift'
  | 'orphaned_firestore'
  | 'isolated_scope';

type DiscrepancyFilter =
  | 'all'
  | 'needs_remediation'
  | 'missing_firestore'
  | 'corrupted_link'
  | 'metadata_drift'
  | 'orphaned_firestore'
  | 'healthy';

interface AttributeComparisonRow {
  key: string;
  label: string;
  googleValue: string;
  firestoreValue: string;
  aligned: boolean;
  severity: 'ok' | 'warning' | 'critical';
}

interface UnifiedAuthLinkRecord {
  uid: string;
  userId: number | null;
  displayName: string;
  email: string;
  photoUrl: string;
  authProvider: string;
  emailVerified: boolean;
  isActiveCaller: boolean;
  expectedRole: 'owner' | 'admin' | 'member';
  expectedIsOwner: boolean;
  expectedAccountStatus: 'active' | 'suspended';
  storedSqlRole: string | null;
  sqlIssues: string[];
  firestoreInspected: InspectedFirestoreUserProfile | null;
  firestoreChecked: boolean;
  state: LinkDiscrepancyState;
  needsRemediation: boolean;
  ownershipMisflagged: boolean;
  discrepancyHeadline: string;
  discrepancyDetails: string[];
  comparisons: AttributeComparisonRow[];
}

interface RemediationReceipt {
  completedAtIso: string;
  evaluatedLinks: number;
  createdProfiles: number;
  recreatedCorrupted: number;
  updatedProfiles: number;
  orphansRemoved: number;
  sqlRepaired: number;
  misflaggedOwnersFixed: number;
}

interface SyncAuthDashboardProps {
  currentUser: User;
  callerRole: 'owner' | 'admin' | 'member' | 'guest';
  isOwner: boolean;
  overviewUsers: OwnerAuditedUser[];
  onAfterRemediate: () => Promise<void>;
  onSurfaceError: (message: string | null) => void;
  onSurfaceNotice: (message: string | null) => void;
  onDiscrepancyCountChange?: (count: number) => void;
}

function formatProviderLabel(provider: string): string {
  const clean = (provider || 'google.com').toLowerCase();
  if (clean.includes('google')) return 'Google OAuth';
  if (clean.includes('password')) return 'Email';
  return provider || 'Google OAuth';
}

function formatRoleTitle(role: 'owner' | 'admin' | 'member' | string): string {
  if (role === 'owner') return 'Ultra Owner';
  if (role === 'admin') return 'Studio Admin';
  return 'Member';
}

function formatShortRelative(iso: string | null | undefined): string {
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

function formatClockStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function SyncAuthDashboard({
  currentUser,
  callerRole,
  isOwner,
  overviewUsers,
  onAfterRemediate,
  onSurfaceError,
  onSurfaceNotice,
  onDiscrepancyCountChange,
}: SyncAuthDashboardProps) {
  const [firestoreMap, setFirestoreMap] = useState<
    Map<string, InspectedFirestoreUserProfile>
  >(new Map());
  const [listenerConnected, setListenerConnected] = useState(false);
  const [sqlDiagnostics, setSqlDiagnostics] = useState<SqlUserRepairDiagnostic[] | null>(
    null
  );
  const [isScanning, setIsScanning] = useState(false);
  const [isRemediatingAll, setIsRemediatingAll] = useState(false);
  const [remediatingUid, setRemediatingUid] = useState<string | null>(null);
  const [lastScannedAtIso, setLastScannedAtIso] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RemediationReceipt | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<DiscrepancyFilter>('all');
  const [expandedUid, setExpandedUid] = useState<string | null>(null);
  const [failedAvatarUids, setFailedAvatarUids] = useState<Record<string, boolean>>({});

  const isVerifiedPrincipalCaller = Boolean(
    currentUser.emailVerified &&
      currentUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
  );

  // 1. Live Real-Time Firestore Subscription (/userProfiles)
  useEffect(() => {
    if (!currentUser || !currentUser.emailVerified) {
      setFirestoreMap(new Map());
      setListenerConnected(false);
      return;
    }

    const unsubscribe = subscribeToFirestoreUserProfiles(
      currentUser,
      isVerifiedPrincipalCaller,
      (profiles) => {
        setFirestoreMap(profiles);
        setListenerConnected(true);
      },
      (errMessage) => {
        setListenerConnected(false);
        onSurfaceError(errMessage);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [currentUser, isVerifiedPrincipalCaller, onSurfaceError]);

  // 2. Scan Google Sign-In Token + Cloud SQL Identity Registry
  const runLiveAuthScan = useCallback(async () => {
    if (!auth.currentUser) return;
    setIsScanning(true);
    onSurfaceError(null);
    try {
      await reload(auth.currentUser);
      const liveUser = auth.currentUser;
      const freshToken = await liveUser.getIdToken(true);
      const report = await runOwnerRepairAuth(freshToken, {
        mode: 'scan',
        displayName: liveUser.displayName || '',
        photoUrl: liveUser.photoURL || '',
      });
      setSqlDiagnostics(report.users);

      const latestFs = await fetchInspectedFirestoreProfilesMap(
        liveUser,
        Boolean(
          liveUser.emailVerified &&
            liveUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
        )
      );
      setFirestoreMap(latestFs);
      setListenerConnected(true);
      setLastScannedAtIso(report.scannedAt || new Date().toISOString());
    } catch (err) {
      onSurfaceError(
        err instanceof Error
          ? err.message
          : 'Could not scan Google Sign-In and Firestore profile alignment.'
      );
    } finally {
      setIsScanning(false);
    }
  }, [onSurfaceError]);

  useEffect(() => {
    void runLiveAuthScan();
  }, [runLiveAuthScan]);

  // 3. Bi-Directional Reconciliation Matrix (Union of Google Sign-In / SQL Registry + Firestore /userProfiles)
  const linkRecords = useMemo<UnifiedAuthLinkRecord[]>(() => {
    const liveCaller = auth.currentUser || currentUser;
    const callerProvider =
      liveCaller.providerData?.find((p) => p?.providerId)?.providerId || 'google.com';

    // Build baseline auth directory from latest SQL scan or overviewUsers fallback
    const authEntriesByUid = new Map<string, SqlUserRepairDiagnostic>();

    if (sqlDiagnostics && sqlDiagnostics.length > 0) {
      for (const diag of sqlDiagnostics) {
        authEntriesByUid.set(diag.uid, diag);
      }
    } else {
      for (const u of overviewUsers) {
        const isRowPrincipal =
          Boolean(u.emailVerified) &&
          u.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL;
        const expectedRole: 'owner' | 'admin' | 'member' = isRowPrincipal
          ? 'owner'
          : u.role === 'admin'
            ? 'admin'
            : 'member';
        const expectedStatus: 'active' | 'suspended' = isRowPrincipal
          ? 'active'
          : u.accountStatus === 'suspended'
            ? 'suspended'
            : 'active';

        authEntriesByUid.set(u.uid, {
          userId: u.id,
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          photoUrl: u.photoUrl,
          authProvider: u.authProvider || 'google.com',
          emailVerified: u.emailVerified,
          storedRole: u.role,
          expectedRole,
          expectedIsOwner: expectedRole === 'owner',
          storedAccountStatus: u.accountStatus,
          expectedAccountStatus: expectedStatus,
          sqlIssues: [],
          sqlRepaired: false,
        });
      }
    }

    // Guarantee active Google Sign-In caller is always represented with live token claims
    if (!authEntriesByUid.has(liveCaller.uid)) {
      const callerIsPrincipal = Boolean(
        liveCaller.emailVerified &&
          liveCaller.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
      );
      const fallbackRole: 'owner' | 'admin' | 'member' = callerIsPrincipal
        ? 'owner'
        : callerRole === 'admin'
          ? 'admin'
          : 'member';
      authEntriesByUid.set(liveCaller.uid, {
        userId: null as unknown as number,
        uid: liveCaller.uid,
        email: liveCaller.email || `${liveCaller.uid}@dispatch.local`,
        displayName: liveCaller.displayName || '',
        photoUrl: liveCaller.photoURL || '',
        authProvider: callerProvider,
        emailVerified: Boolean(liveCaller.emailVerified),
        storedRole: fallbackRole,
        expectedRole: fallbackRole,
        expectedIsOwner: fallbackRole === 'owner',
        storedAccountStatus: 'active',
        expectedAccountStatus: 'active',
        sqlIssues: [],
        sqlRepaired: false,
      });
    }

    const allUids = new Set<string>();
    authEntriesByUid.forEach((_v, uid) => allUids.add(uid));
    if (isVerifiedPrincipalCaller) {
      firestoreMap.forEach((_v, docId) => allUids.add(docId));
    }

    const evaluated: UnifiedAuthLinkRecord[] = [];

    allUids.forEach((uid) => {
      const authEntry = authEntriesByUid.get(uid) ?? null;
      const fsInspected = firestoreMap.get(uid) ?? null;
      const isCallerRow = uid === liveCaller.uid;
      const firestoreChecked = isVerifiedPrincipalCaller || isCallerRow;

      // Case 1: Orphaned Firestore Profile (exists in Firestore /userProfiles, missing from Google Sign-In / Auth Registry)
      if (!authEntry && fsInspected) {
        const fsDoc = fsInspected.parsed;
        const details = [
          'Firestore /userProfiles document has no matching Google Sign-In account in the identity registry',
          ...fsInspected.rawSchemaIssues,
        ];
        evaluated.push({
          uid,
          userId: null,
          displayName: fsDoc.displayName || 'Unlinked Profile Record',
          email: fsDoc.email,
          photoUrl: fsDoc.photoUrl,
          authProvider: fsDoc.authProvider,
          emailVerified: fsDoc.emailVerified,
          isActiveCaller: false,
          expectedRole: 'member',
          expectedIsOwner: false,
          expectedAccountStatus: 'suspended',
          storedSqlRole: null,
          sqlIssues: [],
          firestoreInspected: fsInspected,
          firestoreChecked: true,
          state: 'orphaned_firestore',
          needsRemediation: true,
          ownershipMisflagged: Boolean(fsDoc.isOwner || fsDoc.role === 'owner'),
          discrepancyHeadline: 'Orphaned Firestore Document',
          discrepancyDetails: details,
          comparisons: [
            {
              key: 'uid',
              label: 'Identity Registry Link',
              googleValue: 'Missing from Auth Registry',
              firestoreValue: `/userProfiles/${uid}`,
              aligned: false,
              severity: 'critical',
            },
            {
              key: 'email',
              label: 'Account Email',
              googleValue: '—',
              firestoreValue: fsDoc.email,
              aligned: false,
              severity: 'warning',
            },
            {
              key: 'role',
              label: 'Role & Ownership Flag',
              googleValue: 'Unlinked',
              firestoreValue: `${fsDoc.role} · isOwner=${String(fsDoc.isOwner)}`,
              aligned: false,
              severity: fsDoc.isOwner ? 'critical' : 'warning',
            },
          ],
        });
        return;
      }

      if (!authEntry) return;

      const liveEmail =
        isCallerRow && liveCaller.email ? liveCaller.email.trim() : authEntry.email.trim();
      const liveVerified = isCallerRow
        ? Boolean(liveCaller.emailVerified)
        : Boolean(authEntry.emailVerified);
      const liveDisplayName =
        isCallerRow && liveCaller.displayName
          ? liveCaller.displayName.trim()
          : authEntry.displayName.trim();
      const livePhotoUrl =
        isCallerRow && liveCaller.photoURL
          ? liveCaller.photoURL.trim()
          : authEntry.photoUrl.trim();
      const liveProvider = isCallerRow
        ? callerProvider
        : authEntry.authProvider || 'google.com';

      // Non-Principal Studio Admin viewing another user's row (PII isolated in Firestore)
      if (!firestoreChecked) {
        const hasSqlIssue = authEntry.sqlIssues.length > 0;
        evaluated.push({
          uid,
          userId: typeof authEntry.userId === 'number' ? authEntry.userId : null,
          displayName: liveDisplayName || 'Dispatch Member',
          email: liveEmail,
          photoUrl: livePhotoUrl,
          authProvider: liveProvider,
          emailVerified: liveVerified,
          isActiveCaller: false,
          expectedRole: authEntry.expectedRole,
          expectedIsOwner: authEntry.expectedIsOwner,
          expectedAccountStatus: authEntry.expectedAccountStatus,
          storedSqlRole: authEntry.storedRole,
          sqlIssues: authEntry.sqlIssues,
          firestoreInspected: null,
          firestoreChecked: false,
          state: hasSqlIssue ? 'corrupted_link' : 'isolated_scope',
          needsRemediation: hasSqlIssue,
          ownershipMisflagged: false,
          discrepancyHeadline: hasSqlIssue
            ? 'Cloud SQL Metadata Drift'
            : 'Principal Owner Firestore Scope',
          discrepancyDetails: hasSqlIssue
            ? authEntry.sqlIssues
            : ['Cross-user Firestore /userProfiles PII is isolated to Principal Owner'],
          comparisons: [
            {
              key: 'email',
              label: 'Google Sign-In Email',
              googleValue: `${liveEmail} (${liveVerified ? 'Verified' : 'Unverified'})`,
              firestoreValue: 'Restricted (Principal Owner Scope)',
              aligned: !hasSqlIssue,
              severity: hasSqlIssue ? 'warning' : 'ok',
            },
          ],
        });
        return;
      }

      // Case 2: Missing Firestore Profile (/userProfiles/{uid} does not exist)
      if (!fsInspected) {
        const details = [
          `Missing Firestore /userProfiles/${uid} profile link`,
          ...authEntry.sqlIssues,
        ];
        evaluated.push({
          uid,
          userId: typeof authEntry.userId === 'number' ? authEntry.userId : null,
          displayName: liveDisplayName || 'Dispatch Member',
          email: liveEmail,
          photoUrl: livePhotoUrl,
          authProvider: liveProvider,
          emailVerified: liveVerified,
          isActiveCaller: isCallerRow,
          expectedRole: authEntry.expectedRole,
          expectedIsOwner: authEntry.expectedIsOwner,
          expectedAccountStatus: authEntry.expectedAccountStatus,
          storedSqlRole: authEntry.storedRole,
          sqlIssues: authEntry.sqlIssues,
          firestoreInspected: null,
          firestoreChecked: true,
          state: 'missing_firestore',
          needsRemediation: true,
          ownershipMisflagged: authEntry.expectedIsOwner,
          discrepancyHeadline: 'Missing Firestore User Link',
          discrepancyDetails: details,
          comparisons: [
            {
              key: 'doc',
              label: 'Firestore Document (/userProfiles)',
              googleValue: `UID ${uid}`,
              firestoreValue: 'Not Created (Missing)',
              aligned: false,
              severity: 'critical',
            },
            {
              key: 'email',
              label: 'Verified Email',
              googleValue: `${liveEmail} · ${liveVerified ? 'Verified' : 'Unverified'}`,
              firestoreValue: '—',
              aligned: false,
              severity: 'warning',
            },
            {
              key: 'role',
              label: 'Expected Privilege Link',
              googleValue: `${authEntry.expectedRole} · isOwner=${String(authEntry.expectedIsOwner)}`,
              firestoreValue: 'Unlinked',
              aligned: false,
              severity: authEntry.expectedIsOwner ? 'critical' : 'warning',
            },
            {
              key: 'status',
              label: 'Account Posture',
              googleValue: authEntry.expectedAccountStatus,
              firestoreValue: '—',
              aligned: false,
              severity: 'warning',
            },
          ],
        });
        return;
      }

      // Case 3: Both Google Sign-In / Auth Registry AND Firestore /userProfiles/{uid} exist — run field-by-field comparison
      const fsDoc = fsInspected.parsed;
      const details: string[] = [...authEntry.sqlIssues, ...fsInspected.rawSchemaIssues];
      let hasCorruptedOrPrivilegeIssue =
        fsInspected.isCorruptedSchema ||
        (authEntry.expectedIsOwner && authEntry.storedRole !== 'owner') ||
        (!authEntry.expectedIsOwner && authEntry.storedRole === 'owner');
      let ownershipMisflagged =
        (authEntry.expectedIsOwner &&
          (fsDoc.role !== 'owner' ||
            fsDoc.isOwner !== true ||
            fsDoc.accountStatus !== 'active' ||
            authEntry.storedRole !== 'owner')) ||
        (!authEntry.expectedIsOwner &&
          (fsDoc.isOwner === true ||
            fsDoc.role === 'owner' ||
            authEntry.storedRole === 'owner'));
      let hasDrift = false;

      const uidAligned = !fsInspected.uidMismatch && fsDoc.uid === uid;
      const emailAligned = fsDoc.email.trim().toLowerCase() === liveEmail.toLowerCase();
      const verifiedAligned =
        typeof fsInspected.rawEmailVerified === 'boolean' &&
        fsDoc.emailVerified === liveVerified;
      const providerAligned =
        (fsDoc.authProvider || 'google.com').toLowerCase() ===
        (liveProvider || 'google.com').toLowerCase();
      const roleAligned =
        !fsInspected.contradictoryOwnerFlag &&
        fsDoc.role === authEntry.expectedRole &&
        fsDoc.isOwner === authEntry.expectedIsOwner;
      const statusAligned = fsDoc.accountStatus === authEntry.expectedAccountStatus;
      const displayNameAligned =
        !liveDisplayName || fsDoc.displayName.trim() === liveDisplayName;
      const photoAligned = !livePhotoUrl || fsDoc.photoUrl.trim() === livePhotoUrl;

      if (!roleAligned) {
        hasCorruptedOrPrivilegeIssue = true;
        if (ownershipMisflagged) {
          details.push(
            authEntry.expectedIsOwner
              ? `Principal Owner mis-flagged in Firestore (role="${fsDoc.role}", isOwner=${String(fsDoc.isOwner)})`
              : `Rogue ownership privilege in Firestore (role="${fsDoc.role}", isOwner=${String(fsDoc.isOwner)})`
          );
        } else {
          details.push(
            `Role mismatch: Auth expects "${authEntry.expectedRole}", Firestore has "${fsDoc.role}"`
          );
        }
      }

      if (!statusAligned) {
        hasCorruptedOrPrivilegeIssue = true;
        details.push(
          `Account posture mismatch: Auth expects "${authEntry.expectedAccountStatus}", Firestore has "${fsDoc.accountStatus}"`
        );
      }

      if (!emailAligned) {
        hasDrift = true;
        details.push(
          `Email discrepancy: Google Sign-In "${liveEmail}" vs Firestore "${fsDoc.email}"`
        );
      }
      if (!verifiedAligned) {
        hasDrift = true;
        details.push(
          `Email verification discrepancy: Google Sign-In verified=${String(liveVerified)} vs Firestore verified=${String(fsDoc.emailVerified)}`
        );
      }
      if (!providerAligned) {
        hasDrift = true;
        details.push(
          `Auth provider drift: Google Sign-In "${liveProvider}" vs Firestore "${fsDoc.authProvider}"`
        );
      }
      if (!displayNameAligned) {
        hasDrift = true;
        details.push(
          `Display name drift: Google Sign-In "${liveDisplayName}" vs Firestore "${fsDoc.displayName || 'empty'}"`
        );
      }
      if (!photoAligned) {
        hasDrift = true;
        details.push('Avatar photo URL out of sync with Google Sign-In profile');
      }

      const comparisons: AttributeComparisonRow[] = [
        {
          key: 'uid',
          label: 'UID Link Binding',
          googleValue: uid,
          firestoreValue: fsInspected.rawUid || '(missing uid)',
          aligned: uidAligned,
          severity: uidAligned ? 'ok' : 'critical',
        },
        {
          key: 'email',
          label: 'Account Email',
          googleValue: liveEmail,
          firestoreValue: fsDoc.email,
          aligned: emailAligned,
          severity: emailAligned ? 'ok' : 'warning',
        },
        {
          key: 'verified',
          label: 'Google Email Verified',
          googleValue: liveVerified ? 'true (Verified)' : 'false (Unverified)',
          firestoreValue:
            typeof fsInspected.rawEmailVerified === 'boolean'
              ? `${String(fsDoc.emailVerified)} (${fsDoc.emailVerified ? 'Verified' : 'Unverified'})`
              : `Corrupted (${String(fsInspected.rawEmailVerified)})`,
          aligned: verifiedAligned,
          severity: verifiedAligned ? 'ok' : 'warning',
        },
        {
          key: 'role',
          label: 'Studio Role & Owner Flag',
          googleValue: `${authEntry.expectedRole} · isOwner=${String(authEntry.expectedIsOwner)}`,
          firestoreValue: `${fsInspected.rawRole || fsDoc.role} · isOwner=${String(fsInspected.rawIsOwner)}`,
          aligned: roleAligned,
          severity: roleAligned ? 'ok' : 'critical',
        },
        {
          key: 'status',
          label: 'Account Access Status',
          googleValue: authEntry.expectedAccountStatus,
          firestoreValue: fsInspected.rawAccountStatus || fsDoc.accountStatus,
          aligned: statusAligned,
          severity: statusAligned ? 'ok' : 'critical',
        },
        {
          key: 'provider',
          label: 'OAuth Provider & Profile',
          googleValue: `${formatProviderLabel(liveProvider)} · ${liveDisplayName || 'No name'}`,
          firestoreValue: `${formatProviderLabel(fsDoc.authProvider)} · ${fsDoc.displayName || 'No name'}`,
          aligned: providerAligned && displayNameAligned && photoAligned,
          severity: providerAligned && displayNameAligned && photoAligned ? 'ok' : 'warning',
        },
      ];

      let state: LinkDiscrepancyState = 'healthy';
      let discrepancyHeadline = 'Synchronized Link';
      if (hasCorruptedOrPrivilegeIssue) {
        state = 'corrupted_link';
        discrepancyHeadline = fsInspected.isCorruptedSchema
          ? 'Corrupted Firestore Schema'
          : ownershipMisflagged
            ? 'Ownership Privilege Mismatch'
            : 'Role / Posture Discrepancy';
      } else if (hasDrift || authEntry.sqlIssues.length > 0) {
        state = 'metadata_drift';
        discrepancyHeadline = 'Identity Metadata Drift';
      }

      evaluated.push({
        uid,
        userId: typeof authEntry.userId === 'number' ? authEntry.userId : null,
        displayName: liveDisplayName || fsDoc.displayName || 'Dispatch Member',
        email: liveEmail,
        photoUrl: livePhotoUrl || fsDoc.photoUrl,
        authProvider: liveProvider,
        emailVerified: liveVerified,
        isActiveCaller: isCallerRow,
        expectedRole: authEntry.expectedRole,
        expectedIsOwner: authEntry.expectedIsOwner,
        expectedAccountStatus: authEntry.expectedAccountStatus,
        storedSqlRole: authEntry.storedRole,
        sqlIssues: authEntry.sqlIssues,
        firestoreInspected: fsInspected,
        firestoreChecked: true,
        state,
        needsRemediation: state !== 'healthy',
        ownershipMisflagged,
        discrepancyHeadline,
        discrepancyDetails: details,
        comparisons,
      });
    });

    const priorityOrder: Record<LinkDiscrepancyState, number> = {
      corrupted_link: 0,
      missing_firestore: 1,
      orphaned_firestore: 2,
      metadata_drift: 3,
      healthy: 4,
      isolated_scope: 5,
    };

    return evaluated.sort((a, b) => {
      if (a.isActiveCaller !== b.isActiveCaller) return a.isActiveCaller ? -1 : 1;
      const pDiff = priorityOrder[a.state] - priorityOrder[b.state];
      if (pDiff !== 0) return pDiff;
      return a.email.localeCompare(b.email);
    });
  }, [
    callerRole,
    currentUser,
    firestoreMap,
    isVerifiedPrincipalCaller,
    overviewUsers,
    sqlDiagnostics,
  ]);

  // 4. Quantitative Summary Metrics & Attribute Parity Calculations
  const metrics = useMemo(() => {
    const inspectable = linkRecords.filter((r) => r.state !== 'isolated_scope');
    const total = inspectable.length;
    const healthy = inspectable.filter((r) => r.state === 'healthy').length;
    const missing = inspectable.filter((r) => r.state === 'missing_firestore').length;
    const corrupted = inspectable.filter((r) => r.state === 'corrupted_link').length;
    const drift = inspectable.filter((r) => r.state === 'metadata_drift').length;
    const orphaned = inspectable.filter((r) => r.state === 'orphaned_firestore').length;
    const needsRemediation = linkRecords.filter((r) => r.needsRemediation).length;

    const nonOrphanInspectable = inspectable.filter(
      (r) => r.state !== 'orphaned_firestore'
    );
    const denom = Math.max(1, nonOrphanInspectable.length);

    const linkedDocs = nonOrphanInspectable.filter(
      (r) =>
        r.firestoreInspected !== null && !r.firestoreInspected.uidMismatch
    ).length;
    const emailVerifiedAligned = nonOrphanInspectable.filter((r) => {
      const emailRow = r.comparisons.find((c) => c.key === 'email');
      const verRow = r.comparisons.find((c) => c.key === 'verified');
      return Boolean(r.firestoreInspected && emailRow?.aligned && verRow?.aligned);
    }).length;
    const roleOwnerAligned = nonOrphanInspectable.filter((r) => {
      const roleRow = r.comparisons.find((c) => c.key === 'role');
      return Boolean(r.firestoreInspected && roleRow?.aligned);
    }).length;
    const statusAlignedCount = nonOrphanInspectable.filter((r) => {
      const statusRow = r.comparisons.find((c) => c.key === 'status');
      return Boolean(r.firestoreInspected && statusRow?.aligned);
    }).length;
    const providerAlignedCount = nonOrphanInspectable.filter((r) => {
      const provRow = r.comparisons.find((c) => c.key === 'provider');
      return Boolean(r.firestoreInspected && provRow?.aligned);
    }).length;

    return {
      total,
      healthy,
      missing,
      corrupted,
      drift,
      orphaned,
      needsRemediation,
      healthPct: total > 0 ? Math.round((healthy / total) * 100) : 100,
      parityRows: [
        {
          id: 'link',
          label: 'Firestore Profile Link (/userProfiles/{uid})',
          matched: linkedDocs,
          total: nonOrphanInspectable.length,
          pct:
            nonOrphanInspectable.length > 0
              ? Math.round((linkedDocs / denom) * 100)
              : 100,
        },
        {
          id: 'email',
          label: 'Google Email & Verification Claim',
          matched: emailVerifiedAligned,
          total: nonOrphanInspectable.length,
          pct:
            nonOrphanInspectable.length > 0
              ? Math.round((emailVerifiedAligned / denom) * 100)
              : 100,
        },
        {
          id: 'role',
          label: 'Ownership & Studio RBAC Privileges',
          matched: roleOwnerAligned,
          total: nonOrphanInspectable.length,
          pct:
            nonOrphanInspectable.length > 0
              ? Math.round((roleOwnerAligned / denom) * 100)
              : 100,
        },
        {
          id: 'status',
          label: 'Account Access Posture (Active / Suspended)',
          matched: statusAlignedCount,
          total: nonOrphanInspectable.length,
          pct:
            nonOrphanInspectable.length > 0
              ? Math.round((statusAlignedCount / denom) * 100)
              : 100,
        },
        {
          id: 'provider',
          label: 'OAuth Provider & Display Metadata',
          matched: providerAlignedCount,
          total: nonOrphanInspectable.length,
          pct:
            nonOrphanInspectable.length > 0
              ? Math.round((providerAlignedCount / denom) * 100)
              : 100,
        },
      ],
    };
  }, [linkRecords]);

  useEffect(() => {
    onDiscrepancyCountChange?.(metrics.needsRemediation);
  }, [metrics.needsRemediation, onDiscrepancyCountChange]);

  const callerLinkRecord = useMemo(
    () => linkRecords.find((r) => r.isActiveCaller) ?? null,
    [linkRecords]
  );

  const filteredLinks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return linkRecords.filter((row) => {
      if (activeFilter === 'needs_remediation' && !row.needsRemediation) return false;
      if (
        activeFilter !== 'all' &&
        activeFilter !== 'needs_remediation' &&
        row.state !== activeFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        row.email.toLowerCase().includes(q) ||
        row.displayName.toLowerCase().includes(q) ||
        row.uid.toLowerCase().includes(q) ||
        row.discrepancyHeadline.toLowerCase().includes(q) ||
        row.discrepancyDetails.some((d) => d.toLowerCase().includes(q))
      );
    });
  }, [activeFilter, linkRecords, searchQuery]);

  // 5. One-Click Automatic Remediation Handler (All Discrepancies or Targeted Single Link)
  const handleRemediateLinks = useCallback(
    async (targetRecord?: UnifiedAuthLinkRecord) => {
      if (!auth.currentUser) {
        onSurfaceError('Active Google Sign-In session is required to remediate user links.');
        return;
      }

      onSurfaceError(null);
      onSurfaceNotice(null);

      if (targetRecord) {
        setRemediatingUid(targetRecord.uid);
      } else {
        setIsRemediatingAll(true);
      }

      try {
        // Step A: Reload live Google Sign-In user & mint a fresh ID token
        await reload(auth.currentUser);
        const liveUser = auth.currentUser;
        const freshToken = await liveUser.getIdToken(true);
        const callerIsPrincipal = Boolean(
          liveUser.emailVerified &&
            liveUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
        );

        let createdProfiles = 0;
        let recreatedCorrupted = 0;
        let updatedProfiles = 0;
        let orphansRemoved = 0;
        let misflaggedOwnersFixed = 0;

        // Handle targeted orphaned Firestore document removal
        if (targetRecord && targetRecord.state === 'orphaned_firestore') {
          if (!callerIsPrincipal) {
            throw new Error(
              'Only the verified Principal Owner can remove orphaned Firestore profile documents.'
            );
          }
          const removed = await removeOrphanedFirestoreProfileAsPrincipalOwner(
            targetRecord.uid,
            liveUser.uid
          );
          if (removed) orphansRemoved += 1;

          await logOwnerFirestoreRepairSync(freshToken, {
            source: 'sync_auth',
            firestoreSummary: {
              scanned: 1,
              created: 0,
              repaired: 0,
              corruptedRecreated: 0,
              orphansRemoved,
              misflaggedOwners: targetRecord.ownershipMisflagged ? 1 : 0,
            },
          });

          const refreshedFs = await fetchInspectedFirestoreProfilesMap(
            liveUser,
            callerIsPrincipal
          );
          setFirestoreMap(refreshedFs);
          await onAfterRemediate();

          const singleReceipt: RemediationReceipt = {
            completedAtIso: new Date().toISOString(),
            evaluatedLinks: 1,
            createdProfiles: 0,
            recreatedCorrupted: 0,
            updatedProfiles: 0,
            orphansRemoved,
            sqlRepaired: 0,
            misflaggedOwnersFixed: targetRecord.ownershipMisflagged ? 1 : 0,
          };
          setReceipt(singleReceipt);
          onSurfaceNotice(
            `Removed orphaned Firestore profile /userProfiles/${targetRecord.uid}.`
          );
          return;
        }

        // Step B: Repair Cloud SQL identity metadata & fetch authoritative user diagnostics
        const sqlRepairReport = await runOwnerRepairAuth(freshToken, {
          mode: 'repair',
          targetUserId:
            targetRecord && typeof targetRecord.userId === 'number'
              ? targetRecord.userId
              : undefined,
          displayName: liveUser.displayName || '',
          photoUrl: liveUser.photoURL || '',
        });

        // Step C: Remediate missing, corrupted, or drifted Firestore /userProfiles links
        const currentFsMap = await fetchInspectedFirestoreProfilesMap(
          liveUser,
          callerIsPrincipal
        );

        if (callerIsPrincipal) {
          for (const diag of sqlRepairReport.users) {
            const existingFs = currentFsMap.get(diag.uid) ?? null;
            const matchingRow = linkRecords.find((r) => r.uid === diag.uid);
            const shouldRemediate =
              Boolean(targetRecord) ||
              diag.uid === liveUser.uid ||
              diag.sqlRepaired ||
              !existingFs ||
              existingFs.isCorruptedSchema ||
              Boolean(matchingRow?.needsRemediation);

            if (!shouldRemediate) continue;

            const writeResult = await upsertFirestoreProfileAsPrincipalOwner(
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
              'sync_auth',
              {
                forceRecreate: Boolean(existingFs?.isCorruptedSchema),
              }
            );

            if (writeResult.action === 'created') createdProfiles += 1;
            if (writeResult.action === 'recreated') recreatedCorrupted += 1;
            if (writeResult.action === 'updated') updatedProfiles += 1;
            if (matchingRow?.ownershipMisflagged) misflaggedOwnersFixed += 1;
          }

          // When running full bulk remediation, also clean up any orphaned Firestore documents
          if (!targetRecord) {
            const validAuthUids = new Set(sqlRepairReport.users.map((u) => u.uid));
            validAuthUids.add(liveUser.uid);

            for (const [docId] of currentFsMap.entries()) {
              if (!validAuthUids.has(docId) && docId !== liveUser.uid) {
                const removed = await removeOrphanedFirestoreProfileAsPrincipalOwner(
                  docId,
                  liveUser.uid
                );
                if (removed) orphansRemoved += 1;
              }
            }
          }
        } else {
          // Verified Studio Admin self-session remediation
          const selfRes = await syncCallerFirestoreProfile(
            liveUser,
            {
              role: callerRole === 'admin' ? 'admin' : 'member',
              accountStatus: 'active',
            },
            'sync_auth'
          );
          if (selfRes.synced) updatedProfiles += 1;
        }

        // Step D: Record tamper-evident audit trail entry
        await logOwnerFirestoreRepairSync(freshToken, {
          source: 'sync_auth',
          targetUserId:
            targetRecord && typeof targetRecord.userId === 'number'
              ? targetRecord.userId
              : undefined,
          firestoreSummary: {
            scanned: sqlRepairReport.users.length + orphansRemoved,
            created: createdProfiles,
            repaired: updatedProfiles + sqlRepairReport.repairedCount,
            corruptedRecreated: recreatedCorrupted,
            orphansRemoved,
            misflaggedOwners: misflaggedOwnersFixed,
          },
        });

        // Step E: Re-scan full state so UI reflects verified post-remediation parity
        const postScanReport = await runOwnerRepairAuth(freshToken, {
          mode: 'scan',
          displayName: liveUser.displayName || '',
          photoUrl: liveUser.photoURL || '',
        });
        setSqlDiagnostics(postScanReport.users);

        const refreshedFs = await fetchInspectedFirestoreProfilesMap(
          liveUser,
          callerIsPrincipal
        );
        setFirestoreMap(refreshedFs);
        setLastScannedAtIso(new Date().toISOString());

        await onAfterRemediate();

        const nextReceipt: RemediationReceipt = {
          completedAtIso: new Date().toISOString(),
          evaluatedLinks: postScanReport.users.length,
          createdProfiles,
          recreatedCorrupted,
          updatedProfiles,
          orphansRemoved,
          sqlRepaired: sqlRepairReport.repairedCount,
          misflaggedOwnersFixed,
        };
        setReceipt(nextReceipt);

        const totalFixed =
          createdProfiles +
          recreatedCorrupted +
          updatedProfiles +
          orphansRemoved +
          sqlRepairReport.repairedCount;

        onSurfaceNotice(
          totalFixed > 0
            ? `Sync Auth remediated ${totalFixed} user link ${totalFixed === 1 ? 'operation' : 'operations'} (${createdProfiles} created · ${recreatedCorrupted} corrupted rebuilt · ${updatedProfiles} updated · ${orphansRemoved} orphaned removed).`
            : 'Sync Auth verified all Google Sign-In tokens and Firestore /userProfiles links — zero discrepancies remain.'
        );
      } catch (err) {
        onSurfaceError(
          err instanceof Error
            ? err.message
            : 'Automatic user link remediation encountered an error.'
        );
      } finally {
        setIsRemediatingAll(false);
        setRemediatingUid(null);
      }
    },
    [
      callerRole,
      linkRecords,
      onAfterRemediate,
      onSurfaceError,
      onSurfaceNotice,
    ]
  );

  const segmentShares = useMemo(() => {
    const denom = Math.max(1, metrics.total);
    const raw = [
      {
        id: 'healthy' as const,
        label: 'Synchronized',
        count: metrics.healthy,
        pct: Math.round((metrics.healthy / denom) * 100),
        barClass: 'bg-[#16A34A]',
        fillClass: 'fill-[#16A34A]',
        textClass: 'text-[#16A34A]',
      },
      {
        id: 'missing_firestore' as const,
        label: 'Missing Profile',
        count: metrics.missing,
        pct: Math.round((metrics.missing / denom) * 100),
        barClass: 'bg-[#D97706]',
        fillClass: 'fill-[#D97706]',
        textClass: 'text-amber-300',
      },
      {
        id: 'corrupted_link' as const,
        label: 'Corrupted / Privilege',
        count: metrics.corrupted,
        pct: Math.round((metrics.corrupted / denom) * 100),
        barClass: 'bg-[#DC2626]',
        fillClass: 'fill-[#DC2626]',
        textClass: 'text-[#FCA5A5]',
      },
      {
        id: 'metadata_drift' as const,
        label: 'Metadata Drift',
        count: metrics.drift,
        pct: Math.round((metrics.drift / denom) * 100),
        barClass: 'bg-[#22D3EE]',
        fillClass: 'fill-[#22D3EE]',
        textClass: 'text-[#67E8F9]',
      },
      {
        id: 'orphaned_firestore' as const,
        label: 'Orphaned Doc',
        count: metrics.orphaned,
        pct: Math.round((metrics.orphaned / denom) * 100),
        barClass: 'bg-[#64748B]',
        fillClass: 'fill-[#64748B]',
        textClass: 'text-[#9BA6B8]',
      },
    ];

    let runningOffset = 0;
    return raw.map((seg) => {
      const exactSpan = metrics.total > 0 ? (seg.count / metrics.total) * 100 : 0;
      const x = runningOffset;
      runningOffset += exactSpan;
      return {
        ...seg,
        svgX: x,
        svgWidth: exactSpan,
      };
    });
  }, [metrics]);

  return (
    <section className="space-y-5" aria-label="Sync Auth Reconciliation Dashboard">
      {/* Layer 1: Command & One-Click Remediation Header */}
      <div className="bg-[#13161C] border border-[#222833] rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1.5 min-w-0">
          <div className="flex items-center gap-2.5">
            <ArrowRightLeft
              className="w-4 h-4 text-[#22D3EE] shrink-0"
              aria-hidden="true"
            />
            <h2 className="text-base font-semibold text-[#F5F7FA] tracking-tight">
              Sync Auth — Google Sign-In &amp; Firestore Profile Reconciliation
            </h2>
          </div>

          <div className="flex items-center gap-2 flex-wrap text-xs text-[#8C96A8]">
            <span className="inline-flex items-center gap-1.5 text-[#D5DCE6]">
              {metrics.needsRemediation === 0 ? (
                <CheckCircle2
                  className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <AlertTriangle
                  className="w-3.5 h-3.5 text-[#D97706] shrink-0"
                  aria-hidden="true"
                />
              )}
              <span className="font-mono tabular-nums">
                {metrics.healthy}/{metrics.total} links synchronized ({metrics.healthPct}%)
              </span>
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              {listenerConnected
                ? 'Firestore /userProfiles live stream connected'
                : 'Connecting Firestore /userProfiles listener'}
            </span>
            {lastScannedAtIso && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  Token verified {formatClockStamp(lastScannedAtIso)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap shrink-0">
          <button
            type="button"
            disabled={isScanning || isRemediatingAll || remediatingUid !== null}
            onClick={() => void runLiveAuthScan()}
            className="h-10 px-4 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] hover:border-[#22D3EE]/50 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-[#22D3EE]' : ''}`}
              aria-hidden="true"
            />
            Scan &amp; Refresh Token
          </button>

          <button
            type="button"
            disabled={isRemediatingAll || isScanning || remediatingUid !== null}
            onClick={() => void handleRemediateLinks()}
            className="h-10 px-4 inline-flex items-center gap-2 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isRemediatingAll ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : metrics.needsRemediation > 0 ? (
              <Zap className="w-4 h-4" aria-hidden="true" />
            ) : (
              <ShieldCheck className="w-4 h-4" aria-hidden="true" />
            )}
            {metrics.needsRemediation > 0
              ? `Remediate ${metrics.needsRemediation} User ${metrics.needsRemediation === 1 ? 'Link' : 'Links'}`
              : 'Verify & Re-Sync All Links'}
          </button>
        </div>
      </div>

      {/* Remediation Receipt Banner */}
      {receipt && (
        <div
          role="status"
          className="bg-[#13161C] border border-[#22D3EE]/40 rounded-lg px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
        >
          <div className="flex items-center gap-2 flex-wrap text-[#D5DCE6] font-mono tabular-nums">
            <CheckCircle2
              className="w-4 h-4 text-[#16A34A] shrink-0"
              aria-hidden="true"
            />
            <span className="font-sans font-medium text-[#F5F7FA]">
              Remediation Complete
            </span>
            <span aria-hidden="true">·</span>
            <span>{receipt.evaluatedLinks} evaluated</span>
            <span aria-hidden="true">·</span>
            <span>{receipt.createdProfiles} missing created</span>
            <span aria-hidden="true">·</span>
            <span>{receipt.recreatedCorrupted} corrupted rebuilt</span>
            <span aria-hidden="true">·</span>
            <span>{receipt.updatedProfiles} updated</span>
            {receipt.orphansRemoved > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{receipt.orphansRemoved} orphaned removed</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="text-[#8C96A8]">
              {formatClockStamp(receipt.completedAtIso)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setReceipt(null)}
            className="text-xs text-[#8C96A8] hover:text-[#F5F7FA] whitespace-nowrap shrink-0 cursor-pointer"
          >
            Dismiss Receipt
          </button>
        </div>
      )}

      {/* Layer 2: Discrepancy Visualization Split (7 Cols Proportional Parity + 5 Cols Active Session Bridge) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Left: Discrepancy Distribution & Attribute Parity Matrix */}
        <div className="lg:col-span-7 bg-[#13161C] border border-[#222833] rounded-lg p-5 flex flex-col justify-between space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold text-[#F5F7FA]">
                Discrepancy Distribution Across Registered Identities
              </h3>
              <span className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
                {metrics.needsRemediation === 0
                  ? '0 discrepancies'
                  : `${metrics.needsRemediation} requiring remediation`}
              </span>
            </div>

            {/* Proportional Stacked Bar */}
            <svg
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              className="h-3 w-full rounded bg-[#0E1116] border border-[#1F2532] overflow-hidden block"
              role="img"
              aria-label={`Link alignment distribution: ${metrics.healthy} synchronized, ${metrics.missing} missing Firestore profile, ${metrics.corrupted} corrupted or privilege mismatch, ${metrics.drift} metadata drift, ${metrics.orphaned} orphaned`}
            >
              {metrics.total === 0 ? (
                <rect x={0} y={0} width={100} height={10} className="fill-[#1C2432]" />
              ) : (
                segmentShares.map((seg) =>
                  seg.count > 0 ? (
                    <rect
                      key={seg.id}
                      x={seg.svgX}
                      y={0}
                      width={seg.svgWidth}
                      height={10}
                      className={seg.fillClass}
                    >
                      <title>{`${seg.label}: ${seg.count} (${seg.pct}%)`}</title>
                    </rect>
                  ) : null
                )
              )}
            </svg>

            {/* Interactive Segment Breakdown Legend */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
              {segmentShares.map((seg) => {
                const isSelected = activeFilter === seg.id;
                return (
                  <button
                    key={seg.id}
                    type="button"
                    onClick={() =>
                      setActiveFilter((prev) => (prev === seg.id ? 'all' : seg.id))
                    }
                    className={`p-2.5 rounded border text-left transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#18212E] border-[#22D3EE]'
                        : 'bg-[#0E1116] border-[#1F2532] hover:border-[#2A3342]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] text-[#9BA6B8] whitespace-nowrap truncate">
                      <span
                        className={`w-2 h-2 rounded-xs shrink-0 ${seg.barClass}`}
                        aria-hidden="true"
                      />
                      <span className="truncate">{seg.label}</span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-1 font-mono tabular-nums">
                      <span className={`text-sm font-semibold ${seg.textClass}`}>
                        {seg.count}
                      </span>
                      <span className="text-[10px] text-[#6E788A]">{seg.pct}%</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Field-Level Attribute Parity Bars */}
          <div className="pt-4 border-t border-[#1F2532] space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[#F5F7FA]">
                Attribute-Level Parity (Google Sign-In ↔ Firestore)
              </span>
              <span className="font-mono text-[11px] text-[#8C96A8] tabular-nums">
                Matched / Inspectable
              </span>
            </div>

            <div className="space-y-2">
              {metrics.parityRows.map((item) => (
                <div key={item.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-[#C7D0DF] truncate">{item.label}</span>
                    <span className="font-mono text-[11px] text-[#D5DCE6] tabular-nums whitespace-nowrap shrink-0">
                      {item.matched}/{item.total} ({item.pct}%)
                    </span>
                  </div>
                  <svg
                    viewBox="0 0 100 6"
                    preserveAspectRatio="none"
                    className="h-1.5 w-full bg-[#0E1116] rounded overflow-hidden block"
                    aria-hidden="true"
                  >
                    <rect
                      x={0}
                      y={0}
                      width={item.pct}
                      height={6}
                      className={
                        item.pct === 100
                          ? 'fill-[#16A34A]'
                          : item.pct >= 75
                            ? 'fill-[#22D3EE]'
                            : 'fill-[#D97706]'
                      }
                    />
                  </svg>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Active Session Identity Link Bridge */}
        <div className="lg:col-span-5 bg-[#13161C] border border-[#222833] rounded-lg p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <UserCheck
                  className="w-4 h-4 text-[#22D3EE] shrink-0"
                  aria-hidden="true"
                />
                <h3 className="text-xs font-semibold text-[#F5F7FA]">
                  Active Session Link Bridge
                </h3>
              </div>
              <span className="text-[11px] font-mono text-[#67E8F9] tabular-nums">
                {callerLinkRecord?.state === 'healthy'
                  ? 'Verified Match'
                  : 'Action Needed'}
              </span>
            </div>
            <p className="text-xs text-[#8C96A8]">
              Live comparison between your active Google Sign-In token and{' '}
              <span className="font-mono text-[#C7D0DF]">
                /userProfiles/{currentUser.uid.slice(0, 12)}…
              </span>
            </p>
          </div>

          {callerLinkRecord ? (
            <div className="divide-y divide-[#1C212C] text-xs flex-1">
              {callerLinkRecord.comparisons.map((cmp) => (
                <div
                  key={cmp.key}
                  className="py-2 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-[#8C96A8]">{cmp.label}</div>
                    <div className="font-mono text-[11px] text-[#F5F7FA] truncate max-w-[240px]">
                      {cmp.firestoreValue}
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 font-mono text-[11px] whitespace-nowrap shrink-0 pt-0.5 ${
                      cmp.aligned
                        ? 'text-[#16A34A]'
                        : cmp.severity === 'critical'
                          ? 'text-[#FCA5A5]'
                          : 'text-amber-300'
                    }`}
                  >
                    {cmp.aligned ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        Aligned
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        Discrepancy
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-xs text-[#8C96A8]">
              Evaluating active Google Sign-In session...
            </div>
          )}

          <div className="pt-3 border-t border-[#1F2532] flex items-center justify-between gap-3">
            <span className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
              {callerLinkRecord?.firestoreInspected?.parsed.lastSyncedAtIso
                ? `Last synced ${formatShortRelative(callerLinkRecord.firestoreInspected.parsed.lastSyncedAtIso)}`
                : 'Not yet written to Firestore'}
            </span>

            {callerLinkRecord && (
              <button
                type="button"
                disabled={
                  isRemediatingAll || remediatingUid === callerLinkRecord.uid
                }
                onClick={() => void handleRemediateLinks(callerLinkRecord)}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] disabled:opacity-50 rounded whitespace-nowrap shrink-0 cursor-pointer"
              >
                {remediatingUid === callerLinkRecord.uid ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {callerLinkRecord.needsRemediation
                  ? 'Remediate My Link'
                  : 'Re-Sync Session'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Layer 3: Search, Discrepancy Filter Controls & Side-by-Side Comparison Matrix */}
      <div className="space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search
              className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search links by email, name, UID, or discrepancy..."
              className="w-full h-9 pl-8 pr-3 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] placeholder:text-[#6E788A] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md overflow-x-auto">
            {(
              [
                { id: 'all', label: `All Links (${linkRecords.length})` },
                {
                  id: 'needs_remediation',
                  label: `Needs Remediation (${metrics.needsRemediation})`,
                },
                { id: 'missing_firestore', label: `Missing (${metrics.missing})` },
                { id: 'corrupted_link', label: `Corrupted (${metrics.corrupted})` },
                { id: 'metadata_drift', label: `Drift (${metrics.drift})` },
                ...(metrics.orphaned > 0
                  ? [
                      {
                        id: 'orphaned_firestore' as const,
                        label: `Orphaned (${metrics.orphaned})`,
                      },
                    ]
                  : []),
                { id: 'healthy', label: `Healthy (${metrics.healthy})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveFilter(tab.id)}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums ${
                  activeFilter === tab.id
                    ? 'bg-[#1C2533] text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Discrepancy Comparison Table */}
        <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                  <th className="py-3 px-4">User Identity &amp; UID</th>
                  <th className="py-3 px-4">Google Sign-In Status</th>
                  <th className="py-3 px-4">Firestore Profile (/userProfiles)</th>
                  <th className="py-3 px-4">Link Discrepancy</th>
                  <th className="py-3 px-4 text-right">Remediation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1C212C] text-xs">
                {isScanning && linkRecords.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-[#8C96A8]">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" />
                        Reconciling Google Sign-In tokens with Firestore /userProfiles...
                      </span>
                    </td>
                  </tr>
                ) : filteredLinks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-[#8C96A8]">
                      No user links match the active filter.{' '}
                      {activeFilter !== 'all' && (
                        <button
                          type="button"
                          onClick={() => setActiveFilter('all')}
                          className="text-[#67E8F9] hover:underline ml-1 cursor-pointer"
                        >
                          Show all {linkRecords.length} links
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredLinks.map((row) => {
                    const isExpanded = expandedUid === row.uid;
                    const isRowBusy =
                      isRemediatingAll || remediatingUid === row.uid;
                    const canRemediateRow = isOwner || row.isActiveCaller;
                    const fsDoc = row.firestoreInspected?.parsed ?? null;

                    return (
                      <Fragment key={row.uid}>
                        <tr
                          className={`transition-colors ${
                            isExpanded ? 'bg-[#18212E]/75' : 'hover:bg-[#171B23]'
                          }`}
                        >
                          {/* Column 1: User Identity & UID */}
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2.5">
                              {row.photoUrl && !failedAvatarUids[row.uid] ? (
                                <img
                                  src={row.photoUrl}
                                  alt={row.displayName || row.email}
                                  referrerPolicy="no-referrer"
                                  onError={() =>
                                    setFailedAvatarUids((prev) => ({
                                      ...prev,
                                      [row.uid]: true,
                                    }))
                                  }
                                  className="w-7 h-7 rounded-full object-cover shrink-0"
                                />
                              ) : (
                                <span className="w-7 h-7 rounded-full bg-[#1C2432] text-[#67E8F9] inline-flex items-center justify-center text-[11px] font-semibold shrink-0">
                                  {(row.displayName || row.email || 'U')
                                    .charAt(0)
                                    .toUpperCase()}
                                </span>
                              )}
                              <div className="min-w-0">
                                <div className="font-medium text-[#F5F7FA] truncate max-w-[210px]">
                                  {row.displayName}
                                  {row.isActiveCaller ? ' · Active Session' : ''}
                                </div>
                                <div className="text-[11px] font-mono text-[#8C96A8] truncate max-w-[225px] tabular-nums">
                                  {row.email} · {row.uid.slice(0, 10)}…
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Column 2: Google Sign-In Status */}
                          <td className="py-3 px-4 whitespace-nowrap">
                            {row.state === 'orphaned_firestore' ? (
                              <div className="space-y-0.5">
                                <span className="inline-flex items-center gap-1.5 text-[#FCA5A5] font-medium">
                                  <Link2Off
                                    className="w-3.5 h-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                  No Google Sign-In Account
                                </span>
                                <div className="text-[11px] font-mono text-[#6E788A]">
                                  Absent from identity registry
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-0.5">
                                <div className="flex items-center gap-1.5 text-[#D5DCE6]">
                                  {row.emailVerified ? (
                                    <CheckCircle2
                                      className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <AlertTriangle
                                      className="w-3.5 h-3.5 text-[#D97706] shrink-0"
                                      aria-hidden="true"
                                    />
                                  )}
                                  <span className="font-medium">
                                    {row.emailVerified ? 'Verified' : 'Unverified'}
                                  </span>
                                  <span className="text-[#6E788A]" aria-hidden="true">
                                    ·
                                  </span>
                                  <span className="text-[#8C96A8]">
                                    {formatProviderLabel(row.authProvider)}
                                  </span>
                                </div>
                                <div className="text-[11px] font-mono text-[#6E788A] tabular-nums">
                                  {formatRoleTitle(row.expectedRole)} ·{' '}
                                  {row.expectedAccountStatus}
                                </div>
                              </div>
                            )}
                          </td>

                          {/* Column 3: Firestore Profile (/userProfiles) */}
                          <td className="py-3 px-4 whitespace-nowrap">
                            {!row.firestoreChecked ? (
                              <span className="text-[#8C96A8]">
                                Principal Owner Scope (PII Isolated)
                              </span>
                            ) : !fsDoc ? (
                              <div className="space-y-0.5">
                                <span className="inline-flex items-center gap-1.5 text-amber-300 font-medium">
                                  <Link2Off
                                    className="w-3.5 h-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                  Missing /userProfiles Doc
                                </span>
                                <div className="text-[11px] font-mono text-[#6E788A]">
                                  Link not yet provisioned
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-0.5 font-mono">
                                <div className="text-[#D5DCE6] tabular-nums">
                                  role: {fsDoc.role} · isOwner: {String(fsDoc.isOwner)}
                                </div>
                                <div className="text-[11px] text-[#6E788A] tabular-nums">
                                  {fsDoc.accountStatus} · {fsDoc.syncSource} ·{' '}
                                  {formatShortRelative(fsDoc.lastSyncedAtIso)}
                                </div>
                              </div>
                            )}
                          </td>

                          {/* Column 4: Discrepancy Diagnosis */}
                          <td className="py-3 px-4 max-w-sm">
                            {row.state === 'healthy' ? (
                              <span className="inline-flex items-center gap-1.5 text-[#D5DCE6] font-medium">
                                <CheckCircle2
                                  className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                                  aria-hidden="true"
                                />
                                Synchronized Link
                              </span>
                            ) : row.state === 'isolated_scope' ? (
                              <span className="text-[#8C96A8]">
                                SQL Verified · Firestore Restricted
                              </span>
                            ) : (
                              <div className="space-y-0.5">
                                <span
                                  className={`inline-flex items-center gap-1.5 font-medium ${
                                    row.state === 'corrupted_link' ||
                                    row.state === 'orphaned_firestore'
                                      ? 'text-[#FCA5A5]'
                                      : row.state === 'missing_firestore'
                                        ? 'text-amber-300'
                                        : 'text-[#67E8F9]'
                                  }`}
                                >
                                  {row.state === 'corrupted_link' ||
                                  row.state === 'orphaned_firestore' ? (
                                    <ShieldAlert
                                      className="w-3.5 h-3.5 shrink-0"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <AlertTriangle
                                      className="w-3.5 h-3.5 shrink-0"
                                      aria-hidden="true"
                                    />
                                  )}
                                  {row.discrepancyHeadline}
                                </span>
                                {row.discrepancyDetails[0] && (
                                  <div className="text-[11px] text-[#9BA6B8] leading-snug">
                                    {row.discrepancyDetails[0]}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>

                          {/* Column 5: Actions */}
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {row.firestoreChecked && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedUid((prev) =>
                                      prev === row.uid ? null : row.uid
                                    )
                                  }
                                  className="h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  {isExpanded ? (
                                    <ChevronUp className="w-3 h-3" aria-hidden="true" />
                                  ) : (
                                    <ChevronDown className="w-3 h-3" aria-hidden="true" />
                                  )}
                                  Compare Fields
                                </button>
                              )}

                              <button
                                type="button"
                                disabled={isRowBusy || !canRemediateRow}
                                onClick={() => void handleRemediateLinks(row)}
                                className={`h-8 px-3 inline-flex items-center gap-1.5 text-[11px] font-semibold rounded border disabled:opacity-45 whitespace-nowrap shrink-0 cursor-pointer ${
                                  row.state === 'orphaned_firestore'
                                    ? 'text-[#FCA5A5] bg-[#2A1216] border-[#F87171]/40 hover:border-[#F87171]'
                                    : row.needsRemediation
                                      ? 'text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] border-[#22D3EE]'
                                      : 'text-[#67E8F9] bg-[#18212E] border-[#22D3EE]/40 hover:border-[#22D3EE]'
                                }`}
                              >
                                {remediatingUid === row.uid ? (
                                  <Loader2
                                    className="w-3 h-3 animate-spin"
                                    aria-hidden="true"
                                  />
                                ) : row.state === 'orphaned_firestore' ? (
                                  <Trash2 className="w-3 h-3" aria-hidden="true" />
                                ) : (
                                  <Zap className="w-3 h-3" aria-hidden="true" />
                                )}
                                {row.state === 'orphaned_firestore'
                                  ? 'Remove Orphan'
                                  : row.needsRemediation
                                    ? 'Remediate Link'
                                    : 'Re-Sync'}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* Expandable Side-by-Side Attribute Diff Drawer */}
                        {isExpanded && (
                          <tr className="bg-[#0E1116]">
                            <td colSpan={5} className="px-5 py-4">
                              <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                  <div className="text-xs font-semibold text-[#F5F7FA]">
                                    Field-by-Field Link Comparison —{' '}
                                    <span className="font-mono text-[#67E8F9]">
                                      /userProfiles/{row.uid}
                                    </span>
                                  </div>
                                  {row.discrepancyDetails.length > 1 && (
                                    <div className="text-[11px] text-[#9BA6B8]">
                                      {row.discrepancyDetails.length} total discrepancy
                                      findings
                                    </div>
                                  )}
                                </div>

                                <div className="border border-[#1F2532] rounded overflow-hidden">
                                  <table className="w-full text-left border-collapse text-xs">
                                    <thead>
                                      <tr className="border-b border-[#1F2532] bg-[#13161C] text-[11px] font-medium text-[#8C96A8]">
                                        <th className="py-2 px-3">Profile Attribute</th>
                                        <th className="py-2 px-3">
                                          Google Sign-In / Auth Registry
                                        </th>
                                        <th className="py-2 px-3">
                                          Firestore /userProfiles Value
                                        </th>
                                        <th className="py-2 px-3 text-right">
                                          Alignment
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#1A1F2A] font-mono text-[11px] tabular-nums">
                                      {row.comparisons.map((cmp) => (
                                        <tr key={cmp.key}>
                                          <td className="py-2 px-3 font-sans text-[#C7D0DF]">
                                            {cmp.label}
                                          </td>
                                          <td className="py-2 px-3 text-[#F5F7FA]">
                                            {cmp.googleValue}
                                          </td>
                                          <td
                                            className={`py-2 px-3 ${
                                              cmp.aligned
                                                ? 'text-[#D5DCE6]'
                                                : cmp.severity === 'critical'
                                                  ? 'text-[#FCA5A5]'
                                                  : 'text-amber-300'
                                            }`}
                                          >
                                            {cmp.firestoreValue}
                                          </td>
                                          <td className="py-2 px-3 text-right whitespace-nowrap">
                                            {cmp.aligned ? (
                                              <span className="inline-flex items-center gap-1 text-[#16A34A]">
                                                <CheckCircle2 className="w-3 h-3" />
                                                Match
                                              </span>
                                            ) : (
                                              <span
                                                className={`inline-flex items-center gap-1 ${
                                                  cmp.severity === 'critical'
                                                    ? 'text-[#FCA5A5]'
                                                    : 'text-amber-300'
                                                }`}
                                              >
                                                <AlertTriangle className="w-3 h-3" />
                                                Mismatch
                                              </span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
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
      </div>
    </section>
  );
}
