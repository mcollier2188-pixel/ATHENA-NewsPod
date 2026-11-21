import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Calendar,
  Check,
  CheckSquare,
  ExternalLink,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { AudioBriefing } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { GoogleSignInButton } from './GoogleSignInButton';
import { DriveAuthExpiredError } from '../services/googleDriveService';
import {
  clearCompletedGoogleTasks,
  createGoogleTask,
  createTasksFromBriefingTakeaways,
  deleteGoogleTask,
  ensureDispatchTaskList,
  formatTaskDueDateLabel,
  listGoogleTaskLists,
  listGoogleTasks,
  toDateInputValue,
  toggleGoogleTaskCompletion,
  updateGoogleTask,
  type GoogleTaskItem,
  type GoogleTaskList,
} from '../services/googleTasksService';
import { stripCitationMarkersForSpeech } from '../utils/passages';

interface GoogleTasksDrawerProps {
  open: boolean;
  briefing: AudioBriefing | null;
  stagedTakeawayIndices?: number[] | null;
  onClearStagedTakeaways?: () => void;
  onTasksCreated?: (tasks: GoogleTaskItem[], briefingId?: string) => void;
  onClose: () => void;
}

type TaskFilter = 'all' | 'active' | 'completed';

type PendingTaskConfirmation =
  | {
      kind: 'delete_task';
      task: GoogleTaskItem;
    }
  | {
      kind: 'clear_completed';
      completedCount: number;
      listTitle: string;
    }
  | {
      kind: 'update_task';
      task: GoogleTaskItem;
      nextTitle: string;
      nextNotes: string;
      nextDueDate: string;
    };

