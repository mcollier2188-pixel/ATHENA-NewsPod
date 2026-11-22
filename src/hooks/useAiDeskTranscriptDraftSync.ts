import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestoreError';

export type AiDeskDraftSurface = 'transcribe' | 'live';
export type DraftSyncState = 'idle' | 'saving' | 'saved' | 'local' | 'error';

export interface DraftTranscriptTurn {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: string;
}

export interface HydratedTranscribeDraft {
  title: string;
  transcriptText: string;
  durationSeconds: number;
  clientSavedAtIso: string;
}

export interface HydratedLiveDraft {
  turns: DraftTranscriptTurn[];
  voiceName: string;
  clientSavedAtIso: string;
}

interface UseAiDeskTranscriptDraftSyncOptions {
  user: User | null;
  authLoading?: boolean;
  // Transcribe surface state
  transcriptTitle: string;
  transcriptText: string;
  recordSeconds: number;
  onHydrateTranscribeDraft: (draft: HydratedTranscribeDraft) => void;
  // Live Voice surface state
  liveTurns: DraftTranscriptTurn[];
  liveVoice: string;
  onHydrateLiveDraft: (draft: HydratedLiveDraft) => void;
}

export interface AiDeskTranscriptDraftSyncResult {
  transcribeDraftState: DraftSyncState;
  transcribeLastSavedIso: string | null;
  liveDraftState: DraftSyncState;
  liveLastSavedIso: string | null;
  draftSyncError: string | null;
  saveTranscribeDraftNow: () => Promise<void>;
  discardTranscribeDraft: () => Promise<void>;
  saveLiveDraftNow: () => Promise<void>;
  discardLiveDraft: () => Promise<void>;
}

export const AI_DESK_DRAFT_AUTOSAVE_INTERVAL_MS = 30_000;
const COLLECTION_NAME = 'aiDeskTranscriptDrafts';
const LOCAL_STORAGE_PREFIX = 'dispatch.aiDeskDraft.v1';

// Exact schema constants synchronized with firebase-blueprint.json & firestore.rules
const MAX_ID_LEN = 128;
const MAX_TITLE_LEN = 200;
const MAX_TRANSCRIPT_LEN = 50_000;
const MAX_TURNS = 200;
const MAX_TURN_TEXT_LEN = 4_000;
const MAX_TIMESTAMP_LEN = 64;
const MAX_VOICE_LEN = 64;
const MAX_DURATION_SECONDS = 14_400;
const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function sanitizeSafeId(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_ID_LEN);
  if (cleaned.length >= 1 && VALID_ID_REGEX.test(cleaned)) {
    return cleaned;
  }
  return fallback;
}

export function buildAiDeskDraftDocId(
  uid: string,
  surface: AiDeskDraftSurface
): string {
  const safeUid = sanitizeSafeId(uid, 'user');
  return `drf_${safeUid}_${surface}`.slice(0, MAX_ID_LEN);
}

function clampTitle(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  const base = trimmed.length >= 1 ? trimmed : fallback;
  return base.slice(0, MAX_TITLE_LEN);
}

function clampTranscript(raw: string): string {
  return raw.slice(0, MAX_TRANSCRIPT_LEN);
}

function clampDurationSeconds(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(MAX_DURATION_SECONDS, Math.round(raw));
}

function sanitizeTurns(turns: DraftTranscriptTurn[]): DraftTranscriptTurn[] {
  const result: DraftTranscriptTurn[] = [];
  for (let i = 0; i < turns.length && result.length < MAX_TURNS; i++) {
    const t = turns[i];
    if (!t || typeof t.text !== 'string') continue;
    const text = t.text.trim().slice(0, MAX_TURN_TEXT_LEN);
    if (!text) continue;
    const role: 'user' | 'model' = t.role === 'model' ? 'model' : 'user';
    const id = sanitizeSafeId(String(t.id || `turn_${i}`), `turn_${i}`);
    const timestamp =
      String(t.timestamp || '').trim().slice(0, MAX_TIMESTAMP_LEN) || '00:00';
    result.push({ id, role, text, timestamp });
  }
  return result;
}

