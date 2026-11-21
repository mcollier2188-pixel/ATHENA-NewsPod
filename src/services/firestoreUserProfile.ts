import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestoreError';

export const PRINCIPAL_OWNER_EMAIL = 'mcollier2188@gmail.com';

// Volumetric & regex constraints synchronized verbatim with firebase-blueprint.json
const UID_MAX_LENGTH = 128;
const UID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const EMAIL_MIN_LENGTH = 3;
const EMAIL_MAX_LENGTH = 200;
const DISPLAY_NAME_MAX_LENGTH = 140;
const PHOTO_URL_MAX_LENGTH = 2048;
const AUTH_PROVIDER_MAX_LENGTH = 64;
const ISO_TIMESTAMP_MAX_LENGTH = 64;

const ALLOWED_PROFILE_KEYS = new Set([
  'uid',
  'email',
  'displayName',
  'photoUrl',
  'authProvider',
  'emailVerified',
  'role',
  'isOwner',
  'accountStatus',
  'syncSource',
  'lastSyncedAtIso',
  'createdAt',
  'updatedAt',
]);

const VALID_ROLES = new Set(['owner', 'admin', 'member']);
const VALID_STATUSES = new Set(['active', 'suspended']);
const VALID_SYNC_SOURCES = new Set([
  'google_signin',
  'repair_auth',
  'sync_auth',
  'admin_governance',
]);

export type SyncProfileSource =
  | 'google_signin'
  | 'repair_auth'
  | 'sync_auth'
  | 'admin_governance';

export interface FirestoreUserProfileDoc {
  uid: string;
  email: string;
  displayName: string;
  photoUrl: string;
  authProvider: string;
  emailVerified: boolean;
  role: 'owner' | 'admin' | 'member';
  isOwner: boolean;
  accountStatus: 'active' | 'suspended';
  syncSource: SyncProfileSource;
  lastSyncedAtIso: string;
}

export interface InspectedFirestoreUserProfile {
  docId: string;
  parsed: FirestoreUserProfileDoc;
  rawUid: string;
  rawRole: string;
  rawIsOwner: unknown;
  rawAccountStatus: string;
  rawEmailVerified: unknown;
  rawSchemaIssues: string[];
  isCorruptedSchema: boolean;
  uidMismatch: boolean;
  contradictoryOwnerFlag: boolean;
  hasShadowFields: boolean;
  missingTimestamps: boolean;
}

