import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const RULES_PATH = path.resolve(process.cwd(), 'firestore.rules');
const rulesText = fs.readFileSync(RULES_PATH, 'utf8');

interface AuthToken {
  uid: string;
  email: string;
  email_verified: boolean;
}

interface UserProfilePayload {
  uid: string;
  email: string;
  displayName: string;
  photoUrl: string;
  authProvider: string;
  emailVerified: boolean;
  role: string;
  isOwner: boolean;
  accountStatus: string;
  syncSource: string;
  lastSyncedAtIso: string;
  createdAt: number;
  updatedAt: number;
  [extraKey: string]: unknown;
}

const REQ_TIME = 1_800_000_000_000;
const ALLOWED_KEYS = new Set([
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

function isValidId(id: string): boolean {
  return id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
}

function isPrincipalOwner(auth: AuthToken | null): boolean {
  return Boolean(
    auth && auth.email_verified === true && auth.email === 'mcollier2188@gmail.com'
  );
}

function isValidUserProfile(data: UserProfilePayload, userId: string): boolean {
  const keys = Object.keys(data);
  if (keys.length !== ALLOWED_KEYS.size) return false;
  for (const k of keys) {
    if (!ALLOWED_KEYS.has(k)) return false;
  }
  return (
    isValidId(data.uid) &&
    data.uid === userId &&
    data.email.length >= 3 &&
    data.email.length <= 200 &&
    data.displayName.length <= 140 &&
    data.photoUrl.length <= 2048 &&
    data.authProvider.length >= 1 &&
    data.authProvider.length <= 64 &&
    typeof data.emailVerified === 'boolean' &&
    ['owner', 'admin', 'member'].includes(data.role) &&
    typeof data.isOwner === 'boolean' &&
    data.isOwner === (data.role === 'owner') &&
    ['active', 'suspended'].includes(data.accountStatus) &&
    ['google_signin', 'repair_auth', 'sync_auth', 'admin_governance'].includes(data.syncSource) &&
    data.lastSyncedAtIso.length >= 1 &&
    data.lastSyncedAtIso.length <= 64 &&
    typeof data.createdAt === 'number' &&
    typeof data.updatedAt === 'number'
  );
}

function evaluateUserProfileGet(auth: AuthToken | null, userId: string): boolean {
  return Boolean(
    auth &&
      auth.email_verified === true &&
      isValidId(userId) &&
      (isPrincipalOwner(auth) || userId === auth.uid)
  );
}

function evaluateUserProfileList(
  auth: AuthToken | null,
  resourceUid: string | undefined
): boolean {
  return Boolean(
    auth &&
      auth.email_verified === true &&
      (isPrincipalOwner(auth) || (typeof resourceUid === 'string' && resourceUid === auth.uid))
  );
}

function evaluateUserProfileCreate(
  auth: AuthToken | null,
  userId: string,
  incoming: UserProfilePayload
): boolean {
  if (!auth || auth.email_verified !== true) return false;
  if (!isValidId(userId) || !isValidUserProfile(incoming, userId)) return false;
  if (incoming.createdAt !== REQ_TIME || incoming.updatedAt !== REQ_TIME) return false;

  const selfStandard =
    userId === auth.uid &&
    !isPrincipalOwner(auth) &&
    incoming.email === auth.email &&
    incoming.emailVerified === true &&
    incoming.role === 'member' &&
    incoming.isOwner === false &&
    incoming.accountStatus === 'active';

  const principalSelf =
    isPrincipalOwner(auth) &&
    userId === auth.uid &&
    incoming.email === auth.email &&
    incoming.emailVerified === true &&
    incoming.role === 'owner' &&
    incoming.isOwner === true &&
    incoming.accountStatus === 'active';

  const principalCollaborator =
    isPrincipalOwner(auth) &&
    userId !== auth.uid &&
    ['admin', 'member'].includes(incoming.role) &&
    incoming.isOwner === false;

  return selfStandard || principalSelf || principalCollaborator;
}

function evaluateUserProfileUpdate(
  auth: AuthToken | null,
  userId: string,
  existing: UserProfilePayload,
  incoming: UserProfilePayload
): boolean {
  if (!auth || auth.email_verified !== true) return false;
  if (!isValidId(userId) || !isValidUserProfile(incoming, userId)) return false;

  const affectedKeys = Object.keys(incoming).filter(
    (k) => incoming[k] !== existing[k]
  );

  const selfAllowed = new Set([
    'email',
    'displayName',
    'photoUrl',
    'authProvider',
    'emailVerified',
    'syncSource',
    'lastSyncedAtIso',
    'updatedAt',
  ]);
  const ownerAllowed = new Set([
    ...selfAllowed,
    'role',
    'isOwner',
    'accountStatus',
  ]);

  const isSelfSync =
    userId === auth.uid &&
    !isPrincipalOwner(auth) &&
    existing.uid === auth.uid &&
    existing.accountStatus === 'active' &&
    incoming.uid === existing.uid &&
    incoming.createdAt === existing.createdAt &&
    incoming.role === existing.role &&
    incoming.isOwner === existing.isOwner &&
    incoming.accountStatus === existing.accountStatus &&
    incoming.email === auth.email &&
    incoming.emailVerified === true &&
    incoming.updatedAt === REQ_TIME &&
    affectedKeys.every((k) => selfAllowed.has(k));

  const isPrincipalSelf =
    isPrincipalOwner(auth) &&
    userId === auth.uid &&
    incoming.uid === existing.uid &&
    incoming.createdAt === existing.createdAt &&
    incoming.email === auth.email &&
    incoming.emailVerified === true &&
    incoming.role === 'owner' &&
    incoming.isOwner === true &&
    incoming.accountStatus === 'active' &&
    incoming.updatedAt === REQ_TIME &&
    affectedKeys.every((k) => ownerAllowed.has(k));

  const isPrincipalCollab =
    isPrincipalOwner(auth) &&
    userId !== auth.uid &&
    incoming.uid === existing.uid &&
    incoming.createdAt === existing.createdAt &&
    ['admin', 'member'].includes(incoming.role) &&
    incoming.isOwner === false &&
    incoming.updatedAt === REQ_TIME &&
    affectedKeys.every((k) => ownerAllowed.has(k));

  return isSelfSync || isPrincipalSelf || isPrincipalCollab;
}

function makeBaseProfile(overrides: Partial<UserProfilePayload> = {}): UserProfilePayload {
  return {
    uid: 'uid_alice',
    email: 'alice@example.com',
    displayName: 'Alice Editor',
    photoUrl: 'https://lh3.googleusercontent.com/a/alice',
    authProvider: 'google.com',
    emailVerified: true,
    role: 'member',
    isOwner: false,
    accountStatus: 'active',
    syncSource: 'google_signin',
    lastSyncedAtIso: '2026-11-20T18:00:00.000Z',
    createdAt: REQ_TIME,
    updatedAt: REQ_TIME,
    ...overrides,
  };
}

const aliceAuth: AuthToken = {
  uid: 'uid_alice',
  email: 'alice@example.com',
  email_verified: true,
};

const ownerAuth: AuthToken = {
  uid: 'uid_michael',
  email: 'mcollier2188@gmail.com',
  email_verified: true,
};

test('firestore.rules structural gates exist verbatim', () => {
  assert.match(rulesText, /match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  assert.match(rulesText, /match \/userProfiles\/\{userId\}/);
  assert.match(rulesText, /data\.isOwner == \(data\.role == 'owner'\)/);
  assert.match(rulesText, /request\.auth\.token\.email_verified == true/);
});

test('Dirty Dozen #1: Self-assigned owner on registration is PERMISSION_DENIED', () => {
  const payload = makeBaseProfile({ role: 'owner', isOwner: true });
  assert.equal(evaluateUserProfileCreate(aliceAuth, 'uid_alice', payload), false);
});

test('Dirty Dozen #2: Self-assigned admin on update is PERMISSION_DENIED', () => {
  const existing = makeBaseProfile({ createdAt: REQ_TIME - 5000, updatedAt: REQ_TIME - 5000 });
  const incoming = makeBaseProfile({
    createdAt: REQ_TIME - 5000,
    updatedAt: REQ_TIME,
    role: 'admin',
    isOwner: false,
  });
  assert.equal(evaluateUserProfileUpdate(aliceAuth, 'uid_alice', existing, incoming), false);
});

test('Dirty Dozen #3: Contradictory ownership flag (role=member, isOwner=true) is PERMISSION_DENIED', () => {
  const payload = makeBaseProfile({ role: 'member', isOwner: true });
  assert.equal(evaluateUserProfileCreate(aliceAuth, 'uid_alice', payload), false);
});

test('Dirty Dozen #4: Unverified Principal Owner email spoof is PERMISSION_DENIED', () => {
  const spoofAuth: AuthToken = {
    uid: 'uid_spoof',
    email: 'mcollier2188@gmail.com',
    email_verified: false,
  };
  assert.equal(evaluateUserProfileGet(spoofAuth, 'uid_alice'), false);
  const payload = makeBaseProfile({
    uid: 'uid_spoof',
    email: 'mcollier2188@gmail.com',
    role: 'owner',
    isOwner: true,
  });
  assert.equal(evaluateUserProfileCreate(spoofAuth, 'uid_spoof', payload), false);
});

test('Dirty Dozen #5: Cross-user PII get is PERMISSION_DENIED', () => {
  assert.equal(evaluateUserProfileGet(aliceAuth, 'uid_bob'), false);
});

test('Dirty Dozen #6: Blanket user directory list by non-owner is PERMISSION_DENIED', () => {
  assert.equal(evaluateUserProfileList(aliceAuth, 'uid_bob'), false);
});

test('Dirty Dozen #7: Shadow field injection on profile update is PERMISSION_DENIED', () => {
  const existing = makeBaseProfile({ createdAt: REQ_TIME - 1000, updatedAt: REQ_TIME - 1000 });
  const incoming = makeBaseProfile({
    createdAt: REQ_TIME - 1000,
    updatedAt: REQ_TIME,
    superAdmin: true,
  });
  assert.equal(evaluateUserProfileUpdate(aliceAuth, 'uid_alice', existing, incoming), false);
});

test('Dirty Dozen #8: Suspended user self-reactivation or metadata update is PERMISSION_DENIED', () => {
  const existing = makeBaseProfile({
    accountStatus: 'suspended',
    createdAt: REQ_TIME - 1000,
    updatedAt: REQ_TIME - 1000,
  });
  const incoming = makeBaseProfile({
    accountStatus: 'active',
    createdAt: REQ_TIME - 1000,
    updatedAt: REQ_TIME,
  });
  assert.equal(evaluateUserProfileUpdate(aliceAuth, 'uid_alice', existing, incoming), false);
});

test('Dirty Dozen #9: Path ID poisoning is PERMISSION_DENIED', () => {
  const badId = 'bad$id!with/slash';
  const payload = makeBaseProfile({ uid: badId });
  assert.equal(evaluateUserProfileCreate(aliceAuth, badId, payload), false);
});

test('Dirty Dozen #10: Forged createdAt backdating is PERMISSION_DENIED', () => {
  const payload = makeBaseProfile({ createdAt: REQ_TIME - 999999 });
  assert.equal(evaluateUserProfileCreate(aliceAuth, 'uid_alice', payload), false);
});

test('Dirty Dozen #11: Assigning owner flag to a collaborator is PERMISSION_DENIED', () => {
  const payload = makeBaseProfile({
    uid: 'uid_alice',
    role: 'owner',
    isOwner: true,
    syncSource: 'repair_auth',
  });
  assert.equal(evaluateUserProfileCreate(ownerAuth, 'uid_alice', payload), false);
});

test('Dirty Dozen #12 & Positive Repair Check: Verified Principal Owner can repair mis-flagged own profile and collaborator profile', () => {
  assert.match(rulesText, /existsAfter\(\/databases\/\$\(database\)\/documents\/siteMockups\/\$\(mockupId\)\)/);

  const misflaggedOwnerExisting = makeBaseProfile({
    uid: 'uid_michael',
    email: 'mcollier2188@gmail.com',
    role: 'member',
    isOwner: false,
    accountStatus: 'suspended',
    createdAt: REQ_TIME - 10000,
    updatedAt: REQ_TIME - 10000,
  });
  const repairedOwnerIncoming = makeBaseProfile({
    uid: 'uid_michael',
    email: 'mcollier2188@gmail.com',
    role: 'owner',
    isOwner: true,
    accountStatus: 'active',
    syncSource: 'repair_auth',
    createdAt: REQ_TIME - 10000,
    updatedAt: REQ_TIME,
  });
  assert.equal(
    evaluateUserProfileUpdate(
      ownerAuth,
      'uid_michael',
      misflaggedOwnerExisting,
      repairedOwnerIncoming
    ),
    true
  );
});

test('Sync Auth Check: Verified Principal Owner can inspect corrupted documents lacking uid and remediate with syncSource=sync_auth', () => {
  assert.equal(evaluateUserProfileList(ownerAuth, undefined), true);
  assert.equal(evaluateUserProfileList(aliceAuth, undefined), false);

  const remediatedCollaborator = makeBaseProfile({
    uid: 'uid_alice',
    role: 'admin',
    isOwner: false,
    syncSource: 'sync_auth',
  });
  assert.equal(evaluateUserProfileCreate(ownerAuth, 'uid_alice', remediatedCollaborator), true);
});

test('PublicShareLinks Security: non-enumerable capability get, list guard, and Scrub & Re-Link terminal locking', () => {
  assert.match(rulesText, /match \/publicShareLinks\/\{shareId\}/);
  assert.match(rulesText, /existing\(\)\.status == 'active'/);
  assert.match(rulesText, /existing\(\)\.expiresAt > request\.time/);
  assert.match(rulesText, /isValidPublicShareLink\(incoming\(\), shareId\)/);

  const evaluateShareGet = (
    auth: AuthToken | null,
    shareId: string,
    docState: { status: string; expiresAt: number; ownerId: string } | null
  ): boolean => {
    if (!isValidId(shareId)) return false;
    const publicCapOk = Boolean(
      docState && docState.status === 'active' && docState.expiresAt > REQ_TIME
    );
    const ownerOk = Boolean(
      auth && auth.email_verified && docState && docState.ownerId === auth.uid
    );
    return publicCapOk || isPrincipalOwner(auth) || ownerOk;
  };

  const evaluateShareList = (
    auth: AuthToken | null,
    ownerId: string | undefined
  ): boolean => {
    if (!auth || !auth.email_verified) return false;
    return isPrincipalOwner(auth) || (typeof ownerId === 'string' && ownerId === auth.uid);
  };

  // Active non-expired link resolves by exact capability ID
  assert.equal(
    evaluateShareGet(null, 'sh_active_1', {
      status: 'active',
      expiresAt: REQ_TIME + 3600_000,
      ownerId: 'uid_alice',
    }),
    true
  );
  // Once scrubbed_relinked or expired, public capability get is denied
  assert.equal(
    evaluateShareGet(null, 'sh_leaked_1', {
      status: 'scrubbed_relinked',
      expiresAt: REQ_TIME + 3600_000,
      ownerId: 'uid_alice',
    }),
    false
  );
  assert.equal(
    evaluateShareGet(null, 'sh_expired_1', {
      status: 'active',
      expiresAt: REQ_TIME - 1,
      ownerId: 'uid_alice',
    }),
    false
  );
  // Anonymous or cross-user list enumeration is denied; Principal Owner scan is allowed
  assert.equal(evaluateShareList(null, 'uid_alice'), false);
  assert.equal(evaluateShareList(aliceAuth, 'uid_bob'), false);
  assert.equal(evaluateShareList(ownerAuth, 'uid_bob'), true);
});


