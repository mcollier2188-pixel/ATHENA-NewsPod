# Firestore Security Specification — Dispatch Studio, Repair Auth & Sync Auth

## 1. Data Invariants
1. **Default-Deny Global Gate**: All paths outside `/userProfiles/{userId}`, `/siteMockups/{mockupId}`, `/siteMockups/{mockupId}/mediaAssets/{assetId}`, `/publicShareLinks/{shareId}`, and `/feedAlertAcknowledgments/{ackId}` are unconditionally denied.
2. **Verified Principal Identity & Studio Admin Lookup**: Only a caller with `request.auth != null`, `request.auth.token.email_verified == true`, and `request.auth.token.email == 'mcollier2188@gmail.com'` satisfies `isPrincipalOwner()`. Single-document admin governance checks (`isVerifiedStudioAdmin()`) verify an active `/userProfiles/$(request.auth.uid)` record with `role == 'admin'` and are never placed inside `allow list`.
3. **PII Isolation & Corrupted-Link Inspection on `/userProfiles/{userId}`**: User profiles contain PII (`email`, `displayName`, `photoUrl`). Single-document `get` and `list` queries are strictly restricted to `isPrincipalOwner()` or `'uid' in resource.data && resource.data.uid == request.auth.uid`. Blanket `isSignedIn()` reads are forbidden.
4. **Privilege Escalation & Self-Assigned Role Prevention**:
   - Standard verified users creating `/userProfiles/{uid}` must set `role == 'member'`, `isOwner == false`, and `accountStatus == 'active'`.
   - Standard verified users updating `/userProfiles/{uid}` cannot modify `role`, `isOwner`, or `accountStatus`, and suspended users (`existing().accountStatus == 'suspended'`) cannot update their profile.
   - `isOwner` must always equal `(role == 'owner')`, `syncSource` must be one of `['google_signin', 'repair_auth', 'sync_auth', 'admin_governance']`, and no collaborator document (`userId != request.auth.uid` when written by Principal Owner) can ever be assigned `role == 'owner'` or `isOwner == true`.
5. **Temporal & Structural Integrity**: Every `create` requires `createdAt == request.time && updatedAt == request.time`; every `update` preserves `createdAt == existing().createdAt`, sets `updatedAt == request.time`, and restricts modified keys via `affectedKeys().hasOnly(...)`. Corrupted or orphaned documents can be remediated by `isPrincipalOwner()` via `delete` + `create`.
6. **Master Gate on `/siteMockups/{mockupId}/mediaAssets/{assetId}`**: Subcollection operations verify parent `/siteMockups/{mockupId}` ownership via `exists()`/`get()` (or `existsAfter()`/`getAfter()` on batch creation).
7. **Capability-Scoped Public Share Links & Scrub / Re-Link Containment (`/publicShareLinks/{shareId}`)**:
   - Public `get` requires a valid capability ID (`isValidId(shareId)`), `existing().status == 'active'`, and `existing().expiresAt > request.time`. Revoked, expired, or `scrubbed_relinked` links immediately reject public reads.
   - Collection `list` is strictly restricted to `isVerifiedUser() && (isPrincipalOwner() || ('ownerId' in existing() && existing().ownerId == request.auth.uid))` with zero `get()`/`exists()` calls, preventing public enumeration while empowering the Owner Console PII Scanner.
   - Terminal states (`status in ['revoked', 'scrubbed_relinked']`) lock out non-admin updates while permitting Principal Owner / Verified Studio Admin Scrub & Re-Link remediation and deletion.
8. **Owner-Scoped Feed Alert Acknowledgments (`/feedAlertAcknowledgments/{ackId}`)**:
   - Strict schema validation (`isValidFeedAlertAcknowledgment(incoming(), ackId)`) enforces exact `hasAll` / `hasOnly` keys, `ackId == docId`, `ownerId == request.auth.uid`, `eventType in ['organic', 'test']`, bounded `alertKey` (`1..160`), and state-timestamp consistency (`acknowledged == true` requires non-empty `acknowledgedAtIso`; `acknowledged == false` requires `acknowledgedAtIso == ''`).
   - `list` queries enforce `'ownerId' in existing() && existing().ownerId == request.auth.uid` (or `isPrincipalOwner()`) with zero `get()`/`exists()` calls; `update` locks `ackId`, `ownerId`, `feedId`, `alertKey`, `eventType`, and `createdAt`, allowing only `['acknowledged', 'acknowledgedAtIso', 'updatedAt']` to mutate with `updatedAt == request.time`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must Return `PERMISSION_DENIED`)
1. **Self-Assigned Owner on Registration**: Standard user (`alice@example.com`, `email_verified: true`) creates `/userProfiles/uid_alice` with `role: "owner", isOwner: true`.
2. **Self-Assigned Admin on Update**: Standard user updates `/userProfiles/uid_alice` changing `role` from `"member"` to `"admin"`.
3. **Contradictory Ownership Flag**: Payload sets `role: "member"` paired with `isOwner: true` on `/userProfiles/uid_alice`.
4. **Unverified Principal Email Spoof**: Attacker with `email: "mcollier2188@gmail.com"` and `email_verified: false` attempts to read `/userProfiles/uid_victim`, list `/publicShareLinks`, or write `/feedAlertAcknowledgments`.
5. **Cross-User PII or Alert Acknowledgment Scrape (`get` / `create`)**: Authenticated user `uid_alice` attempts `get(/userProfiles/uid_bob)` or creates `/feedAlertAcknowledgments/ack_bob_1` with `ownerId: "uid_bob"`.
6. **Blanket User, Share, or Alert Ack Directory Scrape (`list`)**: Unauthenticated caller or non-owner `uid_alice` attempts unfiltered `list(/userProfiles)`, `list(/publicShareLinks)`, or `list(/feedAlertAcknowledgments)` where `ownerId != uid_alice`.
7. **Shadow Field Injection on Profile, Share, or Alert Ack Update**: User `uid_alice` sends valid fields plus undeclared key `"superAdmin": true`.
8. **Suspended User Self-Reactivation**: User `uid_alice` whose existing profile has `accountStatus: "suspended"` attempts an `update` to change `displayName` or `accountStatus: "active"`.
9. **Path ID Poisoning**: Caller attempts to create `/userProfiles/bad$id!with/slashes`, `/publicShareLinks/bad$id!with/slashes`, or `/feedAlertAcknowledgments/bad$id!with/slashes`.
10. **Forged `createdAt` Backdating**: Caller creates `/userProfiles/uid_alice`, `/publicShareLinks/sh_1`, or `/feedAlertAcknowledgments/ack_uid_alice_1` with a client-supplied past timestamp instead of `request.time`.
11. **Principal Collaborator Rogue Owner Assignment**: Even Principal Owner attempts to set `role: "owner"` / `isOwner: true` on a collaborator document (`userId != request.auth.uid`).
12. **Revoked / Expired Capability Link Read & Contradictory Alert Ack Toggle**: Unauthenticated visitor attempts `get(/publicShareLinks/sh_leaked)` after `status` becomes `'scrubbed_relinked'`, or user updates `/feedAlertAcknowledgments/ack_uid_alice_1` setting `acknowledged: true` with empty `acknowledgedAtIso: ""` or mutating `alertKey`.
