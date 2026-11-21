import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reload, type User } from 'firebase/auth';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileText,
  Loader2,
  PlusCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { auth } from '../lib/firebase';
import {
  fetchInspectedFirestoreProfilesMap,
  isValidFirestoreProfileUid,
  PRINCIPAL_OWNER_EMAIL,
  subscribeToFirestoreUserProfiles,
  syncCallerFirestoreProfile,
  upsertFirestoreProfileAsPrincipalOwner,
  type InspectedFirestoreUserProfile,
} from '../services/firestoreUserProfile';
import {
  logOwnerFirestoreRepairSync,
  runOwnerRepairAuth,
  runSelfRepairAuth,
  type OwnerAuditedUser,
} from '../services/suiteApi';

export type ProfileCrossRefState =
  | 'missing_entry'
  | 'corrupted_entry'
  | 'provisioned'
  | 'owner_scoped';

type CrossRefFilter =
  | 'all'
  | 'active_sessions'
  | 'missing_entry'
  | 'created_session'
  | 'provisioned';

interface CreatedProfileReceiptItem {
  uid: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'member';
  trigger: 'auto' | 'manual';
  createdAtIso: string;
}

interface CrossReferencedSessionRow {
  uid: string;
  userId: number | null;
  email: string;
  displayName: string;
  photoUrl: string;
  authProvider: string;
  emailVerified: boolean;
  role: 'owner' | 'admin' | 'member';
  accountStatus: 'active' | 'suspended';
  isCurrentBrowserSession: boolean;
  isActiveSessionWindow: boolean;
  sessionStateLabel: string;
  lastActiveAt: string | null;
  lastTokenIssuedAt: string | null;
  lastSeenDevice: string;
  lastSeenIp: string;
  accessFlagged: boolean;
  firestoreDocPath: string;
  firestoreInspected: InspectedFirestoreUserProfile | null;
  canCallerInspectAndWrite: boolean;
  crossRefState: ProfileCrossRefState;
  statusDetail: string;
  wasCreatedThisSession: CreatedProfileReceiptItem | null;
}

interface ProfileRepairUtilityProps {
  currentUser: User;
  callerRole: 'owner' | 'admin' | 'member' | 'guest';
  isOwner: boolean;
  overviewUsers: OwnerAuditedUser[];
  onAfterProfileRepair: () => Promise<void>;
  onOpenRepairAuditLog: () => void;
  onSurfaceError: (message: string | null) => void;
  onSurfaceNotice: (message: string | null) => void;
  onMissingCountChange?: (count: number) => void;
}

function formatProviderName(provider: string): string {
  const clean = (provider || 'google.com').toLowerCase();
  if (clean.includes('google')) return 'Google OAuth';
  if (clean.includes('password')) return 'Email';
  return provider || 'Google OAuth';
}

