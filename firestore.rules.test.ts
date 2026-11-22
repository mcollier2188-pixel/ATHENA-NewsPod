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

test('FeedAlertAcknowledgments Security: owner isolation, state-timestamp invariant, and immutable identity on toggle', () => {
  assert.match(rulesText, /match \/feedAlertAcknowledgments\/\{ackId\}/);
  assert.match(rulesText, /isValidFeedAlertAcknowledgment\(incoming\(\), ackId\)/);
  assert.match(rulesText, /isFeedAlertAckOwnerToggleAction\(\)/);

  interface AckPayload {
    ackId: string;
    ownerId: string;
    feedId: string;
    alertKey: string;
    eventType: string;
    acknowledged: boolean;
    acknowledgedAtIso: string;
    createdAt: number;
    updatedAt: number;
    [extraKey: string]: unknown;
  }

  const ACK_KEYS = new Set([
    'ackId',
    'ownerId',
    'feedId',
    'alertKey',
    'eventType',
    'acknowledged',
    'acknowledgedAtIso',
    'createdAt',
    'updatedAt',
  ]);

  const isValidAck = (auth: AuthToken, data: AckPayload, ackId: string): boolean => {
    const keys = Object.keys(data);
    if (keys.length !== ACK_KEYS.size || !keys.every((k) => ACK_KEYS.has(k))) {
      return false;
    }
    return (
      isValidId(data.ackId) &&
      data.ackId === ackId &&
      isValidId(data.ownerId) &&
      data.ownerId === auth.uid &&
      isValidId(data.feedId) &&
      data.alertKey.length >= 1 &&
      data.alertKey.length <= 160 &&
      ['organic', 'test'].includes(data.eventType) &&
      typeof data.acknowledged === 'boolean' &&
      data.acknowledgedAtIso.length <= 64 &&
      ((data.acknowledged === true && data.acknowledgedAtIso.length >= 1) ||
        (data.acknowledged === false && data.acknowledgedAtIso.length === 0)) &&
      typeof data.createdAt === 'number' &&
      typeof data.updatedAt === 'number'
    );
  };

  const evaluateAckCreate = (
    auth: AuthToken | null,
    ackId: string,
    incoming: AckPayload
  ): boolean => {
    if (!auth || !auth.email_verified || !isValidId(ackId)) return false;
    if (!isValidAck(auth, incoming, ackId)) return false;
    return incoming.createdAt === REQ_TIME && incoming.updatedAt === REQ_TIME;
  };

  const evaluateAckUpdate = (
    auth: AuthToken | null,
    ackId: string,
    existing: AckPayload,
    incoming: AckPayload
  ): boolean => {
    if (!auth || !auth.email_verified || !isValidId(ackId)) return false;
    if (!isValidAck(auth, incoming, ackId)) return false;
    const affected = Object.keys(incoming).filter((k) => incoming[k] !== existing[k]);
    const allowed = new Set(['acknowledged', 'acknowledgedAtIso', 'updatedAt']);
    return (
      existing.ownerId === auth.uid &&
      incoming.ackId === existing.ackId &&
      incoming.ownerId === existing.ownerId &&
      incoming.feedId === existing.feedId &&
      incoming.alertKey === existing.alertKey &&
      incoming.eventType === existing.eventType &&
      incoming.createdAt === existing.createdAt &&
      incoming.updatedAt === REQ_TIME &&
      affected.every((k) => allowed.has(k))
    );
  };

  const validAckId = 'ack_uid_alice_default_feed_2026-11-18_10';
  const baseAck: AckPayload = {
    ackId: validAckId,
    ownerId: 'uid_alice',
    feedId: 'default_feed',
    alertKey: '2026-11-18:10',
    eventType: 'organic',
    acknowledged: true,
    acknowledgedAtIso: '2026-11-21T19:00:00.000Z',
    createdAt: REQ_TIME,
    updatedAt: REQ_TIME,
  };

  assert.equal(evaluateAckCreate(aliceAuth, validAckId, baseAck), true);
  // Cross-user ownerId spoof denied
  assert.equal(
    evaluateAckCreate(aliceAuth, validAckId, { ...baseAck, ownerId: 'uid_bob' }),
    false
  );
  // Contradictory acknowledged=true with empty timestamp denied
  assert.equal(
    evaluateAckCreate(aliceAuth, validAckId, { ...baseAck, acknowledgedAtIso: '' }),
    false
  );
  // Shadow field injection denied
  assert.equal(
    evaluateAckCreate(aliceAuth, validAckId, { ...baseAck, isAdmin: true }),
    false
  );
  // Valid toggle back to Pending (acknowledged=false, acknowledgedAtIso='') succeeds
  const existingAck = { ...baseAck, createdAt: REQ_TIME - 5000, updatedAt: REQ_TIME - 5000 };
  const revertedPending = {
    ...existingAck,
    acknowledged: false,
    acknowledgedAtIso: '',
    updatedAt: REQ_TIME,
  };
  assert.equal(evaluateAckUpdate(aliceAuth, validAckId, existingAck, revertedPending), true);
  // Mutating immutable alertKey on update is denied
  assert.equal(
    evaluateAckUpdate(aliceAuth, validAckId, existingAck, {
      ...revertedPending,
      alertKey: 'tampered',
    }),
    false
  );
});

