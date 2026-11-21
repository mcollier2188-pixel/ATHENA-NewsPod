import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  reload,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db, googleAuthProvider } from '../lib/firebase';
import type { UserRole } from '../types';
import {
  fetchDbProfile,
  recordClientAuthEvent,
  runSelfRepairAuth,
  SessionRevokedClientError,
} from '../services/suiteApi';
import { syncCallerFirestoreProfile } from '../services/firestoreUserProfile';

const PRINCIPAL_OWNER_EMAIL = 'mcollier2188@gmail.com';

function formatFirebaseAuthError(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';
  const rawMessage = err instanceof Error ? err.message : '';

  if (code === 'auth/popup-blocked') {
    return 'Google Sign-In popup was blocked by your browser. Allow popups for this site in your address bar, then click Retry Sign-In.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Google Sign-In window was closed before completing verification. Click Retry Sign-In whenever you are ready.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'This preview domain is not yet listed in Firebase Authorized Domains. Open the app in a standalone browser tab or check Firebase Authentication settings.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Network connection interrupted during Google Sign-In. Check your connection and retry.';
  }
  return rawMessage || 'Google Sign-In could not be completed. Please try again.';
}

interface AuthContextValue {
  user: User | null;
  role: UserRole;
  accountStatus: 'active' | 'suspended';
  isOwner: boolean;
  isAdminOrOwner: boolean;
  isLoading: boolean;
  authError: string | null;
  clearAuthError: () => void;
  refreshProfileRole: () => Promise<void>;
  repairCurrentAuthSession: () => Promise<{
    repaired: boolean;
    issuesFixed: string[];
    role: UserRole;
  }>;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<UserRole>('member');
  const [accountStatus, setAccountStatus] = useState<'active' | 'suspended'>('active');
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);

  const handleForcedSessionRevocation = useCallback(async (reasonMessage?: string) => {
    tokenRef.current = null;
    setRole('member');
    setAccountStatus('active');
    setAuthError(
      reasonMessage ||
        'Your active studio session was revoked by an administrator. Sign in with Google again to continue.'
    );
    if (auth.currentUser) {
      await signOut(auth).catch(() => {
        // Ignore transient sign-out failure; local auth token cache is cleared
      });
    }
  }, []);

  const syncRoleFromBackend = useCallback(
    async (firebaseUser: User, token: string, isExplicitSignIn = false) => {
      const isVerifiedOwnerEmail = Boolean(
        firebaseUser.emailVerified &&
          firebaseUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
      );
      if (isVerifiedOwnerEmail) {
        setRole('owner');
        setAccountStatus('active');
      }
      try {
        const profile = await fetchDbProfile(token, isExplicitSignIn);
        const nextStatus: 'active' | 'suspended' =
          isVerifiedOwnerEmail || profile?.accountStatus !== 'suspended'
            ? 'active'
            : 'suspended';
        setAccountStatus(nextStatus);
        if (nextStatus === 'suspended') {
          setAuthError(
            'Your studio account has been suspended by a Studio Administrator.'
          );
        }
        const resolvedRole: UserRole =
          profile?.role === 'owner' || profile?.role === 'admin'
            ? profile.role
            : isVerifiedOwnerEmail
              ? 'owner'
              : 'member';
        setRole(resolvedRole);

        void syncCallerFirestoreProfile(
          firebaseUser,
          {
            role: resolvedRole,
            accountStatus: nextStatus,
            authProvider: profile?.authProvider,
          },
          'google_signin'
        ).catch(() => {
          // Non-blocking background Firestore profile sync; explicit Repair Auth surfaces full diagnostics
        });
      } catch (err) {
        if (err instanceof SessionRevokedClientError && !isVerifiedOwnerEmail) {
          await handleForcedSessionRevocation(err.message);
          return;
        }
        const fallbackRole: UserRole = isVerifiedOwnerEmail ? 'owner' : 'member';
        setAccountStatus('active');
        setRole(fallbackRole);
      }
    },
    [handleForcedSessionRevocation]
  );

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (nextUser) {
        setAuthError(null);
        try {
          const freshToken = await nextUser.getIdToken();
          tokenRef.current = freshToken;
          await syncRoleFromBackend(nextUser, freshToken, false);
        } catch {
          tokenRef.current = null;
          const fallbackOwner = Boolean(
            nextUser.emailVerified &&
              nextUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
          );
          setRole(fallbackOwner ? 'owner' : 'member');
          setAccountStatus('active');
        }
      } else {
        tokenRef.current = null;
        setRole('member');
        setAccountStatus('active');
      }
      setIsLoading(false);
    });
    return () => unsub();
  }, [syncRoleFromBackend]);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const getIdToken = useCallback(async () => {
    if (!auth.currentUser) return null;
    try {
      const fresh = await auth.currentUser.getIdToken();
      tokenRef.current = fresh;
      return fresh;
    } catch {
      return tokenRef.current;
    }
  }, []);

  const refreshProfileRole = useCallback(async () => {
    if (!auth.currentUser) return;
    const token = await getIdToken();
    if (token) {
      await syncRoleFromBackend(auth.currentUser, token, false);
    }
  }, [getIdToken, syncRoleFromBackend]);

  useEffect(() => {
    const onSessionRevoked = (evt: Event) => {
      const detail =
        evt instanceof CustomEvent && evt.detail && typeof evt.detail === 'object'
          ? (evt.detail as { message?: string })
          : {};
      const currentEmail = auth.currentUser?.email?.trim().toLowerCase();
      if (auth.currentUser?.emailVerified && currentEmail === PRINCIPAL_OWNER_EMAIL) {
        return;
      }
      void handleForcedSessionRevocation(detail.message);
    };

    window.addEventListener('athena:session-revoked', onSessionRevoked);
    return () => {
      window.removeEventListener('athena:session-revoked', onSessionRevoked);
    };
  }, [handleForcedSessionRevocation]);

  useEffect(() => {
    if (!user) return;
    const isVerifiedOwnerEmail = Boolean(
      user.emailVerified &&
        user.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
    );
    if (isVerifiedOwnerEmail) return;

    let observedFirestoreLink = false;
    const profileDocRef = doc(db, 'userProfiles', user.uid);
    const unsubDoc = onSnapshot(
      profileDocRef,
      (snap) => {
        if (snap.exists()) {
          observedFirestoreLink = true;
          return;
        }
        if (observedFirestoreLink && auth.currentUser?.uid === user.uid) {
          void handleForcedSessionRevocation(
            'Your active studio session was revoked by an administrator and your Firestore-linked auth state was cleared. Sign in with Google again to continue.'
          );
        }
      },
      () => {
        // Ignore transient Firestore listener errors; backend API revocation remains authoritative
      }
    );

    const onWindowFocus = () => {
      if (auth.currentUser?.uid === user.uid) {
        void refreshProfileRole();
      }
    };
    window.addEventListener('focus', onWindowFocus);

    return () => {
      unsubDoc();
      window.removeEventListener('focus', onWindowFocus);
    };
  }, [handleForcedSessionRevocation, refreshProfileRole, user]);

  const repairCurrentAuthSession = useCallback(async () => {
    if (!auth.currentUser) {
      throw new Error('Sign in with Google first to repair authentication state.');
    }
    setAuthError(null);
    await reload(auth.currentUser);
    const reloadedUser = auth.currentUser;
    setUser(reloadedUser);

    const freshToken = await reloadedUser.getIdToken(true);
    tokenRef.current = freshToken;

    const selfRepair = await runSelfRepairAuth(freshToken, {
      displayName: reloadedUser.displayName || '',
      photoUrl: reloadedUser.photoURL || '',
    });

    const isVerifiedOwnerEmail = Boolean(
      reloadedUser.emailVerified &&
        reloadedUser.email?.trim().toLowerCase() === PRINCIPAL_OWNER_EMAIL
    );

    const resolvedStatus: 'active' | 'suspended' =
      isVerifiedOwnerEmail || selfRepair.user.accountStatus !== 'suspended'
        ? 'active'
        : 'suspended';
    const resolvedRole: UserRole =
      isVerifiedOwnerEmail
        ? 'owner'
        : selfRepair.user.role === 'owner' || selfRepair.user.role === 'admin'
          ? selfRepair.user.role
          : 'member';

    const issuesFixed = [...selfRepair.sqlIssues];
    const firestoreSync = await syncCallerFirestoreProfile(
      reloadedUser,
      {
        role: resolvedRole,
        accountStatus: resolvedStatus,
        authProvider: selfRepair.user.authProvider,
      },
      'repair_auth'
    );

    if (firestoreSync.repairedOwnershipFlag) {
      issuesFixed.push(
        'Corrected Firestore /userProfiles ownership privilege flag to match verified Google Sign-In'
      );
    }

    setAccountStatus(resolvedStatus);
    setRole(resolvedRole);

    return {
      repaired: selfRepair.repaired || firestoreSync.repairedOwnershipFlag,
      issuesFixed,
      role: resolvedRole,
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setAuthError(null);
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const freshToken = await cred.user.getIdToken();
      tokenRef.current = freshToken;
      await syncRoleFromBackend(cred.user, freshToken, true);
    } catch (err) {
      setAuthError(formatFirebaseAuthError(err));
    }
  }, [syncRoleFromBackend]);

  const signOutUser = useCallback(async () => {
    setAuthError(null);
    try {
      const activeToken =
        tokenRef.current ||
        (auth.currentUser ? await auth.currentUser.getIdToken().catch(() => null) : null);
      if (activeToken) {
        await recordClientAuthEvent(activeToken, 'sign_out').catch(() => {
          // Best-effort sign-out audit log; never block user sign-out
        });
      }
      await signOut(auth);
      tokenRef.current = null;
      setRole('member');
      setAccountStatus('active');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Could not sign out.');
    }
  }, []);

  const isOwner = Boolean(user && role === 'owner');
  const isAdminOrOwner = Boolean(
    user &&
      accountStatus === 'active' &&
      (role === 'owner' || role === 'admin')
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        role,
        accountStatus,
        isOwner,
        isAdminOrOwner,
        isLoading,
        authError,
        clearAuthError,
        refreshProfileRole,
        repairCurrentAuthSession,
        signInWithGoogle,
        signOutUser,
        getIdToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
