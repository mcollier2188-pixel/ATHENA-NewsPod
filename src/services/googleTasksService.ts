import type { AudioBriefing, CitationRef } from '../types';
import { stripCitationMarkersForSpeech } from '../utils/passages';
import { DriveAuthExpiredError } from './googleDriveService';

const TASKS_API_BASE = 'https://tasks.googleapis.com/tasks/v1';

export interface GoogleTaskList {
  id: string;
  title: string;
  updated?: string;
}

export interface GoogleTaskItem {
  id: string;
  title: string;
  notes?: string;
  status: 'needsAction' | 'completed';
  due?: string;
  completed?: string;
  updated?: string;
  webViewLink?: string;
}

async function parseTasksError(res: Response): Promise<never> {
  let detail = '';
  try {
    const json = (await res.json()) as {
      error?: { message?: string; status?: string };
    };
    detail = json?.error?.message || '';
  } catch {
    // Ignore non-JSON body
  }

  if (res.status === 401) {
    throw new DriveAuthExpiredError(
      'Your Google Tasks session expired. Sign in with Google to reconnect.'
    );
  }
  if (
    res.status === 403 &&
    (detail.toLowerCase().includes('insufficient') ||
      detail.toLowerCase().includes('scope') ||
      detail.toLowerCase().includes('credential') ||
      detail.toLowerCase().includes('permission'))
  ) {
    throw new DriveAuthExpiredError(
      'Google Tasks permission is required. Sign in with Google to grant access.'
    );
  }
  throw new Error(detail || `Google Tasks request failed (HTTP ${res.status}).`);
}