function serializeTurnsToTranscriptText(turns: DraftTranscriptTurn[]): string {
  if (turns.length === 0) return '';
  return clampTranscript(
    turns
      .map(
        (t) =>
          `[${t.timestamp}] ${t.role === 'user' ? 'You' : 'Gemini Live'}: ${t.text}`
      )
      .join('\n\n')
  );
}

function reportFirestoreDiagnostic(
  error: unknown,
  operationType: OperationType,
  path: string
): string {
  try {
    handleFirestoreError(error, operationType, path);
  } catch (structuredErr) {
    return structuredErr instanceof Error
      ? structuredErr.message
      : 'Could not sync transcript draft to Firestore.';
  }
}

function getLocalStorageKey(
  uid: string | null | undefined,
  surface: AiDeskDraftSurface
): string {
  return `${LOCAL_STORAGE_PREFIX}.${uid || 'guest'}.${surface}`;
}

export function useAiDeskTranscriptDraftSync({
  user,
  authLoading = false,
  transcriptTitle,
  transcriptText,
  recordSeconds,
  onHydrateTranscribeDraft,
  liveTurns,
  liveVoice,
  onHydrateLiveDraft,
}: UseAiDeskTranscriptDraftSyncOptions): AiDeskTranscriptDraftSyncResult {
  const [transcribeDraftState, setTranscribeDraftState] =
    useState<DraftSyncState>('idle');
  const [transcribeLastSavedIso, setTranscribeLastSavedIso] = useState<
    string | null
  >(null);
  const [liveDraftState, setLiveDraftState] = useState<DraftSyncState>('idle');
  const [liveLastSavedIso, setLiveLastSavedIso] = useState<string | null>(null);
  const [draftSyncError, setDraftSyncError] = useState<string | null>(null);

  const latestRef = useRef({
    user,
    transcriptTitle,
    transcriptText,
    recordSeconds,
    liveTurns,
    liveVoice,
  });
  latestRef.current = {
    user,
    transcriptTitle,
    transcriptText,
    recordSeconds,
    liveTurns,
    liveVoice,
  };

  const hydrateCallbacksRef = useRef({
    onHydrateTranscribeDraft,
    onHydrateLiveDraft,
  });
  hydrateCallbacksRef.current = {
    onHydrateTranscribeDraft,
    onHydrateLiveDraft,
  };

  const docExistsRef = useRef<Record<AiDeskDraftSurface, boolean | null>>({
    transcribe: null,
    live: null,
  });
  const lastSavedFingerprintRef = useRef<Record<AiDeskDraftSurface, string>>({
    transcribe: '',
    live: '',
  });
  const isHydratingRef = useRef<boolean>(false);

  // Hydrate existing Firestore (or guest localStorage) drafts on mount / user switch
  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    docExistsRef.current = { transcribe: null, live: null };

    async function hydrateDrafts() {
      isHydratingRef.current = true;
      try {
        if (user && VALID_ID_REGEX.test(user.uid) && user.emailVerified) {
          const transcribeDocId = buildAiDeskDraftDocId(user.uid, 'transcribe');
          const transcribePath = `${COLLECTION_NAME}/${transcribeDocId}`;
          try {
            const snap = await getDoc(doc(db, COLLECTION_NAME, transcribeDocId));
            if (cancelled) return;
            docExistsRef.current.transcribe = snap.exists();
            if (snap.exists()) {
              const data = snap.data();
              const savedText =
                typeof data.transcriptText === 'string'
                  ? data.transcriptText
                  : '';
              const savedTitle =
                typeof data.title === 'string' && data.title.trim()
                  ? data.title
                  : 'Field Voice Note';
              const savedDuration =
                typeof data.durationSeconds === 'number'
                  ? data.durationSeconds
                  : 0;
              const savedIso =
                typeof data.clientSavedAtIso === 'string'
                  ? data.clientSavedAtIso
                  : new Date().toISOString();

              if (savedText.trim()) {
                const fp = `${clampTitle(savedTitle, 'Field Voice Note')}::${clampTranscript(savedText)}`;
                lastSavedFingerprintRef.current.transcribe = fp;
                setTranscribeLastSavedIso(savedIso);
                setTranscribeDraftState('saved');
                if (!latestRef.current.transcriptText.trim()) {
                  hydrateCallbacksRef.current.onHydrateTranscribeDraft({
                    title: savedTitle,
                    transcriptText: savedText,
                    durationSeconds: savedDuration,
                    clientSavedAtIso: savedIso,
                  });
                }
              }
            }
          } catch (err) {
            reportFirestoreDiagnostic(err, OperationType.GET, transcribePath);
          }

          const liveDocId = buildAiDeskDraftDocId(user.uid, 'live');
          const livePath = `${COLLECTION_NAME}/${liveDocId}`;
          try {
            const snap = await getDoc(doc(db, COLLECTION_NAME, liveDocId));
            if (cancelled) return;
            docExistsRef.current.live = snap.exists();
            if (snap.exists()) {
              const data = snap.data();
              const rawTurns = Array.isArray(data.turns)
                ? (data.turns as DraftTranscriptTurn[])
                : [];
              const cleanTurns = sanitizeTurns(rawTurns);
              const savedVoice =
                typeof data.voiceName === 'string' ? data.voiceName : '';
              const savedIso =
                typeof data.clientSavedAtIso === 'string'
                  ? data.clientSavedAtIso
                  : new Date().toISOString();

              if (cleanTurns.length > 0) {
                const fp = `${savedVoice}::${serializeTurnsToTranscriptText(cleanTurns)}`;
                lastSavedFingerprintRef.current.live = fp;
                setLiveLastSavedIso(savedIso);
                setLiveDraftState('saved');
                if (latestRef.current.liveTurns.length === 0) {
                  hydrateCallbacksRef.current.onHydrateLiveDraft({
                    turns: cleanTurns,
                    voiceName: savedVoice,
                    clientSavedAtIso: savedIso,
                  });
                }
              }
            }
          } catch (err) {
            reportFirestoreDiagnostic(err, OperationType.GET, livePath);
          }
          return;
        }

        // Guest / unverified local draft recovery fallback
        try {
          const rawTranscribe = localStorage.getItem(
            getLocalStorageKey(user?.uid, 'transcribe')
          );
          if (rawTranscribe && !latestRef.current.transcriptText.trim()) {
            const parsed = JSON.parse(rawTranscribe) as Partial<HydratedTranscribeDraft>;
            if (parsed.transcriptText && parsed.transcriptText.trim()) {
              const title = clampTitle(parsed.title || '', 'Field Voice Note');
              const text = clampTranscript(parsed.transcriptText);
              const iso = parsed.clientSavedAtIso || new Date().toISOString();
              lastSavedFingerprintRef.current.transcribe = `${title}::${text}`;
              setTranscribeLastSavedIso(iso);
              setTranscribeDraftState('local');
              hydrateCallbacksRef.current.onHydrateTranscribeDraft({
                title,
                transcriptText: text,
                durationSeconds: clampDurationSeconds(parsed.durationSeconds ?? 0),
                clientSavedAtIso: iso,
              });
            }
          }

          const rawLive = localStorage.getItem(
            getLocalStorageKey(user?.uid, 'live')
          );
          if (rawLive && latestRef.current.liveTurns.length === 0) {
            const parsed = JSON.parse(rawLive) as Partial<HydratedLiveDraft>;
            const cleanTurns = sanitizeTurns(parsed.turns || []);
            if (cleanTurns.length > 0) {
              const voice = (parsed.voiceName || '').slice(0, MAX_VOICE_LEN);
              const iso = parsed.clientSavedAtIso || new Date().toISOString();
              lastSavedFingerprintRef.current.live = `${voice}::${serializeTurnsToTranscriptText(cleanTurns)}`;
              setLiveLastSavedIso(iso);
              setLiveDraftState('local');
              hydrateCallbacksRef.current.onHydrateLiveDraft({
                turns: cleanTurns,
                voiceName: voice,
                clientSavedAtIso: iso,
              });
            }
          }
        } catch {
          // Ignore malformed localStorage cache
        }
      } finally {
        if (!cancelled) {
          isHydratingRef.current = false;
        }
      }
    }

    void hydrateDrafts();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, user?.emailVerified, authLoading]);

  const persistSurfaceDraft = useCallback(
    async (surface: AiDeskDraftSurface, force = false): Promise<void> => {
      if (isHydratingRef.current) return;
      const state = latestRef.current;
      const currentUser = state.user;
      const nowIso = new Date().toISOString();

      let safeTitle: string;
      let safeTranscriptText: string;
      let safeTurns: DraftTranscriptTurn[];
      let safeVoiceName: string;
      let safeDurationSeconds: number;
      let fingerprint: string;

      if (surface === 'transcribe') {
        safeTitle = clampTitle(state.transcriptTitle, 'Field Voice Note');
        safeTranscriptText = clampTranscript(state.transcriptText);
        safeTurns = [];
        safeVoiceName = '';
        safeDurationSeconds = clampDurationSeconds(state.recordSeconds);
        if (!safeTranscriptText.trim()) return;
        fingerprint = `${safeTitle}::${safeTranscriptText}`;
      } else {
        safeTurns = sanitizeTurns(state.liveTurns);
        if (safeTurns.length === 0) return;
        safeTitle = clampTitle(
          `Live Voice Session (${state.liveVoice || 'Zephyr'})`,
          'Live Voice Session'
        );
        safeTranscriptText = serializeTurnsToTranscriptText(safeTurns);
        safeVoiceName = String(state.liveVoice || '').slice(0, MAX_VOICE_LEN);
        safeDurationSeconds = 0;
        fingerprint = `${safeVoiceName}::${safeTranscriptText}`;
      }

      if (!force && lastSavedFingerprintRef.current[surface] === fingerprint) {
        return;
      }

      const setSurfaceState =
        surface === 'transcribe' ? setTranscribeDraftState : setLiveDraftState;
      const setSurfaceIso =
        surface === 'transcribe'
          ? setTranscribeLastSavedIso
          : setLiveLastSavedIso;

      // Always write local crash-recovery mirror first
      try {
        localStorage.setItem(
          getLocalStorageKey(currentUser?.uid, surface),
          JSON.stringify(
            surface === 'transcribe'
              ? {
                  title: safeTitle,
                  transcriptText: safeTranscriptText,
                  durationSeconds: safeDurationSeconds,
                  clientSavedAtIso: nowIso,
                }
              : {
                  turns: safeTurns,
                  voiceName: safeVoiceName,
                  clientSavedAtIso: nowIso,
                }
          )
        );
      } catch {
        // Ignore storage quota issues
      }

      // Guest or unverified account: keep local draft state without failing Firestore rules
      if (
        !currentUser ||
        !VALID_ID_REGEX.test(currentUser.uid) ||
        !currentUser.emailVerified
      ) {
        lastSavedFingerprintRef.current[surface] = fingerprint;
        setSurfaceIso(nowIso);
        setSurfaceState('local');
        return;
      }

      const draftId = buildAiDeskDraftDocId(currentUser.uid, surface);
      const docPath = `${COLLECTION_NAME}/${draftId}`;
      const docRef = doc(db, COLLECTION_NAME, draftId);

      setSurfaceState('saving');
      setDraftSyncError(null);

      try {
        let exists = docExistsRef.current[surface];
        if (exists === null) {
          try {
            const snap = await getDoc(docRef);
            exists = snap.exists();
            docExistsRef.current[surface] = exists;
          } catch (getErr) {
            reportFirestoreDiagnostic(getErr, OperationType.GET, docPath);
            exists = false;
          }
        }

        if (exists) {
          try {
            await updateDoc(docRef, {
              title: safeTitle,
              transcriptText: safeTranscriptText,
              turns: safeTurns,
              voiceName: safeVoiceName,
              durationSeconds: safeDurationSeconds,
              clientSavedAtIso: nowIso,
              updatedAt: serverTimestamp(),
            });
          } catch (updateErr) {
            reportFirestoreDiagnostic(updateErr, OperationType.UPDATE, docPath);
            setSurfaceState('error');
            setDraftSyncError('Auto-save could not update Firestore draft.');
            return;
          }
        } else {
          try {
            await setDoc(docRef, {
              draftId,
              ownerId: currentUser.uid,
              surface,
              title: safeTitle,
              transcriptText: safeTranscriptText,
              turns: safeTurns,
              voiceName: safeVoiceName,
              durationSeconds: safeDurationSeconds,
              clientSavedAtIso: nowIso,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            docExistsRef.current[surface] = true;
          } catch (createErr) {
            reportFirestoreDiagnostic(createErr, OperationType.CREATE, docPath);
            setSurfaceState('error');
            setDraftSyncError('Auto-save could not create Firestore draft.');
            return;
          }
        }

        lastSavedFingerprintRef.current[surface] = fingerprint;
        setSurfaceIso(nowIso);
        setSurfaceState('saved');
      } catch {
        setSurfaceState('error');
      }
    },
    []
  );

  // Core 30-second auto-save interval for both AI Desk transcript surfaces
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void persistSurfaceDraft('transcribe', false);
      void persistSurfaceDraft('live', false);
    }, AI_DESK_DRAFT_AUTOSAVE_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [persistSurfaceDraft]);

  const discardSurfaceDraft = useCallback(
    async (surface: AiDeskDraftSurface): Promise<void> => {
      const currentUser = latestRef.current.user;
      lastSavedFingerprintRef.current[surface] = '';

      if (surface === 'transcribe') {
        setTranscribeLastSavedIso(null);
        setTranscribeDraftState('idle');
      } else {
        setLiveLastSavedIso(null);
        setLiveDraftState('idle');
      }

      try {
        localStorage.removeItem(getLocalStorageKey(currentUser?.uid, surface));
      } catch {
        // Ignore
      }

      if (
        !currentUser ||
        !VALID_ID_REGEX.test(currentUser.uid) ||
        !currentUser.emailVerified
      ) {
        return;
      }

      const draftId = buildAiDeskDraftDocId(currentUser.uid, surface);
      const docPath = `${COLLECTION_NAME}/${draftId}`;
      const docRef = doc(db, COLLECTION_NAME, draftId);

      try {
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          await deleteDoc(docRef);
        }
        docExistsRef.current[surface] = false;
      } catch (err) {
        reportFirestoreDiagnostic(err, OperationType.DELETE, docPath);
      }
    },
    []
  );

  const saveTranscribeDraftNow = useCallback(
    () => persistSurfaceDraft('transcribe', true),
    [persistSurfaceDraft]
  );

  const discardTranscribeDraft = useCallback(
    () => discardSurfaceDraft('transcribe'),
    [discardSurfaceDraft]
  );

  const saveLiveDraftNow = useCallback(
    () => persistSurfaceDraft('live', true),
    [persistSurfaceDraft]
  );

  const discardLiveDraft = useCallback(
    () => discardSurfaceDraft('live'),
    [discardSurfaceDraft]
  );

  return {
    transcribeDraftState,
    transcribeLastSavedIso,
    liveDraftState,
    liveLastSavedIso,
    draftSyncError,
    saveTranscribeDraftNow,
    discardTranscribeDraft,
    saveLiveDraftNow,
    discardLiveDraft,
  };
}
