import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Lock,
  LogOut,
  Search,
  ShieldCheck,
  UserCheck,
  Users,
} from 'lucide-react';
import {
  PRINCIPAL_OWNER_EMAIL,
  subscribeToFirestoreUserProfiles,
  type InspectedFirestoreUserProfile,
} from '../services/firestoreUserProfile';
import type {
  OwnerActivityLogEntry,
  OwnerAuditedUser,
} from '../services/suiteApi';
import { extractAuditStateTransition } from './AdminAuditLogPanel';

export type EffectivePrivilegeTier =
  | 'ultra_owner'
  | 'studio_admin'
  | 'active_member'
  | 'suspended';

type RoleDomainFilter =
  | 'all'
  | 'admin_level'
  | 'standard_level'
  | 'ultra_owner'
  | 'studio_admin'
  | 'active_member'
  | 'suspended';

type DirectoryViewMode = 'directory' | 'split' | 'hierarchy';

export interface PrivilegeMutationPayload {
  nextRole?: 'admin' | 'member';
  nextStatus?: 'active' | 'suspended';
  actionLabel?: string;
}

interface UserPrivilegeAuditDashboardProps {
  currentUser: User;
  callerRole: 'owner' | 'admin' | 'member' | 'guest';
  isOwner: boolean;
  users: OwnerAuditedUser[];
  recentLogs: OwnerActivityLogEntry[];
  isLoadingData: boolean;
  mutatingUserId: number | null;
  forcingLogoutUserId?: number | null;
  onMutateUserPrivilege: (
    target: OwnerAuditedUser,
    mutation: PrivilegeMutationPayload
  ) => Promise<void>;
  onForceLogoutUser?: (target: OwnerAuditedUser) => Promise<void>;
  onInspectUserLogs: (userId: number) => void;
  onOpenPrivilegeAuditLog: () => void;
  onSurfaceNotice?: (message: string) => void;
}

interface CapabilityMatrixRow {
  id: string;
  capability: string;
  scopeDescription: string;
  ultraOwner: string;
  studioAdmin: string;
  standardMember: string;
  suspended: string;
}

const CAPABILITY_MATRIX: CapabilityMatrixRow[] = [
  {
    id: 'role_governance',
    capability: 'Role Promotion & Demotion',
    scopeDescription:
      'Promote Standard Members to Studio Admin or demote Admins to Standard access',
    ultraOwner: 'Full Authority',
    studioAdmin: 'Read-Only',
    standardMember: 'No Access',
    suspended: 'Blocked',
  },
  {
    id: 'status_governance',
    capability: 'Account Suspension & Activation',
    scopeDescription:
      'Activate or suspend collaborator sessions and API token access',
    ultraOwner: 'Admins & Standard',
    studioAdmin: 'Standard Only',
    standardMember: 'No Access',
    suspended: 'Blocked',
  },
  {
    id: 'console_audit',
    capability: 'Owner Console & Session Telemetry',
    scopeDescription:
      'Inspect Last Seen timestamps, Device/IP metadata, audit logs, and studio policies',
    ultraOwner: 'Admin-Level Full',
    studioAdmin: 'Admin-Level Full',
    standardMember: 'Restricted (No Console)',
    suspended: 'Blocked',
  },
  {
    id: 'share_governance',
    capability: 'Public Share Link Lifecycle',
    scopeDescription:
      'Extend TTL windows, revoke active links, and purge expired hosted shares',
    ultraOwner: 'All Studio Shares',
    studioAdmin: 'All Studio Shares',
    standardMember: 'Own Shares Only',
    suspended: 'Blocked',
  },
  {
    id: 'firestore_profiles',
    capability: 'Firestore /userProfiles Boundary',
    scopeDescription:
      'Security rule read/write scope on synchronized user identity documents',
    ultraOwner: 'Full Collection R/W',
    studioAdmin: 'Self Profile R/W',
    standardMember: 'Self Profile R/W',
    suspended: 'Writes Denied',
  },
  {
    id: 'cloud_workbenches',
    capability: 'Creative Studio Workbenches',
    scopeDescription:
      'AI Desk threads, Media Lab items, Site Mockups, Spatial Pins, and 3D Scores',
    ultraOwner: 'Full Read/Write',
    studioAdmin: 'Full Read/Write',
    standardMember: 'Full Read/Write',
    suspended: 'Blocked (HTTP 403)',
  },
];

const TIER_META: Record<
  EffectivePrivilegeTier,
  {
    indexLabel: string;
    domainClass: 'Admin-Level' | 'Standard Role' | 'Restricted';
    title: string;
    shortTitle: string;
    authoritySummary: string;
    assignedCapabilities: string[];
  }
> = {
  ultra_owner: {
    indexLabel: '01',
    domainClass: 'Admin-Level',
    title: '01. Ultra Owner',
    shortTitle: 'Ultra Owner',
    authoritySummary:
      'Immutable root principal with Studio Admin promotion rights, full Console governance, and collection-wide Firestore /userProfiles authority.',
    assignedCapabilities: [
      'Promote & Demote Admins',
      'Owner Console',
      'Full Firestore R/W',
      'System Policies',
    ],
  },
  studio_admin: {
    indexLabel: '02',
    domainClass: 'Admin-Level',
    title: '02. Studio Admin',
    shortTitle: 'Studio Admin',
    authoritySummary:
      'Elevated administrative role with full Owner Console visibility, user session auditing, share lifecycle governance, and Standard Member status control.',
    assignedCapabilities: [
      'Owner Console',
      'Session & Audit Logs',
      'Share Governance',
      'Standard Status Control',
    ],
  },
  active_member: {
    indexLabel: '03',
    domainClass: 'Standard Role',
    title: '03. Standard Member',
    shortTitle: 'Standard Member',
    authoritySummary:
      'Non-administrative collaborator role with full creative workbench persistence and self-scoped profile sync, isolated from Owner Console governance.',
    assignedCapabilities: [
      'Creative Workbenches',
      'Own Share Links',
      'Self Profile Sync',
      'No Admin Console Access',
    ],
  },
  suspended: {
    indexLabel: '04',
    domainClass: 'Restricted',
    title: '04. Suspended Account',
    shortTitle: 'Suspended',
    authoritySummary:
      'Quarantined state blocking all authenticated API mutations (HTTP 403), Owner Console entry, and Firestore profile updates until reactivated.',
    assignedCapabilities: [
      'API Mutations Blocked',
      'Console Blocked',
      'Firestore Writes Denied',
    ],
  },
};