function formatRoleTitle(role: 'owner' | 'admin' | 'member'): string {
  if (role === 'owner') return 'Ultra Owner';
  if (role === 'admin') return 'Studio Admin';
  return 'Member';
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

export function ProfileRepairUtility({
  currentUser,
  callerRole,
  isOwner,
  overviewUsers,
  onAfterProfileRepair,
  onOpenRepairAuditLog,
  onSurfaceError,
  onSurfaceNotice,
  onMissingCountChange,
}: ProfileRepairUtilityProps) {
  const [firestoreMap, setFirestoreMap] = useState<
    Map<string, InspectedFirestoreUserProfile>
  >(new Map());
  const [firestoreReady, setFirestoreReady] = useState(false);
  const [autoCreateEnabled, setAutoCreateEnabled] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [isExecutingBatch, setIsExecutingBatch] = useState(false);
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [lastCrossRefAtIso, setLastCrossRefAtIso] = useState<string | null>(
    null
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<CrossRefFilter>('all');
  const [createdLedger, setCreatedLedger] = useState<
    Record<string, CreatedProfileReceiptItem>
  >({});

  const attemptedAutoCreateUidsRef = useRef<Set<string>>(new Set());
  const isRunningAutoRef = useRef(false);

  const isVerifiedPrincipalCaller = Boolean(
    isOwner &&
      currentUser.emailVerified &&
      currentUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
  );

  // 1. Real-time Firestore /userProfiles listener
  useEffect(() => {
    if (!currentUser.emailVerified) {
      setFirestoreMap(new Map());
      setFirestoreReady(false);
      return;
    }

    const unsub = subscribeToFirestoreUserProfiles(
      currentUser,
      isVerifiedPrincipalCaller,
      (profiles) => {
        setFirestoreMap(profiles);
        setFirestoreReady(true);
        setLastCrossRefAtIso((prev) => prev || new Date().toISOString());
      },
      (errMessage) => {
        setFirestoreReady(false);
        onSurfaceError(errMessage);
      }
    );

    return () => unsub();
  }, [currentUser, isVerifiedPrincipalCaller, onSurfaceError]);

  // 2. Build unified Cross-Reference Matrix (Active Firebase Auth Sessions <-> Firestore /userProfiles)
  const crossRefRows = useMemo<CrossReferencedSessionRow[]>(() => {
    const liveBrowserUser = auth.currentUser || currentUser;
    const byUid = new Map<string, CrossReferencedSessionRow>();

    // First ingest all server-verified Firebase Auth sessions from Cloud SQL overview
    for (const account of overviewUsers) {
      if (!isValidFirestoreProfileUid(account.uid)) continue;
      const isCurrentBrowser = account.uid === liveBrowserUser.uid;
      const canInspect = isVerifiedPrincipalCaller || isCurrentBrowser;
      const fsDoc = firestoreMap.get(account.uid) || null;

      const isActiveWindow =
        isCurrentBrowser ||
        account.sessionState === 'active_now' ||
        account.sessionState === 'recent_24h';

      const sessionStateLabel = isCurrentBrowser
        ? 'Live Browser Session'
        : account.sessionState === 'active_now'
          ? 'Active Now (<15m)'
          : account.sessionState === 'recent_24h'
            ? 'Active Session (24h)'
            : account.sessionState === 'suspended'
              ? 'Suspended Auth Link'
              : 'Authenticated Link';

      const expectedRole: 'owner' | 'admin' | 'member' =
        account.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL &&
        account.emailVerified
          ? 'owner'
          : account.role === 'admin'
            ? 'admin'
            : 'member';

      const expectedStatus: 'active' | 'suspended' =
        expectedRole === 'owner' ? 'active' : account.accountStatus;

      let crossRefState: ProfileCrossRefState = 'provisioned';
      let statusDetail = 'Firestore /userProfiles record verified';

      if (!canInspect) {
        crossRefState = 'owner_scoped';
        statusDetail = 'Principal Owner scope required for cross-user Firestore read/write';
      } else if (!fsDoc) {
        crossRefState = 'missing_entry';
        statusDetail =
          'Firebase Auth link exists, but Firestore /userProfiles entry is missing';
      } else if (
        fsDoc.isCorruptedSchema ||
        fsDoc.parsed.role !== expectedRole ||
        fsDoc.parsed.accountStatus !== expectedStatus
      ) {
        crossRefState = 'corrupted_entry';
        statusDetail =
          fsDoc.rawSchemaIssues[0] ||
          `Profile role/status drift (${fsDoc.parsed.role}/${fsDoc.parsed.accountStatus} vs ${expectedRole}/${expectedStatus})`;
      }

      byUid.set(account.uid, {
        uid: account.uid,
        userId: account.id,
        email: account.email,
        displayName: account.displayName || 'Dispatch Member',
        photoUrl: account.photoUrl || '',
        authProvider: account.authProvider || 'google.com',
        emailVerified: account.emailVerified,
        role: expectedRole,
        accountStatus: expectedStatus,
        isCurrentBrowserSession: isCurrentBrowser,
        isActiveSessionWindow: isActiveWindow,
        sessionStateLabel,
        lastActiveAt: account.lastActiveAt,
        lastTokenIssuedAt: account.lastTokenIssuedAt,
        lastSeenDevice: account.lastSeenDevice || 'Web Client',
        lastSeenIp: account.lastSeenIp || 'Not recorded yet',
        accessFlagged: Boolean(account.accessPattern?.flagged),
        firestoreDocPath: `/userProfiles/${account.uid}`,
        firestoreInspected: fsDoc,
        canCallerInspectAndWrite: canInspect && (expectedRole === 'owner' || account.emailVerified || isVerifiedPrincipalCaller),
        crossRefState,
        statusDetail,
        wasCreatedThisSession: createdLedger[account.uid] || null,
      });
    }

    // Ensure the live browser Firebase Auth session is always included even before overview finishes loading
    if (
      liveBrowserUser &&
      isValidFirestoreProfileUid(liveBrowserUser.uid) &&
      !byUid.has(liveBrowserUser.uid)
    ) {
      const uid = liveBrowserUser.uid;
      const fsDoc = firestoreMap.get(uid) || null;
      const isPrincipal = Boolean(
        liveBrowserUser.emailVerified &&
          liveBrowserUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
      );
      const resolvedRole: 'owner' | 'admin' | 'member' = isPrincipal
        ? 'owner'
        : callerRole === 'admin'
          ? 'admin'
          : 'member';

      let crossRefState: ProfileCrossRefState = 'provisioned';
      let statusDetail = 'Firestore /userProfiles record verified';
      if (!fsDoc) {
        crossRefState = 'missing_entry';
        statusDetail =
          'Active browser Firebase Auth session has no Firestore /userProfiles entry';
      } else if (fsDoc.isCorruptedSchema) {
        crossRefState = 'corrupted_entry';
        statusDetail = fsDoc.rawSchemaIssues[0] || 'Firestore schema drift detected';
      }

      byUid.set(uid, {
        uid,
        userId: null,
        email: liveBrowserUser.email || `${uid}@dispatch.local`,
        displayName: liveBrowserUser.displayName || 'Current Session',
        photoUrl: liveBrowserUser.photoURL || '',
        authProvider:
          liveBrowserUser.providerData?.[0]?.providerId || 'google.com',
        emailVerified: liveBrowserUser.emailVerified,
        role: resolvedRole,
        accountStatus: 'active',
        isCurrentBrowserSession: true,
        isActiveSessionWindow: true,
        sessionStateLabel: 'Live Browser Session',
        lastActiveAt:
          liveBrowserUser.metadata?.lastSignInTime || new Date().toISOString(),
        lastTokenIssuedAt:
          liveBrowserUser.metadata?.lastSignInTime || null,
        lastSeenDevice: 'Active Browser Client',
        lastSeenIp: 'Verifying session IP',
        accessFlagged: false,
        firestoreDocPath: `/userProfiles/${uid}`,
        firestoreInspected: fsDoc,
        canCallerInspectAndWrite: Boolean(liveBrowserUser.emailVerified),
        crossRefState,
        statusDetail,
        wasCreatedThisSession: createdLedger[uid] || null,
      });
    }

    const statePriority: Record<ProfileCrossRefState, number> = {
      missing_entry: 0,
      corrupted_entry: 1,
      provisioned: 2,
      owner_scoped: 3,
    };

    return Array.from(byUid.values()).sort((a, b) => {
      if (a.isCurrentBrowserSession !== b.isCurrentBrowserSession) {
        return a.isCurrentBrowserSession ? -1 : 1;
      }
      const pDiff =
        statePriority[a.crossRefState] - statePriority[b.crossRefState];
      if (pDiff !== 0) return pDiff;
      if (a.isActiveSessionWindow !== b.isActiveSessionWindow) {
        return a.isActiveSessionWindow ? -1 : 1;
      }
      const tsA = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
      const tsB = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
      return tsB - tsA;
    });
  }, [
    callerRole,
    createdLedger,
    currentUser,
    firestoreMap,
    isVerifiedPrincipalCaller,
    overviewUsers,
  ]);

  const metrics = useMemo(() => {
    let activeSessionsCount = 0;
    let missingCount = 0;
    let corruptedCount = 0;
    let provisionedCount = 0;
    let scopedCount = 0;

    for (const row of crossRefRows) {
      if (row.isActiveSessionWindow) activeSessionsCount += 1;
      if (row.crossRefState === 'missing_entry') missingCount += 1;
      else if (row.crossRefState === 'corrupted_entry') corruptedCount += 1;
      else if (row.crossRefState === 'provisioned') provisionedCount += 1;
      else scopedCount += 1;
    }

    const createdSessionCount = Object.keys(createdLedger).length;
    const evaluableTotal = Math.max(
      crossRefRows.length - scopedCount,
      1
    );
    const coveragePct =
      crossRefRows.length - scopedCount === 0
        ? 100
        : Math.round((provisionedCount / evaluableTotal) * 100);

    const barTotal = Math.max(crossRefRows.length, 1);
    const provW = Math.round((provisionedCount / barTotal) * 1000);
    const corrW = Math.round((corruptedCount / barTotal) * 1000);
    const missW = Math.round((missingCount / barTotal) * 1000);
    const scopeW = Math.max(0, 1000 - provW - corrW - missW);

    return {
      totalLinks: crossRefRows.length,
      activeSessionsCount,
      missingCount,
      corruptedCount,
      provisionedCount,
      scopedCount,
      createdSessionCount,
      coveragePct,
      bar: {
        provX: 0,
        provW: crossRefRows.length === 0 ? 0 : provW,
        corrX: provW,
        corrW: crossRefRows.length === 0 ? 0 : corrW,
        missX: provW + corrW,
        missW: crossRefRows.length === 0 ? 0 : missW,
        scopeX: provW + corrW + missW,
        scopeW: crossRefRows.length === 0 ? 0 : scopeW,
      },
    };
  }, [createdLedger, crossRefRows]);

  useEffect(() => {
    onMissingCountChange?.(metrics.missingCount);
  }, [metrics.missingCount, onMissingCountChange]);

  // 3. Provision / Repair Executor (Used by both Automatic Backfill and Manual Buttons)
  const executeProfileProvisioning = useCallback(
    async (options: {
      targets: CrossReferencedSessionRow[];
      trigger: 'auto' | 'manual';
      forceRebuildCorrupted?: boolean;
    }) => {
      const liveCaller = auth.currentUser;
      if (!liveCaller || !liveCaller.emailVerified || options.targets.length === 0) {
        return;
      }

      if (options.trigger === 'auto') {
        isRunningAutoRef.current = true;
      } else {
        setIsExecutingBatch(true);
      }

      onSurfaceError(null);

      try {
        const freshToken = await liveCaller.getIdToken();
        const isPrincipalNow = Boolean(
          liveCaller.emailVerified &&
            liveCaller.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
        );

        let createdCount = 0;
        let repairedCount = 0;
        let recreatedCount = 0;
        let misflaggedFixed = 0;
        const newlyCreatedItems: CreatedProfileReceiptItem[] = [];

        for (const row of options.targets) {
          if (!row.canCallerInspectAndWrite) continue;
          setBusyUid(row.uid);

          if (isPrincipalNow) {
            // Principal Owner can create or repair any missing/corrupted /userProfiles/{uid} record
            const res = await upsertFirestoreProfileAsPrincipalOwner(
              {
                uid: row.uid,
                email: row.email,
                displayName: row.displayName,
                photoUrl: row.photoUrl,
                authProvider: row.authProvider,
                emailVerified: row.emailVerified,
                role: row.role,
                accountStatus: row.accountStatus,
              },
              liveCaller.uid,
              'repair_auth',
              {
                forceRecreate:
                  options.forceRebuildCorrupted &&
                  row.crossRefState === 'corrupted_entry',
              }
            );

            if (res.action === 'created') {
              createdCount += 1;
              newlyCreatedItems.push({
                uid: row.uid,
                email: row.email,
                displayName: row.displayName,
                role: row.role,
                trigger: options.trigger,
                createdAtIso: new Date().toISOString(),
              });
            } else if (res.action === 'recreated') {
              recreatedCount += 1;
            } else if (res.action === 'updated') {
              repairedCount += 1;
            }
          } else if (row.uid === liveCaller.uid) {
            // Non-owner verified admin/member creating or repairing their own active session profile
            await runSelfRepairAuth(freshToken, {
              displayName: liveCaller.displayName || row.displayName,
              photoUrl: liveCaller.photoURL || row.photoUrl,
            });
            const wasMissing = row.crossRefState === 'missing_entry';
            const selfRes = await syncCallerFirestoreProfile(
              liveCaller,
              {
                role: row.role,
                accountStatus: row.accountStatus,
                authProvider: row.authProvider,
              },
              'repair_auth'
            );
            if (selfRes.synced) {
              if (wasMissing) {
                createdCount += 1;
                newlyCreatedItems.push({
                  uid: row.uid,
                  email: row.email,
                  displayName: row.displayName,
                  role: row.role,
                  trigger: options.trigger,
                  createdAtIso: new Date().toISOString(),
                });
              } else {
                repairedCount += 1;
              }
              if (selfRes.repairedOwnershipFlag) {
                misflaggedFixed += 1;
              }
            }
          }
        }

        if (newlyCreatedItems.length > 0) {
          setCreatedLedger((prev) => {
            const next = { ...prev };
            for (const item of newlyCreatedItems) {
              next[item.uid] = item;
            }
            return next;
          });
        }

        if (createdCount > 0 || repairedCount > 0 || recreatedCount > 0) {
          await logOwnerFirestoreRepairSync(freshToken, {
            source: 'profile_repair',
            autoTriggered: options.trigger === 'auto',
            targetUserId:
              options.targets.length === 1 && options.targets[0].userId
                ? options.targets[0].userId
                : undefined,
            createdAccounts: newlyCreatedItems.map((c) => ({
              uid: c.uid,
              email: c.email,
              role: c.role,
            })),
            firestoreSummary: {
              scanned: crossRefRows.length,
              created: createdCount,
              repaired: repairedCount,
              corruptedRecreated: recreatedCount,
              misflaggedOwners: misflaggedFixed,
            },
          }).catch(() => {
            // Best-effort audit log; Firestore write itself already succeeded
          });

          const latestFs = await fetchInspectedFirestoreProfilesMap(
            liveCaller,
            isPrincipalNow
          );
          setFirestoreMap(latestFs);
          setLastCrossRefAtIso(new Date().toISOString());
          await onAfterProfileRepair();

          if (createdCount > 0) {
            onSurfaceNotice(
              `${
                options.trigger === 'auto'
                  ? 'Profile Repair automatically created'
                  : 'Created'
              } ${createdCount} missing Firestore /userProfiles ${
                createdCount === 1 ? 'record' : 'records'
              } for linked Firebase Auth ${
                createdCount === 1 ? 'session' : 'sessions'
              }.`
            );
          } else {
            onSurfaceNotice(
              `Verified and synchronized ${
                repairedCount + recreatedCount
              } Firestore /userProfiles ${
                repairedCount + recreatedCount === 1 ? 'record' : 'records'
              }.`
            );
          }
        } else if (options.trigger === 'manual') {
          onSurfaceNotice(
            'All cross-referenced Firebase Auth sessions already have valid Firestore /userProfiles entries.'
          );
        }
      } catch (err) {
        onSurfaceError(
          err instanceof Error
            ? err.message
            : 'Profile Repair encountered an error while creating missing Firestore profile records.'
        );
      } finally {
        setBusyUid(null);
        if (options.trigger === 'auto') {
          isRunningAutoRef.current = false;
        } else {
          setIsExecutingBatch(false);
        }
      }
    },
    [
      crossRefRows.length,
      onAfterProfileRepair,
      onSurfaceError,
      onSurfaceNotice,
    ]
  );

  // 4. Automatic Cross-Reference & Missing Profile Backfill Effect
  useEffect(() => {
    if (
      !autoCreateEnabled ||
      !firestoreReady ||
      isRunningAutoRef.current ||
      isExecutingBatch ||
      isScanning
    ) {
      return;
    }

    const unattemptedMissing = crossRefRows.filter(
      (row) =>
        row.crossRefState === 'missing_entry' &&
        row.canCallerInspectAndWrite &&
        !attemptedAutoCreateUidsRef.current.has(row.uid)
    );

    if (unattemptedMissing.length === 0) return;

    for (const row of unattemptedMissing) {
      attemptedAutoCreateUidsRef.current.add(row.uid);
    }

    void executeProfileProvisioning({
      targets: unattemptedMissing,
      trigger: 'auto',
    });
  }, [
    autoCreateEnabled,
    crossRefRows,
    executeProfileProvisioning,
    firestoreReady,
    isExecutingBatch,
    isScanning,
  ]);

  // 5. Explicit Live Cross-Reference Scan
  const handleManualCrossReferenceScan = async () => {
    if (!auth.currentUser) return;
    setIsScanning(true);
    onSurfaceError(null);
    attemptedAutoCreateUidsRef.current.clear();

    try {
      await reload(auth.currentUser);
      const liveUser = auth.currentUser;
      const freshToken = await liveUser.getIdToken(true);

      await runOwnerRepairAuth(freshToken, {
        mode: 'scan',
        displayName: liveUser.displayName || '',
        photoUrl: liveUser.photoURL || '',
      });

      const isPrincipalNow = Boolean(
        liveUser.emailVerified &&
          liveUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
      );
      const latestFs = await fetchInspectedFirestoreProfilesMap(
        liveUser,
        isPrincipalNow
      );
      setFirestoreMap(latestFs);
      setFirestoreReady(true);
      setLastCrossRefAtIso(new Date().toISOString());
      await onAfterProfileRepair();
    } catch (err) {
      onSurfaceError(
        err instanceof Error
          ? err.message
          : 'Could not complete Firebase Auth to Firestore cross-reference scan.'
      );
    } finally {
      setIsScanning(false);
    }
  };

  const handleBackfillAllMissing = async () => {
    attemptedAutoCreateUidsRef.current.clear();
    const actionable = crossRefRows.filter(
      (row) =>
        row.canCallerInspectAndWrite &&
        (row.crossRefState === 'missing_entry' ||
          row.crossRefState === 'corrupted_entry')
    );

    if (actionable.length > 0) {
      await executeProfileProvisioning({
        targets: actionable,
        trigger: 'manual',
        forceRebuildCorrupted: true,
      });
      return;
    }

    // If zero missing, allow re-verifying all writable active links on manual click
    const writableAll = crossRefRows.filter(
      (row) => row.canCallerInspectAndWrite
    );
    await executeProfileProvisioning({
      targets: writableAll,
      trigger: 'manual',
    });
  };

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return crossRefRows.filter((row) => {
      if (activeFilter === 'active_sessions' && !row.isActiveSessionWindow) {
        return false;
      }
      if (
        activeFilter === 'missing_entry' &&
        row.crossRefState !== 'missing_entry' &&
        row.crossRefState !== 'corrupted_entry'
      ) {
        return false;
      }
      if (activeFilter === 'created_session' && !row.wasCreatedThisSession) {
        return false;
      }
      if (
        activeFilter === 'provisioned' &&
        row.crossRefState !== 'provisioned'
      ) {
        return false;
      }
      if (!q) return true;
      return (
        row.email.toLowerCase().includes(q) ||
        row.displayName.toLowerCase().includes(q) ||
        row.uid.toLowerCase().includes(q) ||
        row.lastSeenDevice.toLowerCase().includes(q) ||
        row.lastSeenIp.toLowerCase().includes(q) ||
        row.firestoreDocPath.toLowerCase().includes(q)
      );
    });
  }, [activeFilter, crossRefRows, searchQuery]);

  const createdItemsList = useMemo(
    () =>
      Object.values(createdLedger).sort(
        (a, b) =>
          new Date(b.createdAtIso).getTime() -
          new Date(a.createdAtIso).getTime()
      ),
    [createdLedger]
  );

  const missingOrCorruptedCount = metrics.missingCount + metrics.corruptedCount;

  return (
    <section className="space-y-6">
      {/* Section 1: Cross-Reference Engine Header & Automatic Backfill Controls */}
      <div className="bg-[#13161C] border border-[#222833] rounded-lg p-5 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-[#F5F7FA]">
              Profile Repair &amp; Firebase Auth Session Cross-Reference
            </h2>
            <p className="text-xs text-[#8C96A8] max-w-3xl leading-relaxed">
              Automatically cross-references active Firebase Auth sessions and
              verified authentication links against Firestore{' '}
              <span className="font-mono text-[#C7D0DF]">/userProfiles</span>{' '}
              documents, creating any missing database entries with validated
              ownership and role fields.
            </p>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap shrink-0">
            {/* Auto-Create Toggle Switch */}
            <div
              role="group"
              aria-label="Automatic missing profile creation mode"
              className="inline-flex items-center gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md"
            >
              <button
                type="button"
                onClick={() => {
                  attemptedAutoCreateUidsRef.current.clear();
                  setAutoCreateEnabled(true);
                }}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  autoCreateEnabled
                    ? 'bg-[#18212E] text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                Auto-Create: On
              </button>
              <button
                type="button"
                onClick={() => setAutoCreateEnabled(false)}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  !autoCreateEnabled
                    ? 'bg-[#1C2533] text-[#F5F7FA]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                Manual Only
              </button>
            </div>

            <button
              type="button"
              disabled={isScanning || isExecutingBatch}
              onClick={() => void handleManualCrossReferenceScan()}
              className="h-9 px-3.5 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#222833] hover:border-[#22D3EE]/45 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-[#22D3EE] ${
                  isScanning ? 'animate-spin' : ''
                }`}
                aria-hidden="true"
              />
              Cross-Reference Sessions
            </button>

            <button
              type="button"
              disabled={isScanning || isExecutingBatch}
              onClick={() => void handleBackfillAllMissing()}
              className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isExecutingBatch ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              {missingOrCorruptedCount > 0
                ? `Create Missing Profiles (${missingOrCorruptedCount})`
                : 'Verify & Sync All Profiles'}
            </button>
          </div>
        </div>

        {/* Proportional SVG Cross-Reference Coverage Bar (Zero inline styles) */}
        <div className="space-y-2">
          <svg
            viewBox="0 0 1000 10"
            preserveAspectRatio="none"
            className="w-full h-2.5 rounded overflow-hidden bg-[#0E1116]"
            role="img"
            aria-label="Firestore userProfiles coverage across Firebase Auth sessions"
          >
            {metrics.bar.provW > 0 && (
              <rect
                x={metrics.bar.provX}
                y={0}
                width={metrics.bar.provW}
                height={10}
                className="fill-[#16A34A]"
              />
            )}
            {metrics.bar.corrW > 0 && (
              <rect
                x={metrics.bar.corrX}
                y={0}
                width={metrics.bar.corrW}
                height={10}
                className="fill-[#D97706]"
              />
            )}
            {metrics.bar.missW > 0 && (
              <rect
                x={metrics.bar.missX}
                y={0}
                width={metrics.bar.missW}
                height={10}
                className="fill-[#DC2626]"
              />
            )}
            {metrics.bar.scopeW > 0 && (
              <rect
                x={metrics.bar.scopeX}
                y={0}
                width={metrics.bar.scopeW}
                height={10}
                className="fill-[#334155]"
              />
            )}
          </svg>

          <div className="flex items-center justify-between gap-3 flex-wrap text-[11px] font-mono text-[#8C96A8] tabular-nums">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[#4ADE80]">
                Provisioned: {metrics.provisionedCount}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-[#FCA5A5]">
                Missing /userProfiles: {metrics.missingCount}
              </span>
              {metrics.corruptedCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-300">
                    Schema Drift: {metrics.corruptedCount}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="text-[#67E8F9]">
                Coverage: {metrics.coveragePct}%
              </span>
            </div>
            <span>
              {firestoreReady ? 'Live Firestore Stream Connected' : 'Connecting Firestore Stream'}
              {lastCrossRefAtIso
                ? ` · Checked ${formatDateTime(lastCrossRefAtIso)}`
                : ''}
            </span>
          </div>
        </div>

        {/* 4 Interactive Cross-Reference Metric Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 pt-1">
          <button
            type="button"
            onClick={() =>
              setActiveFilter((prev) =>
                prev === 'active_sessions' ? 'all' : 'active_sessions'
              )
            }
            className={`text-left p-4 rounded-lg border transition-colors cursor-pointer space-y-2 ${
              activeFilter === 'active_sessions'
                ? 'bg-[#18212E] border-[#22D3EE]'
                : 'bg-[#0E1116] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <div className="flex items-center justify-between text-xs text-[#8C96A8]">
              <span>Active Auth Sessions</span>
              <ShieldCheck
                className="w-4 h-4 text-[#22D3EE] shrink-0"
                aria-hidden="true"
              />
            </div>
            <div className="font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
              {metrics.activeSessionsCount}
            </div>
            <div className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
              of {metrics.totalLinks} total authenticated links
            </div>
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveFilter((prev) =>
                prev === 'missing_entry' ? 'all' : 'missing_entry'
              )
            }
            className={`text-left p-4 rounded-lg border transition-colors cursor-pointer space-y-2 ${
              activeFilter === 'missing_entry'
                ? 'bg-[#18212E] border-[#22D3EE]'
                : 'bg-[#0E1116] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <div className="flex items-center justify-between text-xs text-[#8C96A8]">
              <span>Missing Database Entries</span>
              {metrics.missingCount > 0 ? (
                <AlertTriangle
                  className="w-4 h-4 text-[#F87171] shrink-0"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle2
                  className="w-4 h-4 text-[#16A34A] shrink-0"
                  aria-hidden="true"
                />
              )}
            </div>
            <div
              className={`font-mono text-2xl font-semibold tabular-nums ${
                metrics.missingCount > 0 ? 'text-[#FCA5A5]' : 'text-[#F5F7FA]'
              }`}
            >
              {metrics.missingCount}
            </div>
            <div className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
              {metrics.missingCount === 0
                ? 'Zero missing /userProfiles records'
                : 'Auth link present · profile missing'}
            </div>
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveFilter((prev) =>
                prev === 'created_session' ? 'all' : 'created_session'
              )
            }
            className={`text-left p-4 rounded-lg border transition-colors cursor-pointer space-y-2 ${
              activeFilter === 'created_session'
                ? 'bg-[#18212E] border-[#22D3EE]'
                : 'bg-[#0E1116] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <div className="flex items-center justify-between text-xs text-[#8C96A8]">
              <span>Created This Session</span>
              <PlusCircle
                className="w-4 h-4 text-[#22D3EE] shrink-0"
                aria-hidden="true"
              />
            </div>
            <div className="font-mono text-2xl font-semibold text-[#67E8F9] tabular-nums">
              {metrics.createdSessionCount}
            </div>
            <div className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
              {autoCreateEnabled
                ? 'Auto-create watcher active'
                : 'Manual backfill mode'}
            </div>
          </button>

          <button
            type="button"
            onClick={() =>
              setActiveFilter((prev) =>
                prev === 'provisioned' ? 'all' : 'provisioned'
              )
            }
            className={`text-left p-4 rounded-lg border transition-colors cursor-pointer space-y-2 ${
              activeFilter === 'provisioned'
                ? 'bg-[#18212E] border-[#22D3EE]'
                : 'bg-[#0E1116] border-[#222833] hover:border-[#22D3EE]/45'
            }`}
          >
            <div className="flex items-center justify-between text-xs text-[#8C96A8]">
              <span>Verified Firestore Profiles</span>
              <Database
                className="w-4 h-4 text-[#16A34A] shrink-0"
                aria-hidden="true"
              />
            </div>
            <div className="font-mono text-2xl font-semibold text-[#F5F7FA] tabular-nums">
              {metrics.provisionedCount}
            </div>
            <div className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
              {metrics.coveragePct}% Auth-to-Firestore coverage
            </div>
          </button>
        </div>
      </div>

      {/* Section 2: Newly Created Profile Records Receipt (Shown when missing entries were created) */}
      {createdItemsList.length > 0 && (
        <div className="bg-[#13161C] border border-[#22D3EE]/40 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#1F2532] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-[#F5F7FA]">
                Backfilled Firestore Profile Records ({createdItemsList.length})
              </h3>
              <p className="text-xs text-[#8C96A8]">
                Missing <span className="font-mono text-[#C7D0DF]">/userProfiles</span>{' '}
                documents created during this console session after detecting an
                active Firebase Auth link.
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenRepairAuditLog}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5" aria-hidden="true" />
              Inspect Audit Record
            </button>
          </div>

          <div className="divide-y divide-[#1C212C]">
            {createdItemsList.map((item) => (
              <div
                key={item.uid}
                className="px-5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <CheckCircle2
                    className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                    aria-hidden="true"
                  />
                  <span className="font-medium text-[#F5F7FA]">
                    {item.displayName}
                  </span>
                  <span aria-hidden="true" className="text-[#6E788A]">
                    ·
                  </span>
                  <span className="font-mono text-[#C7D0DF]">{item.email}</span>
                  <span aria-hidden="true" className="text-[#6E788A]">
                    ·
                  </span>
                  <span className="font-mono text-[#67E8F9]">
                    /userProfiles/{item.uid}
                  </span>
                </div>
                <div className="font-mono text-[11px] text-[#8C96A8] tabular-nums whitespace-nowrap">
                  {item.trigger === 'auto' ? 'Auto-Created' : 'Manual Backfill'}{' '}
                  · {formatRoleTitle(item.role)} ·{' '}
                  {formatDateTime(item.createdAtIso)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section 3: Session-to-Firestore Cross-Reference Table */}
      <div className="space-y-3.5">
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
              placeholder="Search sessions by email, name, UID, device, or IP address..."
              className="w-full h-9 pl-8 pr-3 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] placeholder:text-[#6E788A] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md overflow-x-auto">
            {(
              [
                { id: 'all', label: `All Auth Links (${metrics.totalLinks})` },
                {
                  id: 'active_sessions',
                  label: `Active Sessions (${metrics.activeSessionsCount})`,
                },
                {
                  id: 'missing_entry',
                  label: `Missing Entry (${missingOrCorruptedCount})`,
                },
                {
                  id: 'created_session',
                  label: `Created (${metrics.createdSessionCount})`,
                },
                {
                  id: 'provisioned',
                  label: `Provisioned (${metrics.provisionedCount})`,
                },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveFilter(item.id)}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums ${
                  activeFilter === item.id
                    ? 'bg-[#1C2533] text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                <span className="font-sans">{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                  <th className="py-3 px-4">Authenticated Identity</th>
                  <th className="py-3 px-4">Last Seen &amp; Device / IP</th>
                  <th className="py-3 px-4">
                    Firestore Database Entry (/userProfiles)
                  </th>
                  <th className="py-3 px-4">Cross-Reference Status</th>
                  <th className="py-3 px-4 text-right">Profile Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1C212C] text-xs">
                {!firestoreReady && crossRefRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-10 text-center text-[#8C96A8]"
                    >
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" />
                        Cross-referencing active Firebase Auth sessions with
                        Firestore /userProfiles...
                      </span>
                    </td>
                  </tr>
                ) : filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-10 text-center text-[#8C96A8] space-y-2"
                    >
                      <div>
                        No Firebase Auth sessions match the active filter or
                        search query.
                      </div>
                      {(searchQuery || activeFilter !== 'all') && (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setActiveFilter('all');
                          }}
                          className="h-8 px-3 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          Reset Filters
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => {
                    const isRowBusy = busyUid === row.uid;
                    const fsParsed = row.firestoreInspected?.parsed || null;

                    return (
                      <tr
                        key={row.uid}
                        className="hover:bg-[#171B23] transition-colors align-middle"
                      >
                        {/* Authenticated Identity */}
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5">
                            {row.photoUrl ? (
                              <img
                                src={row.photoUrl}
                                alt={row.displayName}
                                className="w-7 h-7 rounded-full object-cover shrink-0"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <span className="w-7 h-7 rounded-full bg-[#1C2432] text-[#67E8F9] inline-flex items-center justify-center text-[11px] font-semibold shrink-0">
                                {(row.displayName || row.email || 'U')
                                  .charAt(0)
                                  .toUpperCase()}
                              </span>
                            )}
                            <div className="min-w-0 space-y-0.5">
                              <div className="font-medium text-[#F5F7FA] truncate max-w-[210px]">
                                {row.displayName}
                                {row.isCurrentBrowserSession
                                  ? ' · Current Session'
                                  : ''}
                              </div>
                              <div className="text-[11px] font-mono text-[#8C96A8] truncate max-w-[230px]">
                                {row.email}
                              </div>
                              <div className="text-[11px] font-mono text-[#6E788A] truncate max-w-[230px]">
                                UID: {row.uid}
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Last Seen & Device / IP */}
                        <td className="py-3 px-4 whitespace-nowrap">
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={
                                  row.isActiveSessionWindow
                                    ? 'text-[#67E8F9] font-medium'
                                    : 'text-[#D5DCE6]'
                                }
                              >
                                {row.sessionStateLabel}
                              </span>
                              <span aria-hidden="true" className="text-[#6E788A]">
                                ·
                              </span>
                              <span className="font-mono text-[11px] text-[#C7D0DF] tabular-nums">
                                Last seen {formatDateTime(row.lastActiveAt)} (
                                {formatRelativeAge(row.lastActiveAt)})
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-[#9BA6B8] tabular-nums">
                              {row.lastSeenDevice} · IP {row.lastSeenIp}
                              {row.accessFlagged ? (
                                <span className="text-amber-300">
                                  {' '}
                                  · Unusual access
                                </span>
                              ) : null}
                            </div>
                            <div className="text-[11px] text-[#6E788A]">
                              {row.emailVerified ? 'Verified' : 'Unverified'} ·{' '}
                              {formatProviderName(row.authProvider)} ·{' '}
                              {formatRoleTitle(row.role)}
                            </div>
                          </div>
                        </td>

                        {/* Firestore Database Entry */}
                        <td className="py-3 px-4 whitespace-nowrap">
                          {row.crossRefState === 'owner_scoped' ? (
                            <div className="space-y-0.5">
                              <div className="font-mono text-[11px] text-[#8C96A8]">
                                {row.firestoreDocPath}
                              </div>
                              <div className="text-[11px] text-[#6E788A]">
                                Isolated to Principal Owner
                              </div>
                            </div>
                          ) : !fsParsed ? (
                            <div className="space-y-0.5">
                              <div className="font-mono text-[11px] text-[#FCA5A5]">
                                {row.firestoreDocPath}
                              </div>
                              <div className="text-[11px] text-[#FCA5A5] font-medium">
                                Entry Missing in Firestore
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-0.5">
                              <div className="font-mono text-[11px] text-[#D5DCE6]">
                                {row.firestoreDocPath}
                              </div>
                              <div className="text-[11px] font-mono text-[#8C96A8] tabular-nums">
                                role: {fsParsed.role} · status:{' '}
                                {fsParsed.accountStatus} · via{' '}
                                {fsParsed.syncSource}
                              </div>
                              <div className="text-[11px] font-mono text-[#6E788A] tabular-nums">
                                Synced{' '}
                                {formatRelativeAge(fsParsed.lastSyncedAtIso)}
                              </div>
                            </div>
                          )}
                        </td>

                        {/* Cross-Reference Status */}
                        <td className="py-3 px-4 max-w-xs">
                          {row.crossRefState === 'missing_entry' ? (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1.5 text-[#FCA5A5] font-medium">
                                <AlertTriangle
                                  className="w-3.5 h-3.5 shrink-0"
                                  aria-hidden="true"
                                />
                                Missing Profile Record
                              </span>
                              <div className="text-[11px] text-[#9BA6B8]">
                                {row.statusDetail}
                              </div>
                            </div>
                          ) : row.crossRefState === 'corrupted_entry' ? (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1.5 text-amber-300 font-medium">
                                <AlertTriangle
                                  className="w-3.5 h-3.5 shrink-0"
                                  aria-hidden="true"
                                />
                                Schema / Role Drift
                              </span>
                              <div className="text-[11px] text-[#9BA6B8]">
                                {row.statusDetail}
                              </div>
                            </div>
                          ) : row.crossRefState === 'owner_scoped' ? (
                            <span className="text-[#8C96A8]">
                              Principal Owner Scope
                            </span>
                          ) : (
                            <div className="space-y-0.5">
                              <span className="inline-flex items-center gap-1.5 text-[#D5DCE6] font-medium">
                                <CheckCircle2
                                  className="w-3.5 h-3.5 text-[#16A34A] shrink-0"
                                  aria-hidden="true"
                                />
                                {row.wasCreatedThisSession
                                  ? row.wasCreatedThisSession.trigger === 'auto'
                                    ? 'Auto-Created & Linked'
                                    : 'Created & Linked'
                                  : 'Profile Entry Verified'}
                              </span>
                              <div className="text-[11px] text-[#8C96A8]">
                                {row.wasCreatedThisSession
                                  ? `Created ${formatRelativeAge(
                                      row.wasCreatedThisSession.createdAtIso
                                    )}`
                                  : 'Auth UID linked to valid /userProfiles doc'}
                              </div>
                            </div>
                          )}
                        </td>

                        {/* Profile Action */}
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          {!row.canCallerInspectAndWrite ? (
                            <span className="text-[11px] font-mono text-[#6E788A]">
                              Owner Only
                            </span>
                          ) : row.crossRefState === 'missing_entry' ? (
                            <button
                              type="button"
                              disabled={isRowBusy || isExecutingBatch}
                              onClick={() =>
                                void executeProfileProvisioning({
                                  targets: [row],
                                  trigger: 'manual',
                                })
                              }
                              className="h-7 px-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              {isRowBusy ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <UserPlus className="w-3 h-3" aria-hidden="true" />
                              )}
                              Create Profile
                            </button>
                          ) : row.crossRefState === 'corrupted_entry' ? (
                            <button
                              type="button"
                              disabled={isRowBusy || isExecutingBatch}
                              onClick={() =>
                                void executeProfileProvisioning({
                                  targets: [row],
                                  trigger: 'manual',
                                  forceRebuildCorrupted: true,
                                })
                              }
                              className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-200 bg-amber-500/15 border border-amber-400/40 hover:border-amber-300 disabled:opacity-45 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              {isRowBusy && (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              )}
                              Rebuild Entry
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isRowBusy || isExecutingBatch}
                              onClick={() =>
                                void executeProfileProvisioning({
                                  targets: [row],
                                  trigger: 'manual',
                                })
                              }
                              className="h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] disabled:opacity-45 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              {isRowBusy && (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              )}
                              Verify Entry
                            </button>
                          )}
                        </td>
                      </tr>
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
