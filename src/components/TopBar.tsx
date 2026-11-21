import { useEffect, useRef, useState } from 'react';
import { AlertCircle, LogIn, LogOut, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { ActiveView } from '../types';
import { useAuth } from '../contexts/AuthContext';

interface TopBarProps {
  activeView: ActiveView;
  onSelectView: (view: ActiveView) => void;
}

type TopNavSection = 'newsroom' | 'chat' | 'media' | 'mockup' | 'spatial';

const NAV_ITEMS: Array<{
  section: TopNavSection;
  targetView: ActiveView;
  label: string;
}> = [
  { section: 'newsroom', targetView: 'articles', label: 'Newsroom' },
  { section: 'chat', targetView: 'chat', label: 'AI Desk' },
  { section: 'media', targetView: 'media', label: 'Media Lab' },
  { section: 'mockup', targetView: 'mockup', label: 'Site Mockup' },
  { section: 'spatial', targetView: 'spatial', label: 'Spatial & Map' },
];

function getActiveSection(view: ActiveView): TopNavSection | null {
  if (view === 'articles' || view === 'briefing' || view === 'archive') {
    return 'newsroom';
  }
  if (view === 'owner') {
    return null;
  }
  return view;
}

export function TopBar({ activeView, onSelectView }: TopBarProps) {
  const {
    user,
    role,
    isOwner,
    isAdminOrOwner,
    isLoading,
    authError,
    clearAuthError,
    signInWithGoogle,
    signOutUser,
  } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const currentSection = getActiveSection(activeView);

  useEffect(() => {
    setMenuOpen(false);
  }, [activeView]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (ev: MouseEvent) => {
      if (
        menuContainerRef.current &&
        !menuContainerRef.current.contains(ev.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-30 bg-[#0E1116]/95 backdrop-blur-md border-b border-[#22D3EE]/25">
      <div className="px-5 sm:px-7 h-16 flex items-center justify-between gap-6">
        {/* Zone 1: Single-element brand wordmark */}
        <button
          type="button"
          onClick={() => onSelectView('articles')}
          className="font-serif text-[22px] font-semibold tracking-tight text-[#F5F7FA] hover:text-[#67E8F9] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          Dispatch
        </button>

        {/* Zone 2: 5 concise single-line navigation links */}
        <nav
          aria-label="Primary"
          className="flex items-center gap-5 sm:gap-7 overflow-x-auto"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = currentSection === item.section;
            return (
              <button
                key={item.section}
                type="button"
                onClick={() => onSelectView(item.targetView)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative py-5 text-sm font-medium whitespace-nowrap shrink-0 transition-colors duration-150 cursor-pointer ${
                  isActive
                    ? 'text-[#F5F7FA]'
                    : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 right-0 bottom-0 h-[2px] bg-[#22D3EE]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Account Sign-In / Profile & Ultra Owner Console Access */}
        <div ref={menuContainerRef} className="relative shrink-0">
          {user ? (
            <>
              <button
                type="button"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((prev) => !prev)}
                className={`h-9 pl-2 pr-3 inline-flex items-center gap-2 bg-[#13161C] hover:bg-[#1A202B] border rounded-md text-xs font-medium text-[#F5F7FA] whitespace-nowrap shrink-0 cursor-pointer ${
                  activeView === 'owner'
                    ? 'border-[#22D3EE]'
                    : 'border-[#22D3EE]/30'
                }`}
              >
                {user.photoURL ? (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || 'Account'}
                    className="w-6 h-6 rounded-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-[#22D3EE]/20 text-[#67E8F9] inline-flex items-center justify-center text-[11px] font-semibold">
                    {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="hidden sm:inline max-w-[110px] truncate">
                  {user.displayName?.split(' ')[0] || user.email?.split('@')[0] || 'Account'}
                </span>
                {isOwner ? (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold tracking-wider uppercase bg-[#22D3EE]/15 text-[#67E8F9] border border-[#22D3EE]/45 rounded">
                    ULTRA
                  </span>
                ) : role === 'admin' ? (
                  <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold tracking-wider uppercase bg-emerald-500/15 text-emerald-300 border border-emerald-400/40 rounded">
                    ADMIN
                  </span>
                ) : null}
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-60 bg-[#13161C] border border-[#22D3EE]/30 rounded-lg shadow-xl p-2 z-50"
                >
                  <div className="px-2.5 py-2 border-b border-white/10">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[#F5F7FA] truncate">
                        {user.displayName || 'Dispatch Member'}
                      </span>
                      {isOwner && (
                        <span className="text-[10px] font-mono font-semibold text-[#67E8F9] uppercase shrink-0">
                          Owner
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-[#8C96A8] truncate mt-0.5">
                      {user.email}
                    </div>
                  </div>

                  {isAdminOrOwner && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onSelectView('owner');
                      }}
                      className={`mt-1 w-full h-9 px-2.5 inline-flex items-center gap-2 text-xs font-medium rounded-md cursor-pointer ${
                        activeView === 'owner'
                          ? 'bg-[#22D3EE]/15 text-[#67E8F9]'
                          : 'text-[#E4E9F1] hover:text-[#67E8F9] hover:bg-white/5'
                      }`}
                    >
                      <ShieldCheck className="w-3.5 h-3.5 text-[#22D3EE]" />
                      Owner Console
                    </button>
                  )}

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void signOutUser();
                    }}
                    className="mt-1 w-full h-9 px-2.5 inline-flex items-center gap-2 text-xs text-[#C7D0DF] hover:text-[#F5F7FA] hover:bg-white/5 rounded-md cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5 text-[#8C96A8]" />
                    Sign out
                  </button>
                </div>
              )}
            </>
          ) : (
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void signInWithGoogle()}
              className="h-9 px-3.5 inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
              Sign in
            </button>
          )}
        </div>
      </div>

      {/* Dismissible Sign-In Recovery Banner when popup blockers or iframe rules interrupt auth */}
      {authError && (
        <div
          role="alert"
          className="px-5 sm:px-7 py-2.5 bg-[#1B161E] border-t border-amber-400/35 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-100"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 text-amber-300 shrink-0" aria-hidden="true" />
            <span className="leading-relaxed">{authError}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void signInWithGoogle()}
              className="h-7 px-2.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              Retry Sign-In
            </button>
            <button
              type="button"
              onClick={clearAuthError}
              aria-label="Dismiss sign-in message"
              className="w-7 h-7 inline-flex items-center justify-center text-[#9BA6B8] hover:text-[#F5F7FA] rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
