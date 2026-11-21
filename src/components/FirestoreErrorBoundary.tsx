import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface FirestoreErrorBoundaryProps {
  children: ReactNode;
  title?: string;
  resetKey?: string;
}

interface FirestoreErrorBoundaryState {
  hasError: boolean;
  message: string;
  isFirestoreSyncError: boolean;
}

export class FirestoreErrorBoundary extends Component<
  FirestoreErrorBoundaryProps,
  FirestoreErrorBoundaryState
> {
  state: FirestoreErrorBoundaryState = {
    hasError: false,
    message: '',
    isFirestoreSyncError: false,
  };

  static getDerivedStateFromError(error: Error): FirestoreErrorBoundaryState {
    let message = error.message || 'An unexpected workspace error occurred.';
    let isFirestoreSyncError = false;
    try {
      const parsed = JSON.parse(error.message) as {
        error?: string;
        operationType?: string;
        path?: string;
      };
      if (parsed && typeof parsed === 'object' && parsed.error) {
        isFirestoreSyncError = true;
        message = `${parsed.error}${parsed.path ? ` (${parsed.operationType || 'op'} ${parsed.path})` : ''}`;
      }
    } catch {
      // Standard runtime error message
    }
    return { hasError: true, message, isFirestoreSyncError };
  }

  componentDidUpdate(prevProps: FirestoreErrorBoundaryProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({
        hasError: false,
        message: '',
        isFirestoreSyncError: false,
      });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('WorkspaceErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      const heading = this.state.isFirestoreSyncError
        ? 'Firestore Sync Interrupted'
        : this.props.title || 'Workspace Interrupted';

      return (
        <div className="min-h-[420px] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[#13161C] border border-red-400/35 rounded-xl p-6 space-y-3 text-center">
            <AlertTriangle className="w-7 h-7 text-red-400 mx-auto" />
            <h3 className="text-base font-semibold text-[#F5F7FA]">{heading}</h3>
            <p className="text-xs text-[#A0AABB] leading-relaxed break-words">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() =>
                this.setState({
                  hasError: false,
                  message: '',
                  isFirestoreSyncError: false,
                })
              }
              className="h-9 px-4 inline-flex items-center gap-1.5 rounded-md bg-[#22D3EE] hover:bg-[#67E8F9] text-[#071318] text-xs font-semibold cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reload Workspace
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