export function normalizeDateInputToRfc3339(dateStr?: string): string | undefined {
  if (!dateStr || !dateStr.trim()) return undefined;
  const trimmed = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T09:00:00.000Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export function formatTaskDueDateLabel(rfc3339?: string): string {
  if (!rfc3339) return '';
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function toDateInputValue(rfc3339?: string): string {
  if (!rfc3339) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(rfc3339);
  if (match) return match[1];
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export async function listGoogleTaskLists(
  accessToken: string
): Promise<GoogleTaskList[]> {
  const res = await fetch(`${TASKS_API_BASE}/users/@me/lists?maxResults=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await parseTasksError(res);
  const data = (await res.json()) as { items?: GoogleTaskList[] };
  return data.items ?? [];
}

export async function createGoogleTaskList(
  accessToken: string,
  title = 'Dispatch Follow-Ups'
): Promise<GoogleTaskList> {
  const res = await fetch(`${TASKS_API_BASE}/users/@me/lists`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: title.trim() || 'Dispatch Follow-Ups' }),
  });
  if (!res.ok) await parseTasksError(res);
  return (await res.json()) as GoogleTaskList;
}

export async function ensureDispatchTaskList(
  accessToken: string,
  preferredTitle = 'Dispatch Follow-Ups'
): Promise<{ lists: GoogleTaskList[]; selectedList: GoogleTaskList }> {
  const existing = await listGoogleTaskLists(accessToken);
  const match = existing.find(
    (l) => l.title.trim().toLowerCase() === preferredTitle.trim().toLowerCase()
  );
  if (match) {
    return { lists: existing, selectedList: match };
  }
  const created = await createGoogleTaskList(accessToken, preferredTitle);
  return { lists: [created, ...existing], selectedList: created };
}

export async function listGoogleTasks(params: {
  accessToken: string;
  taskListId: string;
  showCompleted?: boolean;
}): Promise<GoogleTaskItem[]> {
  const { accessToken, taskListId, showCompleted = true } = params;
  const url = new URL(
    `${TASKS_API_BASE}/lists/${encodeURIComponent(taskListId)}/tasks`
  );
  url.searchParams.set('maxResults', '100');
  url.searchParams.set('showCompleted', showCompleted ? 'true' : 'false');
  url.searchParams.set('showHidden', showCompleted ? 'true' : 'false');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await parseTasksError(res);
  const data = (await res.json()) as { items?: GoogleTaskItem[] };
  return (data.items ?? []).filter((t) => Boolean(t.title?.trim()));
}

export async function createGoogleTask(params: {
  accessToken: string;
  taskListId: string;
  title: string;
  notes?: string;
  dueDate?: string;
}): Promise<GoogleTaskItem> {
  const { accessToken, taskListId, title, notes, dueDate } = params;
  const payload: Record<string, unknown> = {
    title: title.trim().slice(0, 900),
  };
  if (notes && notes.trim()) {
    payload.notes = notes.trim().slice(0, 7500);
  }
  const rfcDue = normalizeDateInputToRfc3339(dueDate);
  if (rfcDue) {
    payload.due = rfcDue;
  }

  const res = await fetch(
    `${TASKS_API_BASE}/lists/${encodeURIComponent(taskListId)}/tasks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) await parseTasksError(res);
  return (await res.json()) as GoogleTaskItem;
}

export function buildTakeawayTaskNotes(params: {
  briefing: AudioBriefing;
  rawTakeaway: string;
}): string {
  const { briefing, rawTakeaway } = params;
  const lines: string[] = [
    `From Dispatch Briefing: ${briefing.editionTitle}`,
  ];

  // Extract cited source titles referenced by [n] markers in this takeaway
  const markerMatches = Array.from(rawTakeaway.matchAll(/\[(\d+)\]/g)).map((m) =>
    Number(m[1])
  );
  const citations: CitationRef[] = briefing.takeawayCitations ?? [];
  const matchedSources = Array.from(
    new Set(
      markerMatches
        .map((marker) => citations.find((c) => c.marker === marker)?.sourceTitle)
        .filter((s): s is string => Boolean(s))
    )
  );

  if (matchedSources.length > 0) {
    lines.push(`Cited Sources: ${matchedSources.join(' · ')}`);
  } else if (briefing.articleTitles.length > 0) {
    lines.push(`Edition Sources: ${briefing.articleTitles.slice(0, 4).join(' · ')}`);
  }

  if (briefing.exportedDocUrl) {
    lines.push(`Google Doc Transcript: ${briefing.exportedDocUrl}`);
  }
  if (briefing.exportedWavUrl) {
    lines.push(`Drive Audio (.WAV): ${briefing.exportedWavUrl}`);
  }

  return lines.join('\n');
}

export async function createTasksFromBriefingTakeaways(params: {
  accessToken: string;
  taskListId: string;
  briefing: AudioBriefing;
  takeawayIndices: number[];
  dueDate?: string;
}): Promise<GoogleTaskItem[]> {
  const { accessToken, taskListId, briefing, takeawayIndices, dueDate } = params;
  const created: GoogleTaskItem[] = [];

  for (const idx of takeawayIndices) {
    const raw = briefing.takeaways[idx];
    if (!raw) continue;
    const cleanTitle = stripCitationMarkersForSpeech(raw).trim() || raw.trim();
    const notes = buildTakeawayTaskNotes({ briefing, rawTakeaway: raw });
    const item = await createGoogleTask({
      accessToken,
      taskListId,
      title: cleanTitle,
      notes,
      dueDate,
    });
    created.push(item);
  }

  return created;
}

export async function toggleGoogleTaskCompletion(params: {
  accessToken: string;
  taskListId: string;
  taskId: string;
  completed: boolean;
}): Promise<GoogleTaskItem> {
  const { accessToken, taskListId, taskId, completed } = params;
  const body: Record<string, unknown> = {
    id: taskId,
    status: completed ? 'completed' : 'needsAction',
    completed: completed ? new Date().toISOString() : null,
  };

  const res = await fetch(
    `${TASKS_API_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) await parseTasksError(res);
  return (await res.json()) as GoogleTaskItem;
}

export async function updateGoogleTask(params: {
  accessToken: string;
  taskListId: string;
  taskId: string;
  title: string;
  notes?: string;
  dueDate?: string;
}): Promise<GoogleTaskItem> {
  const { accessToken, taskListId, taskId, title, notes, dueDate } = params;
  const rfcDue = normalizeDateInputToRfc3339(dueDate);
  const body: Record<string, unknown> = {
    id: taskId,
    title: title.trim().slice(0, 900),
    notes: notes ? notes.trim().slice(0, 7500) : '',
    due: rfcDue ?? null,
  };

  const res = await fetch(
    `${TASKS_API_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) await parseTasksError(res);
  return (await res.json()) as GoogleTaskItem;
}

export async function deleteGoogleTask(params: {
  accessToken: string;
  taskListId: string;
  taskId: string;
}): Promise<void> {
  const { accessToken, taskListId, taskId } = params;
  const res = await fetch(
    `${TASKS_API_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) await parseTasksError(res);
}

export async function clearCompletedGoogleTasks(params: {
  accessToken: string;
  taskListId: string;
}): Promise<void> {
  const { accessToken, taskListId } = params;
  const res = await fetch(
    `${TASKS_API_BASE}/lists/${encodeURIComponent(taskListId)}/clear`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) await parseTasksError(res);
}