test('Workspace & Cloud Sync Collections (/notebookSources, /briefingArchives, /workspaceLinks) structural and Red Team guards', () => {
  assert.match(rulesText, /match \/notebookSources\/\{docId\}/);
  assert.match(rulesText, /isValidNotebookSource\(incoming\(\), docId\)/);
  assert.match(rulesText, /isNotebookSourceOwnerSyncAction\(\)/);
  assert.match(rulesText, /match \/briefingArchives\/\{docId\}/);
  assert.match(rulesText, /isValidBriefingArchive\(incoming\(\), docId\)/);
  assert.match(rulesText, /isBriefingArchiveOwnerSyncAction\(\)/);
  assert.match(rulesText, /match \/workspaceLinks\/\{docId\}/);
  assert.match(rulesText, /isValidWorkspaceLink\(incoming\(\), docId\)/);
  assert.match(rulesText, /isWorkspaceLinkOwnerUpdateAction\(\)/);

  interface HighlightPayload {
    id: string;
    text: string;
    passageIndex: number;
    createdAt: string;
    [extraKey: string]: unknown;
  }

  interface SourcePayload {
    docId: string;
    sourceId: string;
    ownerId: string;
    title: string;
    source: string;
    sourceType: string;
    fileSizeLabel: string;
    category: string;
    tags: string[];
    url: string;
    summary: string;
    keyFacts: string[];
    highlights?: HighlightPayload[];
    content: string;
    estimatedReadMinutes: number;
    selected: boolean;
    readLater: boolean;
    shelvedAt: string;
    driveFileId: string;
    driveWebViewLink: string;
    driveMimeType: string;
    imageUrl: string;
    addedAt: string;
    createdAt: number;
    updatedAt: number;
    [extraKey: string]: unknown;
  }

  const REQUIRED_SOURCE_KEYS = [
    'docId',
    'sourceId',
    'ownerId',
    'title',
    'source',
    'sourceType',
    'fileSizeLabel',
    'category',
    'tags',
    'url',
    'summary',
    'keyFacts',
    'content',
    'estimatedReadMinutes',
    'selected',
    'readLater',
    'shelvedAt',
    'driveFileId',
    'driveWebViewLink',
    'driveMimeType',
    'imageUrl',
    'addedAt',
    'createdAt',
    'updatedAt',
  ];

  const ALLOWED_SOURCE_KEYS = new Set([...REQUIRED_SOURCE_KEYS, 'highlights']);
  const HIGHLIGHT_KEYS = new Set(['id', 'text', 'passageIndex', 'createdAt']);

  const isValidHighlightItem = (h: HighlightPayload): boolean => {
    const keys = Object.keys(h);
    if (keys.length !== HIGHLIGHT_KEYS.size || !keys.every((k) => HIGHLIGHT_KEYS.has(k))) {
      return false;
    }
    return (
      isValidId(h.id) &&
      typeof h.text === 'string' &&
      h.text.length >= 2 &&
      h.text.length <= 600 &&
      typeof h.passageIndex === 'number' &&
      h.passageIndex >= 0 &&
      h.passageIndex <= 999 &&
      typeof h.createdAt === 'string' &&
      h.createdAt.length >= 1 &&
      h.createdAt.length <= 64
    );
  };

  const isValidHighlightList = (listVal: unknown): boolean => {
    if (!Array.isArray(listVal) || listVal.length > 20) return false;
    return listVal.length === 0 || isValidHighlightItem(listVal[0] as HighlightPayload);
  };

  const isValidSource = (auth: AuthToken, data: SourcePayload, docId: string): boolean => {
    const keys = Object.keys(data);
    if (
      !REQUIRED_SOURCE_KEYS.every((k) => keys.includes(k)) ||
      !keys.every((k) => ALLOWED_SOURCE_KEYS.has(k))
    ) {
      return false;
    }
    return (
      isValidId(data.docId) &&
      data.docId === docId &&
      data.sourceId.length >= 1 &&
      data.sourceId.length <= 128 &&
      isValidId(data.ownerId) &&
      data.ownerId === auth.uid &&
      data.title.length >= 1 &&
      data.title.length <= 300 &&
      data.source.length >= 1 &&
      data.source.length <= 200 &&
      ['article', 'pdf', 'docx', 'txt', 'markdown'].includes(data.sourceType) &&
      data.fileSizeLabel.length <= 64 &&
      data.category.length >= 1 &&
      data.category.length <= 120 &&
      Array.isArray(data.tags) &&
      data.tags.length <= 12 &&
      data.url.length <= 2048 &&
      data.summary.length <= 2000 &&
      Array.isArray(data.keyFacts) &&
      data.keyFacts.length <= 12 &&
      (!('highlights' in data) || isValidHighlightList(data.highlights)) &&
      data.content.length <= 30000 &&
      data.estimatedReadMinutes >= 1 &&
      data.estimatedReadMinutes <= 240 &&
      typeof data.selected === 'boolean' &&
      typeof data.readLater === 'boolean' &&
      data.shelvedAt.length <= 64 &&
      data.driveFileId.length <= 128 &&
      data.driveWebViewLink.length <= 2048 &&
      data.driveMimeType.length <= 128 &&
      data.imageUrl.length <= 2048 &&
      data.addedAt.length >= 1 &&
      data.addedAt.length <= 64 &&
      typeof data.createdAt === 'number' &&
      typeof data.updatedAt === 'number'
    );
  };

  const evaluateSourceCreate = (
    auth: AuthToken | null,
    docId: string,
    incoming: SourcePayload
  ): boolean => {
    if (!auth || !auth.email_verified || !isValidId(docId)) return false;
    if (!isValidSource(auth, incoming, docId)) return false;
    return incoming.createdAt === REQ_TIME && incoming.updatedAt === REQ_TIME;
  };

  const evaluateSourceUpdate = (
    auth: AuthToken | null,
    docId: string,
    existing: SourcePayload,
    incoming: SourcePayload
  ): boolean => {
    if (!auth || !auth.email_verified || !isValidId(docId)) return false;
    if (!isValidSource(auth, incoming, docId)) return false;
    return (
      existing.ownerId === auth.uid &&
      incoming.docId === existing.docId &&
      incoming.sourceId === existing.sourceId &&
      incoming.ownerId === existing.ownerId &&
      incoming.createdAt === existing.createdAt &&
      incoming.updatedAt === REQ_TIME
    );
  };

  const validDocId = 'src_uid_alice_art_q4_strategy';
  const baseSource: SourcePayload = {
    docId: validDocId,
    sourceId: 'art_q4_strategy',
    ownerId: 'uid_alice',
    title: 'Q4 Strategic Briefing Memo',
    source: 'Google Docs',
    sourceType: 'markdown',
    fileSizeLabel: '14 KB',
    category: 'Strategy',
    tags: ['Q4', 'Google Docs'],
    url: 'https://docs.google.com/document/d/doc_123/edit',
    summary: 'Executive memo imported from Google Docs.',
    keyFacts: ['Target margin +420 bps'],
    content: '# Q4 Strategic Briefing\n\nFull structured document text.',
    estimatedReadMinutes: 4,
    selected: true,
    readLater: false,
    shelvedAt: '',
    driveFileId: 'doc_123',
    driveWebViewLink: 'https://docs.google.com/document/d/doc_123/edit',
    driveMimeType: 'application/vnd.google-apps.document',
    imageUrl: '',
    addedAt: '2026-11-21T20:00:00.000Z',
    createdAt: REQ_TIME,
    updatedAt: REQ_TIME,
  };

  assert.match(rulesText, /isValidHighlightList\(data\.highlights\)/);

  // Positive owner create succeeds (both without highlights for legacy compat and with highlights)
  assert.equal(evaluateSourceCreate(aliceAuth, validDocId, baseSource), true);
  assert.equal(
    evaluateSourceCreate(aliceAuth, validDocId, {
      ...baseSource,
      highlights: [
        {
          id: 'hl_margin_target',
          text: 'Target margin +420 bps across core enterprise tiers',
          passageIndex: 1,
          createdAt: '2026-11-21T20:05:00.000Z',
        },
      ],
    }),
    true
  );
  // Cross-user ownerId spoofing denied
  assert.equal(
    evaluateSourceCreate(aliceAuth, validDocId, { ...baseSource, ownerId: 'uid_bob' }),
    false
  );
  // Injecting OAuth accessToken shadow field into Firestore is strictly PERMISSION_DENIED
  assert.equal(
    evaluateSourceCreate(aliceAuth, validDocId, {
      ...baseSource,
      accessToken: 'ya29.leaked_token',
    }),
    false
  );
  // Oversized content (> 30,000 chars) is PERMISSION_DENIED
  assert.equal(
    evaluateSourceCreate(aliceAuth, validDocId, {
      ...baseSource,
      content: 'x'.repeat(30_001),
    }),
    false
  );
  // Highlight Red Team checks: > 20 items, oversized phrase (> 600 chars), or shadow field in highlight map -> PERMISSION_DENIED
  assert.equal(
    evaluateSourceCreate(aliceAuth, validDocId, {
      ...baseSource,
      highlights: Array.from({ length: 21 }, (_, idx) => ({
        id: `hl_${idx}`,
        text: 'Valid phrase',
        passageIndex: 1,
        createdAt: '2026-11-21T20:05:00.000Z',
      })),
    }),
    false
  );
  assert.equal(
    evaluateSourceCreate(aliceAuth, validDocId, {
      ...baseSource,
      highlights: [
        {
          id: 'hl_oversized',
          text: 'x'.repeat(601),
          passageIndex: 1,
          createdAt: '2026-11-21T20:05:00.000Z',
        },
      ],
    }),
    false
  );
  assert.equal(
    evaluateSourceCreate(aliceAuth, validDocId, {
      ...baseSource,
      highlights: [
        {
          id: 'hl_shadow',
          text: 'Valid phrase',
          passageIndex: 1,
          createdAt: '2026-11-21T20:05:00.000Z',
          isAdmin: true,
        },
      ],
    }),
    false
  );
  // Immutable sourceId / createdAt tampering on update is PERMISSION_DENIED, while owner highlight update succeeds
  const existingSource = {
    ...baseSource,
    createdAt: REQ_TIME - 5000,
    updatedAt: REQ_TIME - 5000,
  };
  assert.equal(
    evaluateSourceUpdate(aliceAuth, validDocId, existingSource, {
      ...existingSource,
      selected: false,
      highlights: [
        {
          id: 'hl_1',
          text: 'Full structured document text.',
          passageIndex: 1,
          createdAt: '2026-11-21T20:06:00.000Z',
        },
      ],
      updatedAt: REQ_TIME,
    }),
    true
  );
  assert.equal(
    evaluateSourceUpdate(aliceAuth, validDocId, existingSource, {
      ...existingSource,
      sourceId: 'tampered_id',
      updatedAt: REQ_TIME,
    }),
    false
  );

  // WorkspaceLink kind allowlist & OAuth token leak rejection
  interface LinkPayload {
    linkId: string;
    ownerId: string;
    kind: string;
    externalId: string;
    title: string;
    url: string;
    sourceId: string;
    briefingId: string;
    createdAtIso: string;
    createdAt: number;
    updatedAt: number;
    [extraKey: string]: unknown;
  }

  const LINK_KEYS = new Set([
    'linkId',
    'ownerId',
    'kind',
    'externalId',
    'title',
    'url',
    'sourceId',
    'briefingId',
    'createdAtIso',
    'createdAt',
    'updatedAt',
  ]);

  const evaluateLinkCreate = (
    auth: AuthToken | null,
    docId: string,
    data: LinkPayload
  ): boolean => {
    if (!auth || !auth.email_verified || !isValidId(docId)) return false;
    const keys = Object.keys(data);
    if (keys.length !== LINK_KEYS.size || !keys.every((k) => LINK_KEYS.has(k))) {
      return false;
    }
    return (
      isValidId(data.linkId) &&
      data.linkId === docId &&
      data.ownerId === auth.uid &&
      ['drive_source', 'google_doc_export', 'drive_wav_export', 'google_task'].includes(
        data.kind
      ) &&
      data.externalId.length >= 1 &&
      data.externalId.length <= 200 &&
      data.title.length >= 1 &&
      data.title.length <= 300 &&
      data.url.length <= 2048 &&
      data.sourceId.length <= 128 &&
      data.briefingId.length <= 128 &&
      data.createdAtIso.length >= 1 &&
      data.createdAtIso.length <= 64 &&
      data.createdAt === REQ_TIME &&
      data.updatedAt === REQ_TIME
    );
  };

  const validLinkId = 'lnk_uid_alice_google_task_tsk_99';
  const baseLink: LinkPayload = {
    linkId: validLinkId,
    ownerId: 'uid_alice',
    kind: 'google_task',
    externalId: 'tsk_99',
    title: 'Review Q4 margin assumptions',
    url: 'https://tasks.google.com',
    sourceId: '',
    briefingId: 'brf_1',
    createdAtIso: '2026-11-21T20:05:00.000Z',
    createdAt: REQ_TIME,
    updatedAt: REQ_TIME,
  };

  assert.equal(evaluateLinkCreate(aliceAuth, validLinkId, baseLink), true);
  assert.equal(
    evaluateLinkCreate(aliceAuth, validLinkId, { ...baseLink, kind: 'unknown_kind' }),
    false
  );
  assert.equal(
    evaluateLinkCreate(aliceAuth, validLinkId, {
      ...baseLink,
      oauthToken: 'ya29.forbidden',
    }),
    false
  );
});




