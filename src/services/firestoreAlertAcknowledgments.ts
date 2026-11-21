import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestoreError';

const COLLECTION_NAME = 'feedAlertAcknowledgments';

export interface FirestoreAlertAcknowledgmentRecord {
  ackId: string;
  ownerId: string;
  feedId: string;
  alertKey: string;
  eventType: 'organic' | 'test';
  acknowledged: boolean;
  acknowledgedAtIso: string;
}

function deterministicShortHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeFeedIdForAck(
  feedId: string | null | undefined
): string {
  const raw = (feedId || 'default_feed').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return cleaned.length > 0 ? cleaned : 'default_feed';
}

export function makeScopedAlertLookupKey(
  feedId: string | null | undefined,
  alertKey: string
): string {
  return `${normalizeFeedIdForAck(feedId)}::${alertKey}`;
}

export function buildFeedAlertAckId(
  ownerId: string,
  feedId: string | null | undefined,
  alertKey: string
): string {
  const safeOwner = ownerId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const safeFeed = normalizeFeedIdForAck(feedId).slice(0, 24);
  const safeAlertSlug = alertKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  const hashSuffix = deterministicShortHash(`${safeFeed}:${alertKey}`);
  return `ack_${safeOwner}_${safeFeed}_${safeAlertSlug}_${hashSuffix}`.slice(
    0,
    128
  );
}

export function subscribeToUserFeedAlertAcknowledgments(
  ownerId: string,
  onUpdate: (
    recordsByScopedKey: Record<string, FirestoreAlertAcknowledgmentRecord>
  ) => void,
  onError?: (errorMessage: string) => void
): () => void {
  const ackQuery = query(
    collection(db, COLLECTION_NAME),
    where('ownerId', '==', ownerId)
  );

  return onSnapshot(
    ackQuery,
    (snapshot) => {
      const nextMap: Record<string, FirestoreAlertAcknowledgmentRecord> = {};
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (
          typeof data.ackId === 'string' &&
          typeof data.ownerId === 'string' &&
          typeof data.feedId === 'string' &&
          typeof data.alertKey === 'string' &&
          (data.eventType === 'organic' || data.eventType === 'test') &&
          typeof data.acknowledged === 'boolean'
        ) {
          const record: FirestoreAlertAcknowledgmentRecord = {
            ackId: data.ackId,
            ownerId: data.ownerId,
            feedId: data.feedId,
            alertKey: data.alertKey,
            eventType: data.eventType,
            acknowledged: data.acknowledged,
            acknowledgedAtIso:
              typeof data.acknowledgedAtIso === 'string'
                ? data.acknowledgedAtIso
                : '',
          };
          nextMap[`${record.feedId}::${record.alertKey}`] = record;
        }
      });
      onUpdate(nextMap);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, COLLECTION_NAME);
      } catch (structuredErr) {
        onError?.(
          structuredErr instanceof Error
            ? structuredErr.message
            : String(structuredErr)
        );
      }
    }
  );
}

export async function upsertFeedAlertAcknowledgment(params: {
  ownerId: string;
  feedId: string | null | undefined;
  alertKey: string;
  eventType: 'organic' | 'test';
  acknowledged: boolean;
  acknowledgedAtIso?: string | null;
  knownExists?: boolean;
}): Promise<FirestoreAlertAcknowledgmentRecord> {
  const safeFeedId = normalizeFeedIdForAck(params.feedId);
  const safeAlertKey = params.alertKey.trim().slice(0, 160);
  const ackId = buildFeedAlertAckId(params.ownerId, safeFeedId, safeAlertKey);
  const docPath = `${COLLECTION_NAME}/${ackId}`;
  const docRef = doc(db, COLLECTION_NAME, ackId);

  const safeAckIso = params.acknowledged
    ? (params.acknowledgedAtIso && params.acknowledgedAtIso.trim().length > 0
        ? params.acknowledgedAtIso.trim()
        : new Date().toISOString()
      ).slice(0, 64)
    : '';

  let docExists = params.knownExists;
  if (typeof docExists !== 'boolean') {
    try {
      const existingSnap = await getDoc(docRef);
      docExists = existingSnap.exists();
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, docPath);
    }
  }

  if (docExists) {
    try {
      await updateDoc(docRef, {
        acknowledged: params.acknowledged,
        acknowledgedAtIso: safeAckIso,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, docPath);
    }
  } else {
    try {
      await setDoc(docRef, {
        ackId,
        ownerId: params.ownerId,
        feedId: safeFeedId,
        alertKey: safeAlertKey,
        eventType: params.eventType,
        acknowledged: params.acknowledged,
        acknowledgedAtIso: safeAckIso,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, docPath);
    }
  }

  return {
    ackId,
    ownerId: params.ownerId,
    feedId: safeFeedId,
    alertKey: safeAlertKey,
    eventType: params.eventType,
    acknowledged: params.acknowledged,
    acknowledgedAtIso: safeAckIso,
  };
}