export function GoogleTasksDrawer({
  open,
  briefing,
  stagedTakeawayIndices,
  onClearStagedTakeaways,
  onTasksCreated,
  onClose,
}: GoogleTasksDrawerProps) {
  const {
    driveAccessToken,
    connectGoogleDrive,
    invalidateDriveAccessToken,
  } = useAuth();

  const [isConnecting, setIsConnecting] = useState(false);
  const [taskLists, setTaskLists] = useState<GoogleTaskList[]>([]);
  const [selectedListId, setSelectedListId] = useState<string>('');
  const [tasks, setTasks] = useState<GoogleTaskItem[]>([]);
  const [filter, setFilter] = useState<TaskFilter>('all');

  const [isLoadingLists, setIsLoadingLists] = useState(false);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [togglingTaskId, setTogglingTaskId] = useState<string | null>(null);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Staged briefing takeaways state
  const [selectedTakeawaySet, setSelectedTakeawaySet] = useState<Set<number>>(new Set());
  const [takeawayDueDate, setTakeawayDueDate] = useState<string>('');
  const [showTakeawayComposer, setShowTakeawayComposer] = useState(false);

  // Inline new task form
  const [newTitle, setNewTitle] = useState('');
  const [newDueDate, setNewDueDate] = useState('');
  const [newNotes, setNewNotes] = useState('');

  // Inline edit state
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editNotes, setEditNotes] = useState('');

  // Mandatory explicit confirmation dialog state
  const [pendingConfirm, setPendingConfirm] =
    useState<PendingTaskConfirmation | null>(null);

  // Sync staged takeaway selection whenever drawer opens or staged indices change
  useEffect(() => {
    if (!open || !briefing || briefing.takeaways.length === 0) {
      setShowTakeawayComposer(false);
      return;
    }
    if (stagedTakeawayIndices && stagedTakeawayIndices.length > 0) {
      setSelectedTakeawaySet(new Set(stagedTakeawayIndices));
      setShowTakeawayComposer(true);
    } else if (stagedTakeawayIndices !== null && stagedTakeawayIndices !== undefined) {
      // Empty array means open composer with all takeaways selected
      setSelectedTakeawaySet(new Set(briefing.takeaways.map((_, idx) => idx)));
      setShowTakeawayComposer(true);
    }
  }, [open, briefing, stagedTakeawayIndices]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isMutating) {
        if (pendingConfirm) {
          setPendingConfirm(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isMutating, pendingConfirm, onClose]);

  const loadTasksForList = useCallback(
    async (token: string, listId: string) => {
      if (!listId) return;
      setIsLoadingTasks(true);
      setErrorMessage(null);
      try {
        const items = await listGoogleTasks({
          accessToken: token,
          taskListId: listId,
          showCompleted: true,
        });
        setTasks(items);
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          invalidateDriveAccessToken();
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Could not load Google Tasks.'
          );
        }
      } finally {
        setIsLoadingTasks(false);
      }
    },
    [invalidateDriveAccessToken]
  );

  const loadListsAndTasks = useCallback(
    async (token: string) => {
      setIsLoadingLists(true);
      setErrorMessage(null);
      try {
        const lists = await listGoogleTaskLists(token);
        setTaskLists(lists);
        const preferred =
          lists.find((l) => l.title.trim().toLowerCase() === 'dispatch follow-ups') ||
          lists[0];
        const nextListId =
          selectedListId && lists.some((l) => l.id === selectedListId)
            ? selectedListId
            : preferred?.id || '';
        setSelectedListId(nextListId);
        if (nextListId) {
          await loadTasksForList(token, nextListId);
        } else {
          setTasks([]);
        }
      } catch (err) {
        if (err instanceof DriveAuthExpiredError) {
          invalidateDriveAccessToken();
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Could not load Google Task lists.'
          );
        }
      } finally {
        setIsLoadingLists(false);
      }
    },
    [invalidateDriveAccessToken, loadTasksForList, selectedListId]
  );

  useEffect(() => {
    if (!open || !driveAccessToken) return;
    void loadListsAndTasks(driveAccessToken);
  }, [open, driveAccessToken, loadListsAndTasks]);

  const activeListTitle = useMemo(() => {
    return (
      taskLists.find((l) => l.id === selectedListId)?.title || 'My Tasks'
    );
  }, [taskLists, selectedListId]);

  const completedTasksCount = useMemo(
    () => tasks.filter((t) => t.status === 'completed').length,
    [tasks]
  );
  const activeTasksCount = tasks.length - completedTasksCount;

  const visibleTasks = useMemo(() => {
    if (filter === 'active') return tasks.filter((t) => t.status !== 'completed');
    if (filter === 'completed') return tasks.filter((t) => t.status === 'completed');
    return tasks;
  }, [tasks, filter]);

  const handleConnect = async () => {
    setIsConnecting(true);
    setErrorMessage(null);
    try {
      await connectGoogleDrive();
    } finally {
      setIsConnecting(false);
    }
  };

  const handleEnsureDispatchList = async () => {
    if (!driveAccessToken || isMutating) return;
    setIsMutating(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const { lists, selectedList } = await ensureDispatchTaskList(
        driveAccessToken,
        'Dispatch Follow-Ups'
      );
      setTaskLists(lists);
      setSelectedListId(selectedList.id);
      setStatusMessage(`Active task list set to "${selectedList.title}".`);
      await loadTasksForList(driveAccessToken, selectedList.id);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not create Dispatch Follow-Ups list.'
        );
      }
    } finally {
      setIsMutating(false);
    }
  };

  const handleCreateManualTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!driveAccessToken || !newTitle.trim() || isMutating) return;

    setIsMutating(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      let targetListId = selectedListId;
      if (!targetListId) {
        const ensured = await ensureDispatchTaskList(
          driveAccessToken,
          'Dispatch Follow-Ups'
        );
        setTaskLists(ensured.lists);
        setSelectedListId(ensured.selectedList.id);
        targetListId = ensured.selectedList.id;
      }

      const created = await createGoogleTask({
        accessToken: driveAccessToken,
        taskListId: targetListId,
        title: newTitle.trim(),
        notes: newNotes.trim() || undefined,
        dueDate: newDueDate || undefined,
      });

      setNewTitle('');
      setNewDueDate('');
      setNewNotes('');
      setTasks((prev) => [created, ...prev]);
      setStatusMessage(`Added "${created.title}" to Google Tasks.`);
      onTasksCreated?.([created], briefing?.id);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not create Google Task.'
        );
      }
    } finally {
      setIsMutating(false);
    }
  };

  const handleCreateSelectedTakeawayTasks = async () => {
    if (
      !driveAccessToken ||
      !briefing ||
      selectedTakeawaySet.size === 0 ||
      isMutating
    ) {
      return;
    }

    setIsMutating(true);
    setErrorMessage(null);
    setStatusMessage('Creating follow-up tasks in Google Tasks...');
    try {
      const ensured = selectedListId
        ? null
        : await ensureDispatchTaskList(driveAccessToken, 'Dispatch Follow-Ups');
      const targetListId = selectedListId || ensured?.selectedList.id || '';
      if (ensured) {
        setTaskLists(ensured.lists);
        setSelectedListId(ensured.selectedList.id);
      }

      const orderedIndices = Array.from(selectedTakeawaySet).sort((a, b) => a - b);
      const created = await createTasksFromBriefingTakeaways({
        accessToken: driveAccessToken,
        taskListId: targetListId,
        briefing,
        takeawayIndices: orderedIndices,
        dueDate: takeawayDueDate || undefined,
      });

      setTasks((prev) => [...created, ...prev]);
      setStatusMessage(
        `Sent ${created.length} ${created.length === 1 ? 'takeaway' : 'takeaways'} to Google Tasks.`
      );
      setShowTakeawayComposer(false);
      onClearStagedTakeaways?.();
      onTasksCreated?.(created, briefing.id);
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error
            ? err.message
            : 'Could not send takeaways to Google Tasks.'
        );
      }
      setStatusMessage(null);
    } finally {
      setIsMutating(false);
    }
  };

  const handleToggleTask = async (task: GoogleTaskItem) => {
    if (!driveAccessToken || !selectedListId || togglingTaskId) return;
    const nextCompleted = task.status !== 'completed';
    setTogglingTaskId(task.id);
    setErrorMessage(null);
    try {
      const updated = await toggleGoogleTaskCompletion({
        accessToken: driveAccessToken,
        taskListId: selectedListId,
        taskId: task.id,
        completed: nextCompleted,
      });
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not update task status.'
        );
      }
    } finally {
      setTogglingTaskId(null);
    }
  };

  const beginEditTask = (task: GoogleTaskItem) => {
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditDueDate(toDateInputValue(task.due));
    setEditNotes(task.notes || '');
  };

  const requestSaveEditedTask = (task: GoogleTaskItem) => {
    if (!editTitle.trim()) return;
    setPendingConfirm({
      kind: 'update_task',
      task,
      nextTitle: editTitle.trim(),
      nextNotes: editNotes.trim(),
      nextDueDate: editDueDate,
    });
  };

  const executeConfirmedAction = async () => {
    if (!pendingConfirm || !driveAccessToken || !selectedListId) return;
    const action = pendingConfirm;
    setPendingConfirm(null);
    setIsMutating(true);
    setErrorMessage(null);

    try {
      if (action.kind === 'delete_task') {
        await deleteGoogleTask({
          accessToken: driveAccessToken,
          taskListId: selectedListId,
          taskId: action.task.id,
        });
        setTasks((prev) => prev.filter((t) => t.id !== action.task.id));
        setStatusMessage(`Deleted "${action.task.title}" from Google Tasks.`);
      } else if (action.kind === 'clear_completed') {
        await clearCompletedGoogleTasks({
          accessToken: driveAccessToken,
          taskListId: selectedListId,
        });
        await loadTasksForList(driveAccessToken, selectedListId);
        setStatusMessage(`Cleared completed tasks from "${action.listTitle}".`);
      } else if (action.kind === 'update_task') {
        const updated = await updateGoogleTask({
          accessToken: driveAccessToken,
          taskListId: selectedListId,
          taskId: action.task.id,
          title: action.nextTitle,
          notes: action.nextNotes,
          dueDate: action.nextDueDate || undefined,
        });
        setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        setEditingTaskId(null);
        setStatusMessage(`Updated "${updated.title}" in Google Tasks.`);
      }
    } catch (err) {
      if (err instanceof DriveAuthExpiredError) {
        invalidateDriveAccessToken();
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Google Tasks modification failed.'
        );
      }
    } finally {
      setIsMutating(false);
    }
  };

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-50 flex justify-end transition-opacity duration-180 ${
        open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}
    >
      <div
        onClick={isMutating ? undefined : onClose}
        aria-hidden="true"
        className="fixed inset-0 bg-black/70 backdrop-blur-xs"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Google Tasks Follow-Ups"
        className={`relative z-10 w-full max-w-lg h-full bg-[#13161C] border-l border-[#22D3EE]/35 shadow-2xl flex flex-col transition-transform duration-180 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Drawer Header */}
        <div className="px-5 py-4 border-b border-[#222833] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <ListChecks className="w-5 h-5 text-[#22D3EE] shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="font-serif text-lg font-medium text-[#F5F7FA] truncate">
                Google Tasks
              </h2>
              <p className="text-xs text-[#8C96A8] truncate">
                Turn briefing takeaways into action items with due dates and cited links.
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isMutating}
            onClick={onClose}
            aria-label="Close Google Tasks drawer"
            className="w-8 h-8 inline-flex items-center justify-center rounded-md text-[#A0AABB] hover:text-[#F5F7FA] hover:bg-[#1C222D] disabled:opacity-40 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {!driveAccessToken ? (
            <div className="py-10 px-5 bg-[#0E1116] border border-[#222833] rounded-lg text-center space-y-4">
              <CheckSquare className="w-8 h-8 text-[#22D3EE] mx-auto" aria-hidden="true" />
              <div className="space-y-1.5 max-w-sm mx-auto">
                <h3 className="font-serif text-lg font-medium text-[#F5F7FA]">
                  Connect Google Tasks
                </h3>
                <p className="text-xs text-[#A0AABB] leading-relaxed">
                  Sign in with Google so Dispatch can view and manage your Google Tasks lists and create follow-up items from your briefings, with your permission.
                </p>
              </div>
              <div className="pt-1 flex justify-center">
                <GoogleSignInButton
                  onClick={() => void handleConnect()}
                  disabled={isConnecting}
                  label={isConnecting ? 'Connecting Google Tasks...' : 'Sign in with Google'}
                />
              </div>
            </div>
          ) : (
            <>
              {/* Task List Selector & Dispatch Follow-Ups Quick List */}
              <div className="bg-[#0E1116] border border-[#222833] rounded-lg p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="google-tasks-list-select"
                    className="text-xs font-medium text-[#A0AABB]"
                  >
                    Task List
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isMutating || isLoadingLists}
                      onClick={() => void handleEnsureDispatchList()}
                      className="text-xs font-medium text-[#67E8F9] hover:underline whitespace-nowrap cursor-pointer"
                    >
                      Use &ldquo;Dispatch Follow-Ups&rdquo;
                    </button>
                    <button
                      type="button"
                      disabled={isLoadingLists || isLoadingTasks}
                      onClick={() => {
                        if (selectedListId) {
                          void loadTasksForList(driveAccessToken, selectedListId);
                        } else {
                          void loadListsAndTasks(driveAccessToken);
                        }
                      }}
                      aria-label="Refresh Google Tasks"
                      className="w-7 h-7 inline-flex items-center justify-center text-[#A0AABB] hover:text-[#F5F7FA] bg-[#13161C] border border-[#273040] rounded cursor-pointer"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          isLoadingLists || isLoadingTasks ? 'animate-spin text-[#22D3EE]' : ''
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <select
                  id="google-tasks-list-select"
                  value={selectedListId}
                  disabled={isLoadingLists}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setSelectedListId(nextId);
                    void loadTasksForList(driveAccessToken, nextId);
                  }}
                  className="w-full h-9 px-3 text-xs text-[#F5F7FA] bg-[#13161C] border border-[#273040] rounded-md focus:border-[#22D3EE]"
                >
                  {taskLists.length === 0 ? (
                    <option value="">No task lists loaded</option>
                  ) : (
                    taskLists.map((list) => (
                      <option key={list.id} value={list.id}>
                        {list.title}
                      </option>
                    ))
                  )}
                </select>
              </div>

              {/* Briefing Takeaways Composer */}
              {briefing && briefing.takeaways.length > 0 && (
                <section className="bg-[#0E1116] border border-[#22D3EE]/35 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-xs font-semibold text-[#F5F7FA] truncate">
                        Send Briefing Takeaways to Tasks
                      </h3>
                      <p className="text-[11px] text-[#8C96A8] truncate mt-0.5">
                        {briefing.editionTitle}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const nextOpen = !showTakeawayComposer;
                        setShowTakeawayComposer(nextOpen);
                        if (nextOpen && selectedTakeawaySet.size === 0) {
                          setSelectedTakeawaySet(
                            new Set(briefing.takeaways.map((_, idx) => idx))
                          );
                        }
                      }}
                      className="text-xs font-medium text-[#67E8F9] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {showTakeawayComposer ? 'Hide' : `Select (${briefing.takeaways.length})`}
                    </button>
                  </div>

                  {showTakeawayComposer && (
                    <div className="space-y-3 pt-2 border-t border-[#1E2430]">
                      <ul className="space-y-2 max-h-48 overflow-y-auto pr-1">
                        {briefing.takeaways.map((raw, idx) => {
                          const checked = selectedTakeawaySet.has(idx);
                          const clean = stripCitationMarkersForSpeech(raw).trim() || raw;
                          return (
                            <li key={idx}>
                              <label className="flex items-start gap-2.5 text-xs text-[#D5DCE6] cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setSelectedTakeawaySet((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(idx)) next.delete(idx);
                                      else next.add(idx);
                                      return next;
                                    });
                                  }}
                                  className="mt-0.5 accent-[#22D3EE] w-3.5 h-3.5 rounded shrink-0"
                                />
                                <span className="leading-relaxed">
                                  <span className="font-mono text-[#22D3EE] tabular-nums mr-1.5">
                                    {String(idx + 1).padStart(2, '0')}.
                                  </span>
                                  {clean}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>

                      <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                        <div className="flex items-center gap-2">
                          <label
                            htmlFor="takeaway-due-date"
                            className="text-[11px] text-[#8C96A8] whitespace-nowrap"
                          >
                            Due date
                          </label>
                          <input
                            id="takeaway-due-date"
                            type="date"
                            value={takeawayDueDate}
                            onChange={(e) => setTakeawayDueDate(e.target.value)}
                            className="h-8 px-2.5 text-xs font-mono text-[#F5F7FA] bg-[#13161C] border border-[#273040] rounded-md tabular-nums"
                          />
                        </div>

                        <button
                          type="button"
                          disabled={isMutating || selectedTakeawaySet.size === 0}
                          onClick={() => void handleCreateSelectedTakeawayTasks()}
                          className="h-8 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-45 rounded-md transition-colors whitespace-nowrap cursor-pointer tabular-nums"
                        >
                          {isMutating ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                          Create {selectedTakeawaySet.size}{' '}
                          {selectedTakeawaySet.size === 1 ? 'Task' : 'Tasks'}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* Quick Add Single Task Form */}
              <form
                onSubmit={(e) => void handleCreateManualTask(e)}
                className="bg-[#0E1116] border border-[#222833] rounded-lg p-3.5 space-y-2.5"
              >
                <label htmlFor="new-google-task-title" className="sr-only">
                  New follow-up task title
                </label>
                <input
                  id="new-google-task-title"
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Add a follow-up task..."
                  disabled={isMutating}
                  className="w-full h-9 px-3 text-xs text-[#F5F7FA] bg-[#13161C] border border-[#273040] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE]"
                />
                {newTitle.trim().length > 0 && (
                  <textarea
                    rows={2}
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    placeholder="Optional notes or source context..."
                    disabled={isMutating}
                    className="w-full p-2.5 text-xs text-[#F5F7FA] bg-[#13161C] border border-[#273040] rounded-md placeholder:text-[#6E788A] focus:border-[#22D3EE]"
                  />
                )}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5 text-[#6E788A]" aria-hidden="true" />
                    <input
                      type="date"
                      aria-label="Optional due date"
                      value={newDueDate}
                      onChange={(e) => setNewDueDate(e.target.value)}
                      className="h-8 px-2 text-xs font-mono text-[#A0AABB] bg-[#13161C] border border-[#273040] rounded tabular-nums"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isMutating || !newTitle.trim()}
                    className="h-8 px-3.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] disabled:opacity-40 rounded-md transition-colors whitespace-nowrap cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    Add Task
                  </button>
                </div>
              </form>

              {/* Filter & Clear Completed Strip */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div
                  role="tablist"
                  aria-label="Filter Google Tasks"
                  className="inline-flex items-center gap-1 p-1 bg-[#0E1116] border border-[#222833] rounded-md"
                >
                  {(
                    [
                      { id: 'all', label: `All (${tasks.length})` },
                      { id: 'active', label: `Active (${activeTasksCount})` },
                      { id: 'completed', label: `Done (${completedTasksCount})` },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={filter === item.id}
                      onClick={() => setFilter(item.id)}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors tabular-nums whitespace-nowrap cursor-pointer ${
                        filter === item.id
                          ? 'bg-[#182430] text-[#67E8F9]'
                          : 'text-[#8C96A8] hover:text-[#F5F7FA]'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {completedTasksCount > 0 && (
                  <button
                    type="button"
                    disabled={isMutating}
                    onClick={() =>
                      setPendingConfirm({
                        kind: 'clear_completed',
                        completedCount: completedTasksCount,
                        listTitle: activeListTitle,
                      })
                    }
                    className="text-xs font-medium text-[#8C96A8] hover:text-[#FCA5A5] whitespace-nowrap cursor-pointer"
                  >
                    Clear completed
                  </button>
                )}
              </div>

              {/* Tasks List */}
              {isLoadingTasks ? (
                <div className="py-10 flex flex-col items-center gap-2 text-xs text-[#8C96A8]">
                  <Loader2 className="w-5 h-5 animate-spin text-[#22D3EE]" />
                  <span>Loading tasks from {activeListTitle}...</span>
                </div>
              ) : visibleTasks.length === 0 ? (
                <div className="py-10 px-4 bg-[#0E1116] border border-[#222833] rounded-lg text-center">
                  <p className="text-sm font-medium text-[#F5F7FA]">
                    {filter === 'completed'
                      ? 'No completed tasks yet'
                      : 'No open tasks in this list'}
                  </p>
                  <p className="text-xs text-[#8C96A8] mt-1">
                    Add a task above or send takeaways directly from any Audio Briefing.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-[#1E2430] border border-[#222833] rounded-lg bg-[#0E1116]">
                  {visibleTasks.map((task) => {
                    const isCompleted = task.status === 'completed';
                    const isEditing = editingTaskId === task.id;
                    const dueLabel = formatTaskDueDateLabel(task.due);

                    return (
                      <li key={task.id} className="p-3.5">
                        {isEditing ? (
                          <div className="space-y-2.5">
                            <input
                              type="text"
                              value={editTitle}
                              onChange={(e) => setEditTitle(e.target.value)}
                              className="w-full h-8 px-2.5 text-xs text-[#F5F7FA] bg-[#13161C] border border-[#273040] rounded focus:border-[#22D3EE]"
                            />
                            <textarea
                              rows={3}
                              value={editNotes}
                              onChange={(e) => setEditNotes(e.target.value)}
                              placeholder="Task notes..."
                              className="w-full p-2.5 text-xs text-[#F5F7FA] bg-[#13161C] border border-[#273040] rounded focus:border-[#22D3EE]"
                            />
                            <div className="flex items-center justify-between gap-2">
                              <input
                                type="date"
                                value={editDueDate}
                                onChange={(e) => setEditDueDate(e.target.value)}
                                className="h-8 px-2 text-xs font-mono text-[#F5F7FA] bg-[#13161C] border border-[#273040] rounded tabular-nums"
                              />
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingTaskId(null)}
                                  className="h-8 px-3 text-xs text-[#A0AABB] hover:text-[#F5F7FA] cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={!editTitle.trim()}
                                  onClick={() => requestSaveEditedTask(task)}
                                  className="h-8 px-3 text-xs font-semibold text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9] rounded cursor-pointer"
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-3">
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={isCompleted}
                              aria-label={`Mark "${task.title}" as ${
                                isCompleted ? 'incomplete' : 'completed'
                              }`}
                              disabled={togglingTaskId === task.id}
                              onClick={() => void handleToggleTask(task)}
                              className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                                isCompleted
                                  ? 'bg-[#22D3EE] border-[#22D3EE] text-[#071318]'
                                  : 'bg-[#0B0D10] border-[#394457] hover:border-[#22D3EE]'
                              }`}
                            >
                              {togglingTaskId === task.id ? (
                                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                              ) : isCompleted ? (
                                <Check className="w-3 h-3" strokeWidth={2.75} />
                              ) : null}
                            </button>

                            <div className="flex-1 min-w-0">
                              <p
                                className={`text-xs sm:text-sm leading-snug ${
                                  isCompleted
                                    ? 'line-through text-[#6E788A]'
                                    : 'text-[#F5F7FA] font-medium'
                                }`}
                              >
                                {task.title}
                              </p>

                              {task.notes && (
                                <p className="mt-1 text-[11px] text-[#8C96A8] whitespace-pre-line line-clamp-3 leading-relaxed">
                                  {task.notes}
                                </p>
                              )}

                              {(dueLabel || task.webViewLink) && (
                                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] font-mono text-[#6E788A] tabular-nums">
                                  {dueLabel && <span className="text-[#67E8F9]">Due {dueLabel}</span>}
                                  {dueLabel && task.webViewLink && <span aria-hidden="true">·</span>}
                                  {task.webViewLink && (
                                    <a
                                      href={task.webViewLink}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-[#A0AABB] hover:text-[#67E8F9]"
                                    >
                                      Open in Tasks
                                      <ExternalLink className="w-3 h-3" aria-hidden="true" />
                                    </a>
                                  )}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => beginEditTask(task)}
                                aria-label={`Edit ${task.title}`}
                                className="p-1.5 text-[#6E788A] hover:text-[#67E8F9] rounded transition-colors cursor-pointer"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setPendingConfirm({ kind: 'delete_task', task })
                                }
                                aria-label={`Delete ${task.title}`}
                                className="p-1.5 text-[#6E788A] hover:text-[#F87171] rounded transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {statusMessage && (
            <p
              role="status"
              className="text-xs text-[#CFFAFE] bg-[#12202B] border border-[#22D3EE]/35 rounded-md px-3 py-2"
            >
              {statusMessage}
            </p>
          )}

          {errorMessage && (
            <p
              role="alert"
              className="text-xs text-[#FCA5A5] bg-[#3B1219] border border-[#F87171]/40 rounded-md px-3 py-2"
            >
              {errorMessage}
            </p>
          )}
        </div>

        {/* Mandatory Explicit Confirmation Dialog for Mutating / Destructive Task Operations */}
        {pendingConfirm && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm Google Tasks modification"
            className="absolute inset-0 z-20 bg-black/80 backdrop-blur-xs flex items-center justify-center p-5"
          >
            <div className="w-full max-w-sm bg-[#161A22] border border-amber-400/45 rounded-lg shadow-2xl p-5 space-y-4">
              <div className="flex items-start gap-3">
                <AlertTriangle
                  className="w-5 h-5 text-amber-300 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="space-y-1.5 min-w-0">
                  <h3 className="font-serif text-base font-medium text-[#F5F7FA]">
                    {pendingConfirm.kind === 'delete_task'
                      ? `Delete "${pendingConfirm.task.title}" from Google Tasks?`
                      : pendingConfirm.kind === 'clear_completed'
                        ? `Clear ${pendingConfirm.completedCount} completed ${
                            pendingConfirm.completedCount === 1 ? 'task' : 'tasks'
                          }?`
                        : `Update "${pendingConfirm.task.title}" in Google Tasks?`}
                  </h3>
                  <p className="text-xs text-[#C7D0DF] leading-relaxed">
                    {pendingConfirm.kind === 'delete_task'
                      ? 'This permanently removes the task from your Google Tasks list.'
                      : pendingConfirm.kind === 'clear_completed'
                        ? `Completed tasks in "${pendingConfirm.listTitle}" will be hidden and cleared in Google Tasks.`
                        : 'This overwrites the existing title, due date, and notes for this task in Google Tasks.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setPendingConfirm(null)}
                  className="h-8 px-3.5 text-xs font-medium text-[#C7D0DF] hover:text-[#F5F7FA] bg-[#0E1116] border border-[#2A3342] rounded-md cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void executeConfirmedAction()}
                  className={`h-8 px-3.5 text-xs font-semibold rounded-md cursor-pointer ${
                    pendingConfirm.kind === 'update_task'
                      ? 'text-[#071318] bg-[#22D3EE] hover:bg-[#67E8F9]'
                      : 'text-white bg-red-600 hover:bg-red-500'
                  }`}
                >
                  {pendingConfirm.kind === 'delete_task'
                    ? 'Delete Task'
                    : pendingConfirm.kind === 'clear_completed'
                      ? 'Clear Completed'
                      : 'Confirm Update'}
                </button>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