export function resolveEffectivePrivilegeTier(
  account: Pick<OwnerAuditedUser, 'role' | 'accountStatus'>
): EffectivePrivilegeTier {
  if (account.accountStatus === 'suspended') return 'suspended';
  if (account.role === 'owner') return 'ultra_owner';
  if (account.role === 'admin') return 'studio_admin';
  return 'active_member';
}

function isAdminLevelAccount(
  account: Pick<OwnerAuditedUser, 'role' | 'accountStatus'>
): boolean {
  return (
    account.accountStatus !== 'suspended' &&
    (account.role === 'owner' || account.role === 'admin')
  );
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

function formatProviderLabel(provider: string): string {
  const clean = (provider || 'google.com').toLowerCase();
  if (clean.includes('google')) return 'Google OAuth';
  if (clean.includes('password')) return 'Email';
  return provider || 'Google OAuth';
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function UserPrivilegeAuditDashboard({
  currentUser,
  callerRole,
  isOwner,
  users,
  recentLogs,
  isLoadingData,
  mutatingUserId,
  forcingLogoutUserId = null,
  onMutateUserPrivilege,
  onForceLogoutUser,
  onInspectUserLogs,
  onOpenPrivilegeAuditLog,
  onSurfaceNotice,
}: UserPrivilegeAuditDashboardProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [domainFilter, setDomainFilter] = useState<RoleDomainFilter>('all');
  const [viewMode, setViewMode] = useState<DirectoryViewMode>('directory');
  const [showMatrix, setShowMatrix] = useState(false);
  const [firestoreProfiles, setFirestoreProfiles] = useState<
    Map<string, InspectedFirestoreUserProfile>
  >(new Map());
  const [firestoreStreamNote, setFirestoreStreamNote] = useState<string | null>(
    null
  );

  useEffect(() => {
    const isPrincipalCaller = Boolean(
      isOwner &&
        currentUser.emailVerified &&
        currentUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
    );
    const unsub = subscribeToFirestoreUserProfiles(
      currentUser,
      isPrincipalCaller,
      (profiles) => {
        setFirestoreProfiles(profiles);
        setFirestoreStreamNote(null);
      },
      (errMessage) => {
        setFirestoreStreamNote(errMessage);
      }
    );
    return () => unsub();
  }, [currentUser, isOwner]);

  const tierStats = useMemo(() => {
    const counts: Record<EffectivePrivilegeTier, number> = {
      ultra_owner: 0,
      studio_admin: 0,
      active_member: 0,
      suspended: 0,
    };
    const verifiedCounts: Record<EffectivePrivilegeTier, number> = {
      ultra_owner: 0,
      studio_admin: 0,
      active_member: 0,
      suspended: 0,
    };

    for (const u of users) {
      const tier = resolveEffectivePrivilegeTier(u);
      counts[tier] += 1;
      if (u.emailVerified) {
        verifiedCounts[tier] += 1;
      }
    }

    const adminLevelCount = counts.ultra_owner + counts.studio_admin;
    const standardLevelCount = counts.active_member;
    const total = Math.max(users.length, 1);

    const ownerWidth = Math.round((counts.ultra_owner / total) * 1000);
    const adminWidth = Math.round((counts.studio_admin / total) * 1000);
    const memberWidth = Math.round((counts.active_member / total) * 1000);
    const suspendedWidth = Math.max(
      0,
      1000 - ownerWidth - adminWidth - memberWidth
    );

    return {
      counts,
      verifiedCounts,
      adminLevelCount,
      standardLevelCount,
      total: users.length,
      segments: {
        ownerX: 0,
        ownerW: users.length === 0 ? 0 : ownerWidth,
        adminX: ownerWidth,
        adminW: users.length === 0 ? 0 : adminWidth,
        memberX: ownerWidth + adminWidth,
        memberW: users.length === 0 ? 0 : memberWidth,
        suspendedX: ownerWidth + adminWidth + memberWidth,
        suspendedW: users.length === 0 ? 0 : suspendedWidth,
      },
    };
  }, [users]);

  const sortedAndFilteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const tierOrder: Record<EffectivePrivilegeTier, number> = {
      ultra_owner: 0,
      studio_admin: 1,
      active_member: 2,
      suspended: 3,
    };

    return users
      .filter((u) => {
        const tier = resolveEffectivePrivilegeTier(u);
        if (domainFilter === 'admin_level' && !isAdminLevelAccount(u)) {
          return false;
        }
        if (domainFilter === 'standard_level' && tier !== 'active_member') {
          return false;
        }
        if (
          (domainFilter === 'ultra_owner' ||
            domainFilter === 'studio_admin' ||
            domainFilter === 'active_member' ||
            domainFilter === 'suspended') &&
          tier !== domainFilter
        ) {
          return false;
        }

        if (!q) return true;
        const roleDomainText = isAdminLevelAccount(u)
          ? 'admin-level admin studio admin owner'
          : tier === 'active_member'
            ? 'standard role standard member collaborator'
            : 'restricted suspended quarantined';

        return (
          u.email.toLowerCase().includes(q) ||
          (u.displayName || '').toLowerCase().includes(q) ||
          u.uid.toLowerCase().includes(q) ||
          u.role.toLowerCase().includes(q) ||
          u.accountStatus.toLowerCase().includes(q) ||
          roleDomainText.includes(q) ||
          (u.lastSeenDevice || '').toLowerCase().includes(q) ||
          (u.lastSeenIp || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const diff =
          tierOrder[resolveEffectivePrivilegeTier(a)] -
          tierOrder[resolveEffectivePrivilegeTier(b)];
        if (diff !== 0) return diff;
        return (
          new Date(b.lastActiveAt).getTime() -
          new Date(a.lastActiveAt).getTime()
        );
      });
  }, [domainFilter, searchQuery, users]);

  const groupedUsers = useMemo(() => {
    const buckets: Record<EffectivePrivilegeTier, OwnerAuditedUser[]> = {
      ultra_owner: [],
      studio_admin: [],
      active_member: [],
      suspended: [],
    };
    for (const u of sortedAndFilteredUsers) {
      buckets[resolveEffectivePrivilegeTier(u)].push(u);
    }
    return buckets;
  }, [sortedAndFilteredUsers]);

  const splitBuckets = useMemo(() => {
    const adminAccounts: OwnerAuditedUser[] = [];
    const standardAndRestrictedAccounts: OwnerAuditedUser[] = [];
    for (const u of sortedAndFilteredUsers) {
      if (isAdminLevelAccount(u)) {
        adminAccounts.push(u);
      } else {
        standardAndRestrictedAccounts.push(u);
      }
    }
    return { adminAccounts, standardAndRestrictedAccounts };
  }, [sortedAndFilteredUsers]);

  const privilegeAuditEvents = useMemo(() => {
    return recentLogs
      .filter((entry) => entry.domain === 'privilege_modifications')
      .slice(0, 6);
  }, [recentLogs]);

  const computeStepActions = (account: OwnerAuditedUser) => {
    const isPrincipalTarget =
      account.role === 'owner' ||
      account.email.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL;
    const isSelf = account.uid === currentUser.uid;

    if (isPrincipalTarget || isSelf) {
      return {
        isLocked: true,
        lockReason: isPrincipalTarget
          ? 'Root Principal · Immutable'
          : 'Current Session · Protected',
        canToggleRole: false,
        canToggleStatus: false,
        promoteMutation: null as PrivilegeMutationPayload | null,
        demoteMutation: null as PrivilegeMutationPayload | null,
        secondaryMutation: null as PrivilegeMutationPayload | null,
      };
    }

    const canToggleRole = isOwner;
    const canToggleStatus = isOwner || account.role === 'member';

    let promoteMutation: PrivilegeMutationPayload | null = null;
    let demoteMutation: PrivilegeMutationPayload | null = null;
    let secondaryMutation: PrivilegeMutationPayload | null = null;

    if (account.accountStatus === 'suspended') {
      if (canToggleStatus) {
        promoteMutation = {
          nextStatus: 'active',
          actionLabel:
            account.role === 'admin'
              ? 'Restore Active Admin'
              : 'Restore Standard Access',
        };
      }
      if (isOwner && account.role === 'admin') {
        secondaryMutation = {
          nextStatus: 'active',
          nextRole: 'member',
          actionLabel: 'Restore as Standard',
        };
      }
    } else if (account.role === 'member') {
      if (isOwner) {
        promoteMutation = {
          nextRole: 'admin',
          actionLabel: 'Promote to Admin',
        };
      }
      if (canToggleStatus) {
        demoteMutation = {
          nextStatus: 'suspended',
          actionLabel: 'Suspend Access',
        };
      }
    } else if (account.role === 'admin') {
      if (isOwner) {
        demoteMutation = {
          nextRole: 'member',
          actionLabel: 'Demote to Standard',
        };
        secondaryMutation = {
          nextStatus: 'suspended',
          actionLabel: 'Suspend',
        };
      }
    }

    return {
      isLocked: false,
      lockReason: '',
      canToggleRole,
      canToggleStatus,
      promoteMutation,
      demoteMutation,
      secondaryMutation,
    };
  };

  const getFirestoreSyncLabel = (account: OwnerAuditedUser) => {
    const canInspectFirestore = isOwner || account.uid === currentUser.uid;
    if (!canInspectFirestore) {
      return {
        aligned: true,
        text: 'Owner-scoped Firestore read',
      };
    }
    const inspected = firestoreProfiles.get(account.uid);
    if (!inspected) {
      return {
        aligned: false,
        text: 'Missing /userProfiles doc',
      };
    }
    const roleMatches = inspected.parsed.role === account.role;
    const statusMatches =
      inspected.parsed.accountStatus === account.accountStatus;
    if (roleMatches && statusMatches && !inspected.isCorruptedSchema) {
      return {
        aligned: true,
        text: 'Firestore synced',
      };
    }
    return {
      aligned: false,
      text: `Firestore drift (${inspected.parsed.role}/${inspected.parsed.accountStatus})`,
    };
  };

  const handleExportPrivilegeCsv = () => {
    if (sortedAndFilteredUsers.length === 0) return;
    const headers = [
      'Display Name',
      'Email',
      'Firebase UID',
      'Role Domain',
      'Effective Tier',
      'Assigned Role',
      'Account Status',
      'Email Verified',
      'Firestore Sync State',
      'Last Seen (ISO)',
      'Last Seen Device',
      'Last Seen IP',
    ];

    const rows = sortedAndFilteredUsers.map((account) => {
      const tier = resolveEffectivePrivilegeTier(account);
      const meta = TIER_META[tier];
      const fsState = getFirestoreSyncLabel(account);
      return [
        account.displayName || 'Dispatch Member',
        account.email,
        account.uid,
        meta.domainClass,
        meta.shortTitle,
        account.role,
        account.accountStatus,
        account.emailVerified ? 'verified' : 'unverified',
        fsState.text,
        account.lastActiveAt ? new Date(account.lastActiveAt).toISOString() : '',
        account.lastSeenDevice || 'Pending client telemetry',
        account.lastSeenIp || 'Pending capture',
      ];
    });

    const csvContent = [
      headers.map(escapeCsvCell).join(','),
      ...rows.map((r) => r.map(escapeCsvCell).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `dispatch-privilege-management-${dateStamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    onSurfaceNotice?.(
      `Exported ${sortedAndFilteredUsers.length} user privilege ${
        sortedAndFilteredUsers.length === 1 ? 'record' : 'records'
      } to CSV.`
    );
  };

  const renderOneClickActionCluster = (
    account: OwnerAuditedUser,
    compact = false
  ) => {
    const isBusy = mutatingUserId === account.id;
    const controls = computeStepActions(account);

    if (controls.isLocked) {
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-[#8C96A8] whitespace-nowrap shrink-0">
          <Lock className="w-3.5 h-3.5 text-[#67E8F9] shrink-0" aria-hidden="true" />
          {controls.lockReason}
        </span>
      );
    }

    return (
      <div className="inline-flex items-center justify-end gap-1.5 flex-wrap">
        {isBusy && (
          <Loader2
            className="w-3.5 h-3.5 animate-spin text-[#22D3EE] shrink-0"
            aria-hidden="true"
          />
        )}

        {controls.promoteMutation ? (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              if (controls.promoteMutation) {
                void onMutateUserPrivilege(account, controls.promoteMutation);
              }
            }}
            className={`h-8 px-3 inline-flex items-center gap-1.5 text-[11px] font-semibold rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              account.accountStatus === 'suspended'
                ? 'text-emerald-300 bg-emerald-500/10 border-emerald-400/40 hover:border-emerald-300'
                : 'text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] border-[#22D3EE]'
            }`}
          >
            <ArrowUp className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {controls.promoteMutation.actionLabel}
          </button>
        ) : (
          account.accountStatus === 'active' &&
          account.role === 'member' &&
          !isOwner && (
            <span
              className="text-[11px] font-mono text-[#6E788A] whitespace-nowrap shrink-0"
              title="Only the verified Principal Owner can promote a Standard Member to Studio Admin"
            >
              Owner required for Admin
            </span>
          )
        )}

        {controls.demoteMutation && (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              if (controls.demoteMutation) {
                void onMutateUserPrivilege(account, controls.demoteMutation);
              }
            }}
            className={`h-8 px-3 inline-flex items-center gap-1.5 text-[11px] font-medium rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              controls.demoteMutation.nextRole === 'member'
                ? 'text-amber-200 bg-amber-500/10 border-amber-400/40 hover:border-amber-300'
                : 'text-[#FCA5A5] bg-[#2A1216] border-[#F87171]/35 hover:border-[#F87171]'
            }`}
          >
            <ArrowDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {controls.demoteMutation.actionLabel}
          </button>
        )}

        {controls.secondaryMutation && !compact && (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => {
              if (controls.secondaryMutation) {
                void onMutateUserPrivilege(account, controls.secondaryMutation);
              }
            }}
            className="h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-[#D5DCE6] hover:text-[#FCA5A5] bg-[#0E1116] border border-[#2A3342] hover:border-[#F87171]/45 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {controls.secondaryMutation.actionLabel}
          </button>
        )}

        {onForceLogoutUser && controls.canToggleStatus && (
          <button
            type="button"
            disabled={isBusy || forcingLogoutUserId === account.id}
            onClick={() => void onForceLogoutUser(account)}
            title="Revoke active sessions and clear Firestore-linked auth state"
            className="h-8 px-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-200 hover:text-amber-100 bg-amber-500/10 border border-amber-400/40 hover:border-amber-300 disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {forcingLogoutUserId === account.id ? (
              <Loader2 className="w-3 h-3 animate-spin shrink-0" aria-hidden="true" />
            ) : (
              <LogOut className="w-3 h-3 shrink-0" aria-hidden="true" />
            )}
            Force Logout
          </button>
        )}
      </div>
    );
  };

  const renderUserRow = (account: OwnerAuditedUser) => {
    const tier = resolveEffectivePrivilegeTier(account);
    const meta = TIER_META[tier];
    const isSelf = account.uid === currentUser.uid;
    const isBusy = mutatingUserId === account.id;
    const controls = computeStepActions(account);
    const fsState = getFirestoreSyncLabel(account);
    const adminAccount = isAdminLevelAccount(account);

    return (
      <tr
        key={account.id}
        className={`transition-colors align-middle ${
          adminAccount
            ? 'bg-[#141A24]/60 hover:bg-[#18212E]'
            : 'hover:bg-[#171B23]'
        }`}
      >
        {/* Column 1: Registered User & Session Context */}
        <td className="py-3.5 px-4">
          <div className="flex items-center gap-2.5">
            {account.photoUrl ? (
              <img
                src={account.photoUrl}
                alt={account.displayName || account.email}
                className="w-8 h-8 rounded-full object-cover shrink-0"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span
                className={`w-8 h-8 rounded-full inline-flex items-center justify-center text-xs font-semibold shrink-0 ${
                  adminAccount
                    ? 'bg-[#182635] text-[#67E8F9]'
                    : 'bg-[#1B202B] text-[#C7D0DF]'
                }`}
              >
                {(account.displayName || account.email || 'U')
                  .charAt(0)
                  .toUpperCase()}
              </span>
            )}
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-[#F5F7FA] truncate max-w-[210px]">
                  {account.displayName || 'Dispatch Member'}
                </span>
                {isSelf && (
                  <>
                    <span className="text-[#6E788A]" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-[11px] font-mono text-[#67E8F9] whitespace-nowrap">
                      You
                    </span>
                  </>
                )}
              </div>
              <div className="text-[11px] font-mono text-[#8C96A8] truncate max-w-[240px]">
                {account.email}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-[#6E788A]">
                <span>{account.emailVerified ? 'Verified' : 'Unverified'}</span>
                <span aria-hidden="true">·</span>
                <span>{formatProviderLabel(account.authProvider)}</span>
                <span aria-hidden="true">·</span>
                <span
                  className={
                    fsState.aligned ? 'text-[#8C96A8]' : 'text-amber-300'
                  }
                >
                  {fsState.text}
                </span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap font-mono text-[11px] text-[#6E788A] tabular-nums">
                <span className="text-[#9BA6B8]">
                  Seen {formatRelativeAge(account.lastActiveAt)}
                </span>
                <span aria-hidden="true">·</span>
                <span>{account.lastSeenDevice || 'Pending telemetry'}</span>
                <span aria-hidden="true">·</span>
                <span>IP {account.lastSeenIp || 'Pending'}</span>
              </div>
            </div>
          </div>
        </td>

        {/* Column 2: Role Domain & Assigned Access Level (Admin vs Standard Visual Distinction) */}
        <td className="py-3.5 px-4">
          <div className="space-y-1 max-w-sm">
            <div className="flex items-center gap-1.5">
              {tier === 'ultra_owner' && (
                <ShieldCheck
                  className="w-4 h-4 text-[#22D3EE] shrink-0"
                  aria-hidden="true"
                />
              )}
              {tier === 'studio_admin' && (
                <UserCheck
                  className="w-4 h-4 text-[#38BDF8] shrink-0"
                  aria-hidden="true"
                />
              )}
              {tier === 'active_member' && (
                <Users
                  className="w-4 h-4 text-[#4ADE80] shrink-0"
                  aria-hidden="true"
                />
              )}
              {tier === 'suspended' && (
                <Ban
                  className="w-4 h-4 text-[#F87171] shrink-0"
                  aria-hidden="true"
                />
              )}
              <span
                className={`font-semibold whitespace-nowrap ${
                  tier === 'ultra_owner'
                    ? 'text-[#67E8F9]'
                    : tier === 'studio_admin'
                      ? 'text-[#BAE6FD]'
                      : tier === 'suspended'
                        ? 'text-[#FCA5A5]'
                        : 'text-[#F5F7FA]'
                }`}
              >
                {meta.domainClass}
              </span>
              <span className="text-[#6E788A]" aria-hidden="true">
                ·
              </span>
              <span
                className={`font-medium whitespace-nowrap ${
                  adminAccount
                    ? 'text-[#F5F7FA]'
                    : tier === 'suspended'
                      ? 'text-[#FCA5A5]'
                      : 'text-[#C7D0DF]'
                }`}
              >
                {meta.shortTitle}
                {tier === 'suspended' && account.role === 'admin'
                  ? ' (Prior Admin)'
                  : ''}
              </span>
            </div>
            <div className="text-[11px] text-[#8C96A8] leading-relaxed">
              {meta.assignedCapabilities.join(' · ')}
            </div>
          </div>
        </td>

        {/* Column 3: Direct Role & Status Switch */}
        <td className="py-3.5 px-4 whitespace-nowrap">
          {account.role === 'owner' ? (
            <div className="space-y-1">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9]">
                <Lock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                Ultra Owner
              </span>
              <div className="text-[11px] font-mono text-[#6E788A]">
                Active · Root Principal
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div
                role="group"
                aria-label={`Role assignment switch for ${account.email}`}
                className="inline-flex items-center gap-0.5 p-0.5 bg-[#0E1116] border border-[#222833] rounded-md"
              >
                <button
                  type="button"
                  disabled={
                    isBusy || !controls.canToggleRole || account.role === 'member'
                  }
                  title={
                    !controls.canToggleRole
                      ? 'Only the Principal Owner can change Standard/Admin role assignments'
                      : 'Set Standard Member role'
                  }
                  onClick={() =>
                    void onMutateUserPrivilege(account, {
                      nextRole: 'member',
                      actionLabel: 'Demote to Standard',
                    })
                  }
                  className={`h-7 px-2.5 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    account.role === 'member'
                      ? 'bg-[#1E2430] text-[#F5F7FA]'
                      : controls.canToggleRole
                        ? 'text-[#8C96A8] hover:text-[#F5F7FA] cursor-pointer'
                        : 'text-[#525B6B] cursor-not-allowed'
                  }`}
                >
                  Standard
                </button>
                <button
                  type="button"
                  disabled={
                    isBusy || !controls.canToggleRole || account.role === 'admin'
                  }
                  title={
                    !controls.canToggleRole
                      ? 'Only the Principal Owner can promote accounts to Studio Admin'
                      : 'Set Studio Admin role'
                  }
                  onClick={() =>
                    void onMutateUserPrivilege(account, {
                      nextRole: 'admin',
                      actionLabel: 'Promote to Admin',
                    })
                  }
                  className={`h-7 px-2.5 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    account.role === 'admin'
                      ? 'bg-[#162836] text-[#67E8F9]'
                      : controls.canToggleRole
                        ? 'text-[#8C96A8] hover:text-[#67E8F9] cursor-pointer'
                        : 'text-[#525B6B] cursor-not-allowed'
                  }`}
                >
                  Admin
                </button>
              </div>

              {!controls.isLocked && (
                <div
                  role="group"
                  aria-label={`Account status switch for ${account.email}`}
                  className="inline-flex items-center gap-0.5 p-0.5 bg-[#0E1116] border border-[#222833] rounded-md"
                >
                  <button
                    type="button"
                    disabled={
                      isBusy ||
                      !controls.canToggleStatus ||
                      account.accountStatus === 'active'
                    }
                    onClick={() =>
                      void onMutateUserPrivilege(account, {
                        nextStatus: 'active',
                        actionLabel: 'Activate Account',
                      })
                    }
                    className={`h-7 px-2 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                      account.accountStatus === 'active'
                        ? 'bg-[#13291D] text-[#4ADE80]'
                        : controls.canToggleStatus
                          ? 'text-[#8C96A8] hover:text-[#4ADE80] cursor-pointer'
                          : 'text-[#525B6B] cursor-not-allowed'
                    }`}
                  >
                    Active
                  </button>
                  <button
                    type="button"
                    disabled={
                      isBusy ||
                      !controls.canToggleStatus ||
                      account.accountStatus === 'suspended'
                    }
                    onClick={() =>
                      void onMutateUserPrivilege(account, {
                        nextStatus: 'suspended',
                        actionLabel: 'Suspend Account',
                      })
                    }
                    className={`h-7 px-2 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                      account.accountStatus === 'suspended'
                        ? 'bg-[#2A1216] text-[#FCA5A5]'
                        : controls.canToggleStatus
                          ? 'text-[#8C96A8] hover:text-[#FCA5A5] cursor-pointer'
                          : 'text-[#525B6B] cursor-not-allowed'
                    }`}
                  >
                    Suspended
                  </button>
                </div>
              )}
            </div>
          )}
        </td>

        {/* Column 4: One-Click Promote / Demote & Audit Trail */}
        <td className="py-3.5 px-4 text-right whitespace-nowrap">
          <div className="inline-flex items-center justify-end gap-2">
            {renderOneClickActionCluster(account)}

            <button
              type="button"
              onClick={() => onInspectUserLogs(account.id)}
              className="h-8 px-2 inline-flex items-center gap-1 text-[11px] text-[#8C96A8] hover:text-[#F5F7FA] transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums"
              title="Open user event history in Searchable Activity Log"
            >
              <FileText className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Logs ({account.counts.activityLogs})
            </button>
          </div>
        </td>
      </tr>
    );
  };

  const renderSplitBoardItem = (account: OwnerAuditedUser) => {
    const tier = resolveEffectivePrivilegeTier(account);
    const meta = TIER_META[tier];
    const isSelf = account.uid === currentUser.uid;
    const fsState = getFirestoreSyncLabel(account);
    const adminAccount = isAdminLevelAccount(account);

    return (
      <div
        key={account.id}
        className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[#171B23] transition-colors"
      >
        <div className="flex items-start gap-3 min-w-0">
          {account.photoUrl ? (
            <img
              src={account.photoUrl}
              alt={account.displayName || account.email}
              className="w-8 h-8 rounded-full object-cover shrink-0 mt-0.5"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span
              className={`w-8 h-8 rounded-full inline-flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5 ${
                adminAccount
                  ? 'bg-[#182635] text-[#67E8F9]'
                  : 'bg-[#1B202B] text-[#C7D0DF]'
              }`}
            >
              {(account.displayName || account.email || 'U')
                .charAt(0)
                .toUpperCase()}
            </span>
          )}

          <div className="min-w-0 space-y-0.5 text-xs">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-medium text-[#F5F7FA] truncate max-w-[200px]">
                {account.displayName || 'Dispatch Member'}
              </span>
              {isSelf && (
                <>
                  <span className="text-[#6E788A]" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-mono text-[11px] text-[#67E8F9]">You</span>
                </>
              )}
              <span className="text-[#6E788A]" aria-hidden="true">
                ·
              </span>
              <span
                className={`font-medium ${
                  tier === 'ultra_owner'
                    ? 'text-[#67E8F9]'
                    : tier === 'studio_admin'
                      ? 'text-[#BAE6FD]'
                      : tier === 'suspended'
                        ? 'text-[#FCA5A5]'
                        : 'text-[#D5DCE6]'
                }`}
              >
                {meta.shortTitle}
              </span>
            </div>

            <div className="font-mono text-[11px] text-[#8C96A8] truncate max-w-[260px]">
              {account.email}
            </div>

            <div className="text-[11px] text-[#6E788A] flex items-center gap-1.5 flex-wrap font-mono tabular-nums">
              <span>{account.emailVerified ? 'Verified' : 'Unverified'}</span>
              <span aria-hidden="true">·</span>
              <span className={fsState.aligned ? 'text-[#8C96A8]' : 'text-amber-300'}>
                {fsState.text}
              </span>
              <span aria-hidden="true">·</span>
              <span>Seen {formatRelativeAge(account.lastActiveAt)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
          {renderOneClickActionCluster(account, true)}
        </div>
      </div>
    );
  };

  return (
    <section className="space-y-6">
      {/* Section 1: Header & Admin vs. Standard Proportional Spectrum (Flat surface, zero nested cards) */}
      <div className="space-y-4 pb-5 border-b border-[#1F2532]">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-[#F5F7FA]">
              Privilege Management &amp; Role Access Control
            </h2>
            <p className="text-xs text-[#8C96A8] max-w-3xl">
              Audit all registered accounts, contrast{' '}
              <strong className="text-[#BAE6FD] font-medium">
                Admin-Level governance
              </strong>{' '}
              against{' '}
              <strong className="text-[#D5DCE6] font-medium">
                Standard collaborator access
              </strong>
              , and promote or demote privileges in one click across Cloud SQL and
              Firestore <span className="font-mono text-[#C7D0DF]">/userProfiles</span>.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <span className="text-xs text-[#8C96A8] font-mono tabular-nums mr-1">
              Authority:{' '}
              <strong className="text-[#67E8F9] font-medium">
                {isOwner
                  ? 'Ultra Owner (Full Promote/Demote)'
                  : callerRole === 'admin'
                    ? 'Studio Admin (Standard Status)'
                    : 'Read-Only'}
              </strong>
            </span>
            <button
              type="button"
              onClick={() => setShowMatrix((prev) => !prev)}
              className={`h-8 px-3 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                showMatrix
                  ? 'bg-[#18212E] text-[#67E8F9] border-[#22D3EE]'
                  : 'bg-[#13161C] text-[#D5DCE6] hover:text-[#F5F7FA] border-[#222833] hover:border-[#22D3EE]/45'
              }`}
            >
              {showMatrix ? 'Hide Permission Matrix' : 'Compare Permissions'}
            </button>
            <button
              type="button"
              disabled={sortedAndFilteredUsers.length === 0}
              onClick={handleExportPrivilegeCsv}
              className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#D5DCE6] hover:text-[#F5F7FA] bg-[#13161C] border border-[#222833] hover:border-[#22D3EE]/45 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-[#22D3EE]" aria-hidden="true" />
              Export Roles CSV
            </button>
          </div>
        </div>

        {/* Proportional SVG Role Distribution Bar */}
        <div className="space-y-2">
          <svg
            viewBox="0 0 1000 10"
            preserveAspectRatio="none"
            className="w-full h-2.5 rounded overflow-hidden bg-[#13161C]"
            role="img"
            aria-label="Proportional balance between Admin-Level, Standard, and Suspended accounts"
          >
            {tierStats.segments.ownerW > 0 && (
              <rect
                x={tierStats.segments.ownerX}
                y={0}
                width={tierStats.segments.ownerW}
                height={10}
                className="fill-[#22D3EE]"
              />
            )}
            {tierStats.segments.adminW > 0 && (
              <rect
                x={tierStats.segments.adminX}
                y={0}
                width={tierStats.segments.adminW}
                height={10}
                className="fill-[#38BDF8]"
              />
            )}
            {tierStats.segments.memberW > 0 && (
              <rect
                x={tierStats.segments.memberX}
                y={0}
                width={tierStats.segments.memberW}
                height={10}
                className="fill-[#16A34A]"
              />
            )}
            {tierStats.segments.suspendedW > 0 && (
              <rect
                x={tierStats.segments.suspendedX}
                y={0}
                width={tierStats.segments.suspendedW}
                height={10}
                className="fill-[#DC2626]"
              />
            )}
          </svg>

          <div className="flex items-center justify-between gap-3 flex-wrap text-xs font-mono text-[#8C96A8] tabular-nums">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-[#67E8F9] font-medium">
                Admin-Level Roles: {tierStats.adminLevelCount} ({tierStats.counts.ultra_owner}{' '}
                Owner · {tierStats.counts.studio_admin} Admin)
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-[#4ADE80] font-medium">
                Standard Roles: {tierStats.standardLevelCount}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-[#FCA5A5]">
                Suspended: {tierStats.counts.suspended}
              </span>
            </div>
            <span>Total Registered Accounts: {tierStats.total}</span>
          </div>
        </div>

        {/* 4 Single-Elevation Role Tier Cards (Click to isolate any tier) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 pt-1">
          {(
            [
              'ultra_owner',
              'studio_admin',
              'active_member',
              'suspended',
            ] as const
          ).map((tierKey) => {
            const meta = TIER_META[tierKey];
            const count = tierStats.counts[tierKey];
            const verified = tierStats.verifiedCounts[tierKey];
            const pct =
              tierStats.total > 0
                ? Math.round((count / tierStats.total) * 100)
                : 0;
            const selected = domainFilter === tierKey;
            const isAdminCard =
              tierKey === 'ultra_owner' || tierKey === 'studio_admin';

            return (
              <button
                key={tierKey}
                type="button"
                onClick={() =>
                  setDomainFilter((prev) =>
                    prev === tierKey ? 'all' : tierKey
                  )
                }
                className={`text-left p-4 rounded-lg border transition-colors cursor-pointer space-y-2 ${
                  selected
                    ? 'bg-[#18212E] border-[#22D3EE]'
                    : isAdminCard
                      ? 'bg-[#131822] border-[#253246] hover:border-[#22D3EE]/55'
                      : 'bg-[#13161C] border-[#222833] hover:border-[#22D3EE]/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-[11px] font-medium ${
                      tierKey === 'ultra_owner'
                        ? 'text-[#67E8F9]'
                        : tierKey === 'studio_admin'
                          ? 'text-[#BAE6FD]'
                          : tierKey === 'suspended'
                            ? 'text-[#FCA5A5]'
                            : 'text-[#4ADE80]'
                    }`}
                  >
                    {meta.domainClass}
                  </span>
                  {tierKey === 'ultra_owner' && (
                    <ShieldCheck
                      className="w-4 h-4 text-[#22D3EE] shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  {tierKey === 'studio_admin' && (
                    <UserCheck
                      className="w-4 h-4 text-[#38BDF8] shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  {tierKey === 'active_member' && (
                    <Users
                      className="w-4 h-4 text-[#16A34A] shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  {tierKey === 'suspended' && (
                    <Ban
                      className="w-4 h-4 text-[#F87171] shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </div>

                <div className="text-sm font-semibold text-[#F5F7FA]">
                  {meta.title}
                </div>

                <div className="flex items-baseline justify-between gap-2 font-mono tabular-nums">
                  <span className="text-2xl font-semibold text-[#F5F7FA]">
                    {count}
                  </span>
                  <span className="text-[11px] text-[#8C96A8]">
                    {pct}% · {verified} verified
                  </span>
                </div>

                <p className="text-[11px] text-[#8C96A8] leading-relaxed">
                  {meta.authoritySummary}
                </p>
              </button>
            );
          })}
        </div>

        {firestoreStreamNote && (
          <div className="flex items-center gap-2 text-xs text-amber-300 pt-1">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>
              Firestore live profile stream notice: {firestoreStreamNote}
            </span>
          </div>
        )}
      </div>

      {/* Section 2: Collapsible Standard vs. Admin Permission Matrix */}
      {showMatrix && (
        <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#1F2532] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-[#F5F7FA]">
                Admin-Level vs. Standard Role Permission Matrix
              </h3>
              <p className="text-xs text-[#8C96A8]">
                Enforced simultaneously by server-side Firebase ID token
                verification, Cloud SQL RBAC checks, and Firestore security
                rules.
              </p>
            </div>
            <span className="text-[11px] font-mono text-[#8C96A8] tabular-nums whitespace-nowrap shrink-0">
              Immutable Principal: {PRINCIPAL_OWNER_EMAIL}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                  <th className="py-2.5 px-4">Studio Capability &amp; Scope</th>
                  <th className="py-2.5 px-4 text-[#67E8F9]">
                    Admin · Ultra Owner
                  </th>
                  <th className="py-2.5 px-4 text-[#BAE6FD]">
                    Admin · Studio Admin
                  </th>
                  <th className="py-2.5 px-4 text-[#D5DCE6]">
                    Standard · Member
                  </th>
                  <th className="py-2.5 px-4 text-[#FCA5A5]">
                    Restricted · Suspended
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1C212C] text-xs">
                {CAPABILITY_MATRIX.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-[#171B23] transition-colors"
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-[#F5F7FA]">
                        {row.capability}
                      </div>
                      <div className="text-[11px] text-[#8C96A8]">
                        {row.scopeDescription}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-[#67E8F9] whitespace-nowrap">
                      {row.ultraOwner}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-[#BAE6FD] whitespace-nowrap">
                      {row.studioAdmin}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-[#D5DCE6] whitespace-nowrap">
                      {row.standardMember}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px] text-[#FCA5A5] whitespace-nowrap">
                      {row.suspended}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 3: All-Users Privilege Management Toolbar & Views */}
      <div className="space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search
              className="w-3.5 h-3.5 text-[#6E788A] absolute left-3 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search all users by name, email, admin/standard role, device, or IP..."
              className="w-full h-9 pl-8 pr-3 bg-[#13161C] border border-[#222833] focus:border-[#22D3EE] rounded-md text-xs text-[#F5F7FA] placeholder:text-[#6E788A] focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Role Domain Segmented Filter */}
            <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md overflow-x-auto">
              {(
                [
                  { id: 'all', label: `All Users (${users.length})` },
                  {
                    id: 'admin_level',
                    label: `Admin-Level (${tierStats.adminLevelCount})`,
                  },
                  {
                    id: 'standard_level',
                    label: `Standard Role (${tierStats.standardLevelCount})`,
                  },
                  {
                    id: 'suspended',
                    label: `Suspended (${tierStats.counts.suspended})`,
                  },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setDomainFilter(item.id)}
                  className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums ${
                    domainFilter === item.id
                      ? 'bg-[#1C2533] text-[#67E8F9]'
                      : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                  }`}
                >
                  <span className="font-sans">{item.label}</span>
                </button>
              ))}
            </div>

            {/* Visual Layout Mode Switcher */}
            <div className="flex items-center gap-1 p-1 bg-[#13161C] border border-[#222833] rounded-md">
              <button
                type="button"
                onClick={() => setViewMode('directory')}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewMode === 'directory'
                    ? 'bg-[#1C2533] text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                All Users Directory
              </button>
              <button
                type="button"
                onClick={() => setViewMode('split')}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewMode === 'split'
                    ? 'bg-[#1C2533] text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                Admin vs Standard Split
              </button>
              <button
                type="button"
                onClick={() => setViewMode('hierarchy')}
                className={`h-7 px-2.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewMode === 'hierarchy'
                    ? 'bg-[#1C2533] text-[#67E8F9]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                Tier Groups
              </button>
            </div>
          </div>
        </div>

        {/* Directory / Split / Hierarchy Surface */}
        {isLoadingData && users.length === 0 ? (
          <div className="bg-[#13161C] border border-[#222833] rounded-lg py-12 text-center text-xs text-[#8C96A8]">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-[#22D3EE]" />
              Loading registered users and role access assignments...
            </span>
          </div>
        ) : sortedAndFilteredUsers.length === 0 ? (
          <div className="bg-[#13161C] border border-[#222833] rounded-lg py-10 px-6 text-center space-y-2.5">
            <p className="text-xs text-[#8C96A8]">
              No registered user accounts match the active role filter or search
              query.
            </p>
            {(searchQuery || domainFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setDomainFilter('all');
                }}
                className="h-8 px-3.5 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
              >
                Reset Role Filters
              </button>
            )}
          </div>
        ) : viewMode === 'directory' ? (
          <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                    <th className="py-3 px-4">Registered User</th>
                    <th className="py-3 px-4">
                      Role Domain &amp; Access Level
                    </th>
                    <th className="py-3 px-4">Direct Role &amp; Status Switch</th>
                    <th className="py-3 px-4 text-right">
                      One-Click Promote / Demote
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1C212C] text-xs">
                  {sortedAndFilteredUsers.map(renderUserRow)}
                </tbody>
              </table>
            </div>
          </div>
        ) : viewMode === 'split' ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            {/* Left Lane: Admin-Level Roles */}
            <div className="bg-[#13161C] border border-[#22D3EE]/35 rounded-lg overflow-hidden">
              <div className="px-4 py-3.5 bg-[#101722] border-b border-[#1F2532] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <ShieldCheck
                    className="w-4 h-4 text-[#22D3EE] shrink-0"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <h3 className="text-xs font-semibold text-[#F5F7FA] truncate">
                      Admin-Level Roles (Ultra Owner &amp; Studio Admin)
                    </h3>
                    <p className="text-[11px] text-[#8C96A8] truncate">
                      Full Owner Console, user session telemetry, and share governance
                    </p>
                  </div>
                </div>
                <span className="text-xs font-mono text-[#67E8F9] tabular-nums whitespace-nowrap shrink-0">
                  {splitBuckets.adminAccounts.length}{' '}
                  {splitBuckets.adminAccounts.length === 1 ? 'user' : 'users'}
                </span>
              </div>

              {splitBuckets.adminAccounts.length === 0 ? (
                <div className="py-8 px-4 text-center text-xs text-[#8C96A8]">
                  No Admin-Level accounts match the current filter.
                </div>
              ) : (
                <div className="divide-y divide-[#1C212C]">
                  {splitBuckets.adminAccounts.map(renderSplitBoardItem)}
                </div>
              )}
            </div>

            {/* Right Lane: Standard & Restricted Roles */}
            <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
              <div className="px-4 py-3.5 bg-[#101319] border-b border-[#1F2532] flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Users
                    className="w-4 h-4 text-[#4ADE80] shrink-0"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <h3 className="text-xs font-semibold text-[#F5F7FA] truncate">
                      Standard Collaborator &amp; Restricted Accounts
                    </h3>
                    <p className="text-[11px] text-[#8C96A8] truncate">
                      Creative workbenches only · isolated from administrative controls
                    </p>
                  </div>
                </div>
                <span className="text-xs font-mono text-[#C7D0DF] tabular-nums whitespace-nowrap shrink-0">
                  {splitBuckets.standardAndRestrictedAccounts.length}{' '}
                  {splitBuckets.standardAndRestrictedAccounts.length === 1
                    ? 'user'
                    : 'users'}
                </span>
              </div>

              {splitBuckets.standardAndRestrictedAccounts.length === 0 ? (
                <div className="py-8 px-4 text-center text-xs text-[#8C96A8]">
                  No Standard or Suspended accounts match the current filter.
                </div>
              ) : (
                <div className="divide-y divide-[#1C212C]">
                  {splitBuckets.standardAndRestrictedAccounts.map(
                    renderSplitBoardItem
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {(
              [
                'ultra_owner',
                'studio_admin',
                'active_member',
                'suspended',
              ] as const
            ).map((tierKey) => {
              const bucket = groupedUsers[tierKey];
              if (bucket.length === 0) return null;
              const meta = TIER_META[tierKey];

              return (
                <div
                  key={tierKey}
                  className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden"
                >
                  <div className="px-4 py-3 bg-[#101319] border-b border-[#1F2532] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-xs font-semibold ${
                          tierKey === 'ultra_owner'
                            ? 'text-[#67E8F9]'
                            : tierKey === 'studio_admin'
                              ? 'text-[#BAE6FD]'
                              : tierKey === 'suspended'
                                ? 'text-[#FCA5A5]'
                                : 'text-[#F5F7FA]'
                        }`}
                      >
                        {meta.title} · {meta.domainClass}
                      </span>
                      <span
                        aria-hidden="true"
                        className="text-xs text-[#6E788A]"
                      >
                        ·
                      </span>
                      <span className="text-xs text-[#8C96A8]">
                        {meta.assignedCapabilities.join(' · ')}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-[#8C96A8] tabular-nums whitespace-nowrap shrink-0">
                      {bucket.length}{' '}
                      {bucket.length === 1 ? 'account' : 'accounts'}
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                          <th className="py-2.5 px-4">Registered User</th>
                          <th className="py-2.5 px-4">
                            Role Domain &amp; Access Level
                          </th>
                          <th className="py-2.5 px-4">
                            Direct Role &amp; Status Switch
                          </th>
                          <th className="py-2.5 px-4 text-right">
                            One-Click Promote / Demote
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1C212C] text-xs">
                        {bucket.map(renderUserRow)}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 4: Recent Privilege Promotions & Demotions Audit Trail */}
      <div className="bg-[#13161C] border border-[#222833] rounded-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#1F2532] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2
              className="w-4 h-4 text-[#22D3EE] shrink-0"
              aria-hidden="true"
            />
            <div>
              <h3 className="text-sm font-semibold text-[#F5F7FA]">
                Recent Privilege Promotions &amp; Demotions
              </h3>
              <p className="text-xs text-[#8C96A8]">
                Every Admin/Standard role change and account status transition is
                logged with before/after accountability records.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenPrivilegeAuditLog}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium text-[#67E8F9] bg-[#18212E] border border-[#22D3EE]/40 hover:border-[#22D3EE] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
            Open Full Privilege Log
          </button>
        </div>

        {privilegeAuditEvents.length === 0 ? (
          <div className="py-6 px-5 text-xs text-[#8C96A8]">
            No privilege promotions or demotions have been recorded in the recent
            window yet. Use the One-Click Promote/Demote controls above to modify
            collaborator access levels.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1F2532] text-xs font-medium text-[#8C96A8]">
                  <th className="py-2.5 px-4">Timestamp</th>
                  <th className="py-2.5 px-4">Administrator</th>
                  <th className="py-2.5 px-4">Action</th>
                  <th className="py-2.5 px-4">Access Transition</th>
                  <th className="py-2.5 px-4">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1C212C] text-xs">
                {privilegeAuditEvents.map((log) => {
                  const diff = extractAuditStateTransition(log);
                  return (
                    <tr
                      key={log.id}
                      className="hover:bg-[#171B23] transition-colors"
                    >
                      <td className="py-2.5 px-4 font-mono text-[11px] text-[#8C96A8] tabular-nums whitespace-nowrap">
                        <div>{formatDateTime(log.createdAt)}</div>
                        <div className="text-[#6E788A]">
                          {formatRelativeAge(log.createdAt)}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[11px] text-[#D5DCE6] whitespace-nowrap">
                        {log.actorEmail}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[11px] text-[#67E8F9] whitespace-nowrap">
                        {log.action}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[11px] text-[#F5F7FA] whitespace-nowrap">
                        {diff ? (
                          <span>
                            <span className="text-[#8C96A8]">{diff.before}</span>{' '}
                            →{' '}
                            <span className="text-[#67E8F9]">{diff.after}</span>
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-[#C7D0DF]">
                        {log.summary}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