function sanitizeBoundedString(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

function sanitizeEmail(rawEmail: unknown, fallbackUid: string): string {
  const cleaned = sanitizeBoundedString(rawEmail, EMAIL_MAX_LENGTH);
  if (cleaned.length >= EMAIL_MIN_LENGTH) return cleaned;
  return `${fallbackUid}@dispatch.local`.slice(0, EMAIL_MAX_LENGTH);
}

function resolvePrimaryProvider(firebaseUser: User, fallback = 'google.com'): string {
  const fromProviderData = firebaseUser.providerData?.find(
    (p) => typeof p?.providerId === 'string' && p.providerId.trim().length > 0
  )?.providerId;
  const candidate = sanitizeBoundedString(
    fromProviderData || fallback,
    AUTH_PROVIDER_MAX_LENGTH
  );
  return candidate || 'google.com';
}

export function isValidFirestoreProfileUid(uid: string): boolean {
  return (
    typeof uid === 'string' &&
    uid.length >= 1 &&
    uid.length <= UID_MAX_LENGTH &&
    UID_PATTERN.test(uid)
  );
}

function parseFirestoreProfileSnapshot(
  uid: string,
  data: Record<string, unknown>
): FirestoreUserProfileDoc {
  const rawRole = data.role;
  const role: 'owner' | 'admin' | 'member' =
    rawRole === 'owner' || rawRole === 'admin' ? rawRole : 'member';
  const accountStatus: 'active' | 'suspended' =
    data.accountStatus === 'suspended' ? 'suspended' : 'active';
  const rawSource = data.syncSource;
  const syncSource: SyncProfileSource =
    rawSource === 'repair_auth' ||
    rawSource === 'sync_auth' ||
    rawSource === 'admin_governance'
      ? rawSource
      : 'google_signin';

  return {
    uid: sanitizeBoundedString(data.uid || uid, UID_MAX_LENGTH) || uid,
    email: sanitizeEmail(data.email, uid),
    displayName: sanitizeBoundedString(data.displayName, DISPLAY_NAME_MAX_LENGTH),
    photoUrl: sanitizeBoundedString(data.photoUrl, PHOTO_URL_MAX_LENGTH),
    authProvider:
      sanitizeBoundedString(data.authProvider, AUTH_PROVIDER_MAX_LENGTH) || 'google.com',
    emailVerified: Boolean(data.emailVerified),
    role,
    isOwner: Boolean(data.isOwner),
    accountStatus,
    syncSource,
    lastSyncedAtIso:
      sanitizeBoundedString(data.lastSyncedAtIso, ISO_TIMESTAMP_MAX_LENGTH) || '',
  };
}

export function inspectFirestoreProfileSnapshot(
  docId: string,
  data: Record<string, unknown>
): InspectedFirestoreUserProfile {
  const rawSchemaIssues: string[] = [];
  const rawKeys = Object.keys(data);

  const shadowKeys = rawKeys.filter((k) => !ALLOWED_PROFILE_KEYS.has(k));
  const hasShadowFields = shadowKeys.length > 0;
  if (hasShadowFields) {
    rawSchemaIssues.push(
      `Undeclared shadow ${shadowKeys.length === 1 ? 'field' : 'fields'} (${shadowKeys.slice(0, 3).join(', ')})`
    );
  }

  const missingKeys: string[] = [];
  ALLOWED_PROFILE_KEYS.forEach((reqKey) => {
    if (!(reqKey in data)) {
      missingKeys.push(reqKey);
    }
  });
  if (missingKeys.length > 0) {
    rawSchemaIssues.push(
      `Missing required Firestore ${missingKeys.length === 1 ? 'field' : 'fields'} (${missingKeys.slice(0, 4).join(', ')})`
    );
  }

  const rawUid = typeof data.uid === 'string' ? data.uid : '';
  const uidMismatch = !isValidFirestoreProfileUid(rawUid) || rawUid !== docId;
  if (uidMismatch) {
    rawSchemaIssues.push(
      rawUid
        ? `Corrupted UID link: field "${rawUid}" does not match document ID "${docId}"`
        : 'Corrupted UID link: missing or non-string uid field'
    );
  }

  if (
    typeof data.email !== 'string' ||
    data.email.trim().length < EMAIL_MIN_LENGTH ||
    data.email.length > EMAIL_MAX_LENGTH
  ) {
    rawSchemaIssues.push('Corrupted or out-of-bounds email string in Firestore profile');
  }

  const rawRole = typeof data.role === 'string' ? data.role : String(data.role ?? '');
  if (!VALID_ROLES.has(rawRole)) {
    rawSchemaIssues.push(`Invalid Firestore role value "${rawRole || 'empty'}"`);
  }

  const contradictoryOwnerFlag =
    typeof data.isOwner !== 'boolean' || data.isOwner !== (data.role === 'owner');
  if (contradictoryOwnerFlag) {
    rawSchemaIssues.push(
      `Contradictory ownership flags (role="${rawRole}", isOwner=${String(data.isOwner)})`
    );
  }

  const rawAccountStatus =
    typeof data.accountStatus === 'string'
      ? data.accountStatus
      : String(data.accountStatus ?? '');
  if (!VALID_STATUSES.has(rawAccountStatus)) {
    rawSchemaIssues.push(
      `Invalid Firestore accountStatus "${rawAccountStatus || 'empty'}"`
    );
  }

  if (typeof data.emailVerified !== 'boolean') {
    rawSchemaIssues.push('Non-boolean emailVerified field in Firestore profile');
  }

  const rawSyncSource =
    typeof data.syncSource === 'string' ? data.syncSource : String(data.syncSource ?? '');
  if (!VALID_SYNC_SOURCES.has(rawSyncSource)) {
    rawSchemaIssues.push(`Unrecognized syncSource "${rawSyncSource || 'empty'}"`);
  }

  const missingTimestamps = !data.createdAt || !data.updatedAt;
  if (missingTimestamps) {
    rawSchemaIssues.push('Missing server createdAt or updatedAt timestamp');
  }

  return {
    docId,
    parsed: parseFirestoreProfileSnapshot(docId, data),
    rawUid,
    rawRole,
    rawIsOwner: data.isOwner,
    rawAccountStatus,
    rawEmailVerified: data.emailVerified,
    rawSchemaIssues,
    isCorruptedSchema: rawSchemaIssues.length > 0,
    uidMismatch,
    contradictoryOwnerFlag,
    hasShadowFields,
    missingTimestamps,
  };
}

export async function syncCallerFirestoreProfile(
  firebaseUser: User,
  authoritativeProfile: {
    role: 'owner' | 'admin' | 'member';
    accountStatus: 'active' | 'suspended';
    authProvider?: string;
  },
  syncSource: 'google_signin' | 'repair_auth' | 'sync_auth' = 'google_signin'
): Promise<{
  synced: boolean;
  repairedOwnershipFlag: boolean;
  profile: FirestoreUserProfileDoc | null;
}> {
  const uid = firebaseUser.uid;
  if (!isValidFirestoreProfileUid(uid) || !firebaseUser.emailVerified) {
    return { synced: false, repairedOwnershipFlag: false, profile: null };
  }

  const isCallerPrincipal =
    firebaseUser.emailVerified &&
    firebaseUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL;

  const docPath = `userProfiles/${uid}`;
  const profileRef = doc(db, 'userProfiles', uid);
  const nowIso = new Date().toISOString().slice(0, ISO_TIMESTAMP_MAX_LENGTH);
  const cleanEmail = sanitizeEmail(firebaseUser.email, uid);
  const cleanDisplayName = sanitizeBoundedString(
    firebaseUser.displayName,
    DISPLAY_NAME_MAX_LENGTH
  );
  const cleanPhotoUrl = sanitizeBoundedString(firebaseUser.photoURL, PHOTO_URL_MAX_LENGTH);
  const cleanProvider = resolvePrimaryProvider(
    firebaseUser,
    authoritativeProfile.authProvider || 'google.com'
  );

  let existingInspected: InspectedFirestoreUserProfile | null = null;
  try {
    const snap = await getDoc(profileRef);
    if (snap.exists()) {
      existingInspected = inspectFirestoreProfileSnapshot(
        uid,
        snap.data() as Record<string, unknown>
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, docPath);
  }

  if (!existingInspected) {
    const nextRole: 'owner' | 'member' = isCallerPrincipal ? 'owner' : 'member';
    const nextDoc: FirestoreUserProfileDoc = {
      uid,
      email: cleanEmail,
      displayName: cleanDisplayName,
      photoUrl: cleanPhotoUrl,
      authProvider: cleanProvider,
      emailVerified: true,
      role: nextRole,
      isOwner: isCallerPrincipal,
      accountStatus: 'active',
      syncSource,
      lastSyncedAtIso: nowIso,
    };

    try {
      await setDoc(profileRef, {
        ...nextDoc,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, docPath);
    }

    return {
      synced: true,
      repairedOwnershipFlag:
        isCallerPrincipal && (syncSource === 'repair_auth' || syncSource === 'sync_auth'),
      profile: nextDoc,
    };
  }

  const existingProfile = existingInspected.parsed;

  if (isCallerPrincipal) {
    const hadOwnershipMisflag =
      existingProfile.role !== 'owner' ||
      existingProfile.isOwner !== true ||
      existingProfile.accountStatus !== 'active' ||
      existingInspected.isCorruptedSchema;

    const repairedDoc: FirestoreUserProfileDoc = {
      uid,
      email: cleanEmail,
      displayName: cleanDisplayName || existingProfile.displayName,
      photoUrl: cleanPhotoUrl || existingProfile.photoUrl,
      authProvider: cleanProvider,
      emailVerified: true,
      role: 'owner',
      isOwner: true,
      accountStatus: 'active',
      syncSource: hadOwnershipMisflag && syncSource === 'google_signin' ? 'repair_auth' : syncSource,
      lastSyncedAtIso: nowIso,
    };

    // If immutable fields or shadow keys were corrupted, delete + recreate cleanly
    if (
      existingInspected.uidMismatch ||
      existingInspected.missingTimestamps ||
      existingInspected.hasShadowFields
    ) {
      try {
        await deleteDoc(profileRef);
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, docPath);
      }
      try {
        await setDoc(profileRef, {
          ...repairedDoc,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, docPath);
      }
    } else {
      try {
        await updateDoc(profileRef, {
          email: repairedDoc.email,
          displayName: repairedDoc.displayName,
          photoUrl: repairedDoc.photoUrl,
          authProvider: repairedDoc.authProvider,
          emailVerified: true,
          role: 'owner',
          isOwner: true,
          accountStatus: 'active',
          syncSource: repairedDoc.syncSource,
          lastSyncedAtIso: repairedDoc.lastSyncedAtIso,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, docPath);
      }
    }

    return {
      synced: true,
      repairedOwnershipFlag: hadOwnershipMisflag,
      profile: repairedDoc,
    };
  }

  // Standard verified collaborator: cannot update if suspended, and preserves existing RBAC fields
  if (
    existingProfile.accountStatus === 'suspended' ||
    authoritativeProfile.accountStatus === 'suspended'
  ) {
    return {
      synced: false,
      repairedOwnershipFlag: false,
      profile: existingProfile,
    };
  }

  const nextSelfDoc: FirestoreUserProfileDoc = {
    ...existingProfile,
    email: cleanEmail,
    displayName: cleanDisplayName || existingProfile.displayName,
    photoUrl: cleanPhotoUrl || existingProfile.photoUrl,
    authProvider: cleanProvider,
    emailVerified: true,
    syncSource,
    lastSyncedAtIso: nowIso,
  };

  try {
    await updateDoc(profileRef, {
      email: nextSelfDoc.email,
      displayName: nextSelfDoc.displayName,
      photoUrl: nextSelfDoc.photoUrl,
      authProvider: nextSelfDoc.authProvider,
      emailVerified: true,
      syncSource: nextSelfDoc.syncSource,
      lastSyncedAtIso: nextSelfDoc.lastSyncedAtIso,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, docPath);
  }

  return {
    synced: true,
    repairedOwnershipFlag: false,
    profile: nextSelfDoc,
  };
}

export async function fetchInspectedFirestoreProfilesMap(
  callerUser: User,
  isCallerPrincipalOwner: boolean
): Promise<Map<string, InspectedFirestoreUserProfile>> {
  const result = new Map<string, InspectedFirestoreUserProfile>();
  if (!callerUser.emailVerified) return result;

  if (isCallerPrincipalOwner) {
    const colPath = 'userProfiles';
    try {
      const snap = await getDocs(collection(db, colPath));
      snap.forEach((docSnap) => {
        result.set(
          docSnap.id,
          inspectFirestoreProfileSnapshot(
            docSnap.id,
            docSnap.data() as Record<string, unknown>
          )
        );
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, colPath);
    }
    return result;
  }

  if (isValidFirestoreProfileUid(callerUser.uid)) {
    const docPath = `userProfiles/${callerUser.uid}`;
    try {
      const snap = await getDoc(doc(db, 'userProfiles', callerUser.uid));
      if (snap.exists()) {
        result.set(
          callerUser.uid,
          inspectFirestoreProfileSnapshot(
            callerUser.uid,
            snap.data() as Record<string, unknown>
          )
        );
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, docPath);
    }
  }

  return result;
}

export async function fetchFirestoreUserProfilesMap(
  callerUser: User,
  isCallerPrincipalOwner: boolean
): Promise<Map<string, FirestoreUserProfileDoc>> {
  const inspected = await fetchInspectedFirestoreProfilesMap(
    callerUser,
    isCallerPrincipalOwner
  );
  const plain = new Map<string, FirestoreUserProfileDoc>();
  inspected.forEach((item, key) => {
    plain.set(key, item.parsed);
  });
  return plain;
}

export function subscribeToFirestoreUserProfiles(
  callerUser: User,
  isCallerPrincipalOwner: boolean,
  onProfiles: (profiles: Map<string, InspectedFirestoreUserProfile>) => void,
  onError?: (message: string) => void
): Unsubscribe {
  if (!callerUser.emailVerified) {
    onProfiles(new Map());
    return () => {};
  }

  if (isCallerPrincipalOwner) {
    const colPath = 'userProfiles';
    return onSnapshot(
      collection(db, colPath),
      (snap) => {
        const nextMap = new Map<string, InspectedFirestoreUserProfile>();
        snap.forEach((docSnap) => {
          nextMap.set(
            docSnap.id,
            inspectFirestoreProfileSnapshot(
              docSnap.id,
              docSnap.data() as Record<string, unknown>
            )
          );
        });
        onProfiles(nextMap);
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, colPath);
        } catch (wrapped) {
          onError?.(
            wrapped instanceof Error
              ? wrapped.message
              : 'Firestore userProfiles subscription error.'
          );
        }
      }
    );
  }

  if (!isValidFirestoreProfileUid(callerUser.uid)) {
    onProfiles(new Map());
    return () => {};
  }

  const docPath = `userProfiles/${callerUser.uid}`;
  return onSnapshot(
    doc(db, 'userProfiles', callerUser.uid),
    (docSnap) => {
      const nextMap = new Map<string, InspectedFirestoreUserProfile>();
      if (docSnap.exists()) {
        nextMap.set(
          callerUser.uid,
          inspectFirestoreProfileSnapshot(
            callerUser.uid,
            docSnap.data() as Record<string, unknown>
          )
        );
      }
      onProfiles(nextMap);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, docPath);
      } catch (wrapped) {
        onError?.(
          wrapped instanceof Error
            ? wrapped.message
            : 'Firestore userProfile subscription error.'
        );
      }
    }
  );
}

export async function upsertFirestoreProfileAsPrincipalOwner(
  target: {
    uid: string;
    email: string;
    displayName: string;
    photoUrl: string;
    authProvider: string;
    emailVerified: boolean;
    role: 'owner' | 'admin' | 'member';
    accountStatus: 'active' | 'suspended';
  },
  callerUid: string,
  syncSource: 'repair_auth' | 'sync_auth' | 'admin_governance' = 'repair_auth',
  options?: { forceRecreate?: boolean }
): Promise<{
  action: 'created' | 'recreated' | 'updated' | 'skipped';
  profile: FirestoreUserProfileDoc | null;
}> {
  if (!isValidFirestoreProfileUid(target.uid)) {
    return { action: 'skipped', profile: null };
  }

  const isTargetCallerOwner = target.uid === callerUid;
  const resolvedRole: 'owner' | 'admin' | 'member' = isTargetCallerOwner
    ? 'owner'
    : target.role === 'admin'
      ? 'admin'
      : 'member';
  const resolvedIsOwner = resolvedRole === 'owner';
  const resolvedStatus: 'active' | 'suspended' = isTargetCallerOwner
    ? 'active'
    : target.accountStatus === 'suspended'
      ? 'suspended'
      : 'active';

  const nowIso = new Date().toISOString().slice(0, ISO_TIMESTAMP_MAX_LENGTH);
  const cleanPayload: FirestoreUserProfileDoc = {
    uid: target.uid,
    email: sanitizeEmail(target.email, target.uid),
    displayName: sanitizeBoundedString(target.displayName, DISPLAY_NAME_MAX_LENGTH),
    photoUrl: sanitizeBoundedString(target.photoUrl, PHOTO_URL_MAX_LENGTH),
    authProvider:
      sanitizeBoundedString(target.authProvider, AUTH_PROVIDER_MAX_LENGTH) || 'google.com',
    emailVerified: isTargetCallerOwner ? true : Boolean(target.emailVerified),
    role: resolvedRole,
    isOwner: resolvedIsOwner,
    accountStatus: resolvedStatus,
    syncSource,
    lastSyncedAtIso: nowIso,
  };

  const docPath = `userProfiles/${target.uid}`;
  const profileRef = doc(db, 'userProfiles', target.uid);

  let existingInspected: InspectedFirestoreUserProfile | null = null;
  try {
    const snap = await getDoc(profileRef);
    if (snap.exists()) {
      existingInspected = inspectFirestoreProfileSnapshot(
        target.uid,
        snap.data() as Record<string, unknown>
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, docPath);
  }

  const requiresCleanRecreate = Boolean(
    existingInspected &&
      (options?.forceRecreate ||
        existingInspected.uidMismatch ||
        existingInspected.missingTimestamps ||
        existingInspected.hasShadowFields)
  );

  if (!existingInspected) {
    try {
      await setDoc(profileRef, {
        ...cleanPayload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, docPath);
    }
    return { action: 'created', profile: cleanPayload };
  }

  if (requiresCleanRecreate) {
    try {
      await deleteDoc(profileRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, docPath);
    }
    try {
      await setDoc(profileRef, {
        ...cleanPayload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, docPath);
    }
    return { action: 'recreated', profile: cleanPayload };
  }

  try {
    await updateDoc(profileRef, {
      email: cleanPayload.email,
      displayName: cleanPayload.displayName,
      photoUrl: cleanPayload.photoUrl,
      authProvider: cleanPayload.authProvider,
      emailVerified: cleanPayload.emailVerified,
      role: cleanPayload.role,
      isOwner: cleanPayload.isOwner,
      accountStatus: cleanPayload.accountStatus,
      syncSource: cleanPayload.syncSource,
      lastSyncedAtIso: cleanPayload.lastSyncedAtIso,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, docPath);
  }

  return { action: 'updated', profile: cleanPayload };
}

export async function removeOrphanedFirestoreProfileAsPrincipalOwner(
  docId: string,
  callerUid: string
): Promise<boolean> {
  if (!isValidFirestoreProfileUid(docId) || docId === callerUid) {
    return false;
  }
  const docPath = `userProfiles/${docId}`;
  try {
    await deleteDoc(doc(db, 'userProfiles', docId));
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
    return false;
  }
}

export async function clearFirestoreLinkedAuthState(
  targetUid: string,
  callerUid: string,
  isVerifiedPrincipalCaller: boolean
): Promise<{
  cleared: boolean;
  mode: 'deleted_firestore_profile' | 'server_revocation_only';
}> {
  if (
    !isVerifiedPrincipalCaller ||
    !isValidFirestoreProfileUid(targetUid) ||
    targetUid === callerUid
  ) {
    return { cleared: false, mode: 'server_revocation_only' };
  }
  const deleted = await removeOrphanedFirestoreProfileAsPrincipalOwner(
    targetUid,
    callerUid
  );
  return {
    cleared: deleted,
    mode: deleted ? 'deleted_firestore_profile' : 'server_revocation_only',
  };
}
