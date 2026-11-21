import type { AudioBriefing } from '../types';

export type DriveFileFilter = 'importable' | 'docs' | 'audio' | 'folders' | 'all';

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  iconLink?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  parents?: string[];
}

export interface DriveActivityItem {
  id: string;
  timestamp: string;
  actionLabel: string;
  targetName: string;
  targetFileId: string | null;
  targetMimeType?: string;
}

export class DriveAuthExpiredError extends Error {
  constructor(
    message = 'Your Google Workspace session expired or needs permission. Please sign in with Google again.'
  ) {
    super(message);
    this.name = 'DriveAuthExpiredError';
  }
}

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_ACTIVITY_URL = 'https://driveactivity.googleapis.com/v2/activity:query';
const DOCS_API_BASE = 'https://docs.googleapis.com/v1/documents';

export const IMPORTABLE_DRIVE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

export function isImportableDriveFile(file: DriveFileItem): boolean {
  if (IMPORTABLE_DRIVE_MIME_TYPES.has(file.mimeType)) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith('.pdf') ||
    lower.endsWith('.docx') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.markdown')
  );
}

export function formatDriveMimeLabel(mimeType: string, fileName = ''): string {
  switch (mimeType) {
    case 'application/vnd.google-apps.document':
      return 'Google Doc';
    case 'application/vnd.google-apps.spreadsheet':
      return 'Google Sheet';
    case 'application/vnd.google-apps.presentation':
      return 'Google Slides';
    case 'application/vnd.google-apps.folder':
      return 'Folder';
    case 'application/pdf':
      return 'PDF';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'DOCX';
    case 'text/markdown':
      return 'Markdown';
    case 'text/plain':
      return fileName.toLowerCase().endsWith('.md') ? 'Markdown' : 'Text';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'WAV Audio';
    case 'audio/mpeg':
      return 'MP3 Audio';
    default:
      if (mimeType.startsWith('audio/')) return 'Audio';
      if (mimeType.startsWith('image/')) return 'Image';
      if (mimeType.startsWith('video/')) return 'Video';
      return 'Drive File';
  }
}

export function formatDriveBytes(sizeStr?: string): string {
  const bytes = Number(sizeStr);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeDriveQueryLiteral(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function parseWorkspaceError(res: Response, serviceLabel = 'Google Drive'): Promise<never> {
  let detail = '';
  try {
    const json = (await res.json()) as {
      error?: { message?: string; status?: string };
    };
    detail = json?.error?.message || '';
  } catch {
    // Ignore non-JSON error body
  }

  if (res.status === 401) {
    throw new DriveAuthExpiredError(
      `Your ${serviceLabel} access token expired. Sign in with Google to reconnect.`
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
      `Additional ${serviceLabel} permission is required. Sign in with Google to grant access.`
    );
  }
  throw new Error(detail || `${serviceLabel} request failed (HTTP ${res.status}).`);
}

export async function listDriveFiles(params: {
  accessToken: string;
  searchQuery?: string;
  filter?: DriveFileFilter;
  folderId?: string | null;
  pageSize?: number;
}): Promise<DriveFileItem[]> {
  const {
    accessToken,
    searchQuery = '',
    filter = 'importable',
    folderId = null,
    pageSize = 30,
  } = params;

  const clauses: string[] = ['trashed = false'];

  if (folderId) {
    clauses.push(`'${escapeDriveQueryLiteral(folderId)}' in parents`);
  }

  const trimmedSearch = searchQuery.trim();
  if (trimmedSearch) {
    clauses.push(`name contains '${escapeDriveQueryLiteral(trimmedSearch)}'`);
  }

  if (filter === 'importable') {
    clauses.push(
      '(' +
        [
          "mimeType = 'application/vnd.google-apps.document'",
          "mimeType = 'application/vnd.google-apps.presentation'",
          "mimeType = 'application/vnd.google-apps.spreadsheet'",
          "mimeType = 'application/pdf'",
          "mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'",
          "mimeType = 'text/plain'",
          "mimeType = 'text/markdown'",
          "mimeType = 'application/vnd.google-apps.folder'",
        ].join(' or ') +
        ')'
    );
  } else if (filter === 'docs') {
    clauses.push(
      "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.google-apps.folder')"
    );
  } else if (filter === 'audio') {
    clauses.push(
      "(mimeType contains 'audio/' or mimeType = 'application/vnd.google-apps.folder')"
    );
  } else if (filter === 'folders') {
    clauses.push("mimeType = 'application/vnd.google-apps.folder'");
  }

  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set('q', clauses.join(' and '));
  url.searchParams.set(
    'fields',
    'files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink,owners(displayName,emailAddress),parents)'
  );
  url.searchParams.set('orderBy', 'folder,modifiedTime desc');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    await parseWorkspaceError(res, 'Google Drive');
  }

  const data = (await res.json()) as { files?: DriveFileItem[] };
  return data.files ?? [];
}

export async function fetchRecentDriveActivity(
  accessToken: string,
  pageSize = 12
): Promise<DriveActivityItem[]> {
  const res = await fetch(DRIVE_ACTIVITY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pageSize }),
  });

  if (res.status === 401) {
    throw new DriveAuthExpiredError();
  }
  if (!res.ok) {
    return [];
  }

  const data = (await res.json()) as {
    activities?: Array<{
      timestamp?: string;
      timeRange?: { endTime?: string };
      primaryActionDetail?: Record<string, unknown>;
      targets?: Array<{
        driveItem?: {
          name?: string;
          title?: string;
          mimeType?: string;
        };
      }>;
    }>;
  };

  const items: DriveActivityItem[] = [];
  for (const [idx, act] of (data.activities ?? []).entries()) {
    const detailKeys = Object.keys(act.primaryActionDetail ?? {});
    const primaryKey = detailKeys[0] || 'edit';
    const actionMap: Record<string, string> = {
      create: 'Created',
      edit: 'Edited',
      move: 'Moved',
      rename: 'Renamed',
      delete: 'Moved to trash',
      restore: 'Restored',
      permissionChange: 'Updated sharing',
      comment: 'Commented on',
    };
    const actionLabel = actionMap[primaryKey] || 'Updated';
    const driveItem = act.targets?.[0]?.driveItem;
    const rawItemName = driveItem?.name || '';
    const targetFileId = rawItemName.startsWith('items/')
      ? rawItemName.slice('items/'.length)
      : null;

    items.push({
      id: `${targetFileId || 'act'}-${idx}-${act.timestamp || ''}`,
      timestamp: act.timestamp || act.timeRange?.endTime || new Date().toISOString(),
      actionLabel,
      targetName: driveItem?.title || 'Untitled Drive item',
      targetFileId,
      targetMimeType: driveItem?.mimeType,
    });
  }
  return items;
}

interface GoogleDocParagraphElement {
  textRun?: { content?: string };
}

interface GoogleDocStructuralElement {
  endIndex?: number;
  paragraph?: {
    elements?: GoogleDocParagraphElement[];
    paragraphStyle?: { namedStyleType?: string };
    bullet?: { listId?: string; nestingLevel?: number };
  };
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{
        content?: GoogleDocStructuralElement[];
      }>;
    }>;
  };
}

function extractTextFromStructuralElements(
  elements: GoogleDocStructuralElement[] | undefined
): string {
  if (!elements || elements.length === 0) return '';
  const blocks: string[] = [];

  for (const el of elements) {
    if (el.paragraph) {
      const rawLine = (el.paragraph.elements ?? [])
        .map((pe) => pe.textRun?.content ?? '')
        .join('')
        .replace(/\r/g, '')
        .replace(/\n+$/, '')
        .trim();
      if (!rawLine) continue;

      const style = el.paragraph.paragraphStyle?.namedStyleType || '';
      if (style === 'TITLE' || style === 'HEADING_1') {
        blocks.push(`# ${rawLine}`);
      } else if (style === 'SUBTITLE' || style === 'HEADING_2') {
        blocks.push(`## ${rawLine}`);
      } else if (style === 'HEADING_3' || style === 'HEADING_4') {
        blocks.push(`### ${rawLine}`);
      } else if (el.paragraph.bullet) {
        blocks.push(`- ${rawLine}`);
      } else {
        blocks.push(rawLine);
      }
    } else if (el.table?.tableRows) {
      const rowsText: string[] = [];
      for (const row of el.table.tableRows) {
        const cellValues = (row.tableCells ?? [])
          .map((cell) =>
            extractTextFromStructuralElements(cell.content)
              .replace(/\s+/g, ' ')
              .trim()
          )
          .filter(Boolean);
        if (cellValues.length > 0) {
          rowsText.push(cellValues.join(' | '));
        }
      }
      if (rowsText.length > 0) {
        blocks.push(rowsText.join('\n'));
      }
    }
  }

  return blocks.join('\n\n');
}

/**
 * Reads structured headings, paragraphs, bullets, and tables directly via Google Docs API v1
 * so imported Google Docs preserve clean passage breaks for Dispatch citations.
 */
export async function readStructuredGoogleDocText(
  accessToken: string,
  documentId: string
): Promise<string | null> {
  const res = await fetch(`${DOCS_API_BASE}/${encodeURIComponent(documentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    throw new DriveAuthExpiredError(
      'Your Google Docs session expired. Sign in with Google to reconnect.'
    );
  }
  if (!res.ok) {
    return null;
  }

  const docJson = (await res.json()) as {
    title?: string;
    body?: { content?: GoogleDocStructuralElement[] };
  };
  const extracted = extractTextFromStructuralElements(docJson.body?.content);
  if (!extracted.trim()) return null;
  return extracted;
}

export async function downloadDriveFileAsBrowserFile(
  accessToken: string,
  item: DriveFileItem
): Promise<File> {
  // Native Google Docs: try structured Google Docs API v1 first for clean markdown/passage hierarchy,
  // then fall back to Drive text/plain export if Docs API is unavailable for the file.
  if (item.mimeType === 'application/vnd.google-apps.document') {
    const structured = await readStructuredGoogleDocText(accessToken, item.id).catch((err) => {
      if (err instanceof DriveAuthExpiredError) throw err;
      return null;
    });

    if (structured && structured.trim().length > 0) {
      const baseName = item.name.replace(/\.(md|markdown|txt)$/i, '');
      return new File([structured], `${baseName}.md`, { type: 'text/markdown' });
    }

    const exportUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(item.id)}/export?mimeType=text/plain`;
    const res = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) await parseWorkspaceError(res, 'Google Drive');
    const text = await res.text();
    const safeName = item.name.endsWith('.txt') ? item.name : `${item.name}.txt`;
    return new File([text], safeName, { type: 'text/plain' });
  }

  if (item.mimeType === 'application/vnd.google-apps.presentation') {
    const exportUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(item.id)}/export?mimeType=text/plain`;
    const res = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) await parseWorkspaceError(res, 'Google Drive');
    const text = await res.text();
    const safeName = item.name.endsWith('.txt') ? item.name : `${item.name}.txt`;
    return new File([text], safeName, { type: 'text/plain' });
  }

  if (item.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const exportUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(item.id)}/export?mimeType=text/csv`;
    const res = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) await parseWorkspaceError(res, 'Google Drive');
    const csvText = await res.text();
    const safeName = item.name.replace(/\.csv$/i, '') + '.txt';
    return new File([csvText], safeName, { type: 'text/plain' });
  }

  // Binary or plain files (PDF, DOCX, TXT, MD)
  const downloadUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await parseWorkspaceError(res, 'Google Drive');
  const blob = await res.blob();

  const resolvedMime = item.mimeType || blob.type || 'text/plain';
  let resolvedName = item.name;
  const lower = resolvedName.toLowerCase();

  if (resolvedMime === 'application/pdf' && !lower.endsWith('.pdf')) {
    resolvedName = `${resolvedName}.pdf`;
  } else if (
    resolvedMime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    !lower.endsWith('.docx')
  ) {
    resolvedName = `${resolvedName}.docx`;
  } else if (
    resolvedMime === 'text/markdown' &&
    !lower.endsWith('.md') &&
    !lower.endsWith('.markdown')
  ) {
    resolvedName = `${resolvedName}.md`;
  } else if (
    resolvedMime === 'text/plain' &&
    !lower.endsWith('.txt') &&
    !lower.endsWith('.md') &&
    !lower.endsWith('.markdown')
  ) {
    resolvedName = `${resolvedName}.txt`;
  }

  return new File([blob], resolvedName, { type: resolvedMime });
}

export async function ensureDispatchDriveFolder(
  accessToken: string,
  folderName = 'Dispatch Studio'
): Promise<DriveFileItem> {
  const existingQuery = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${escapeDriveQueryLiteral(folderName)}'`,
    'trashed = false',
  ].join(' and ');

  const searchUrl = new URL(`${DRIVE_API_BASE}/files`);
  searchUrl.searchParams.set('q', existingQuery);
  searchUrl.searchParams.set('fields', 'files(id,name,mimeType,webViewLink)');
  searchUrl.searchParams.set('pageSize', '1');

  const searchRes = await fetch(searchUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!searchRes.ok) await parseWorkspaceError(searchRes, 'Google Drive');
  const searchData = (await searchRes.json()) as { files?: DriveFileItem[] };
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0];
  }

  const createRes = await fetch(
    `${DRIVE_API_BASE}/files?fields=id,name,mimeType,webViewLink`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    }
  );
  if (!createRes.ok) await parseWorkspaceError(createRes, 'Google Drive');
  return (await createRes.json()) as DriveFileItem;
}

interface FormattedDocBuildResult {
  fullText: string;
  requests: Array<Record<string, unknown>>;
}

/**
 * Builds deterministic Google Docs API v1 batchUpdate requests with UTF-16 code unit indices
 * (Google Docs body content starts at index 1).
 */
function buildGoogleDocsBatchRequests(briefing: AudioBriefing): FormattedDocBuildResult {
  let cursor = 1;
  const chunks: string[] = [];
  const styleOps: Array<Record<string, unknown>> = [];

  const appendParagraph = (
    rawText: string,
    options?: {
      namedStyle?: 'TITLE' | 'SUBTITLE' | 'HEADING_2' | 'NORMAL_TEXT';
      boldPrefixLength?: number;
      italicLine?: boolean;
    }
  ): { start: number; end: number } => {
    const clean = (rawText || ' ').replace(/\r/g, '');
    const textWithNewline = `${clean}\n`;
    const start = cursor;
    const end = cursor + textWithNewline.length;
    chunks.push(textWithNewline);
    cursor = end;

    if (options?.namedStyle && options.namedStyle !== 'NORMAL_TEXT') {
      styleOps.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end },
          paragraphStyle: { namedStyleType: options.namedStyle },
          fields: 'namedStyleType',
        },
      });
    }

    if (options?.boldPrefixLength && options.boldPrefixLength > 0 && clean.length > 0) {
      styleOps.push({
        updateTextStyle: {
          range: {
            startIndex: start,
            endIndex: Math.min(end - 1, start + options.boldPrefixLength),
          },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    }

    if (options?.italicLine && clean.length > 0) {
      styleOps.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: end - 1 },
          textStyle: { italic: true },
          fields: 'italic',
        },
      });
    }

    return { start, end };
  };

  // Title & Edition Metadata
  appendParagraph(briefing.editionTitle || 'Dispatch Briefing', {
    namedStyle: 'TITLE',
  });
  if (briefing.editionSubtitle) {
    appendParagraph(briefing.editionSubtitle, { namedStyle: 'SUBTITLE' });
  }
  const createdDate = new Date(briefing.createdAt).toLocaleString();
  const formatLabel =
    briefing.preferences.format === 'podcast' ? 'Two-Host Podcast' : 'Solo Anchor';
  appendParagraph(
    `Dispatch Studio Edition · ${createdDate} · ${formatLabel} · ${briefing.segments.length} chapters`,
    { italicLine: true }
  );
  appendParagraph(' ');

  // Executive Key Takeaways (with native bullet list formatting)
  if (briefing.takeaways.length > 0) {
    appendParagraph('Key Takeaways', { namedStyle: 'HEADING_2' });
    let bulletStart = -1;
    let bulletEnd = -1;
    for (const point of briefing.takeaways) {
      const range = appendParagraph(point);
      if (bulletStart === -1) bulletStart = range.start;
      bulletEnd = range.end;
    }
    if (bulletStart !== -1 && bulletEnd > bulletStart) {
      styleOps.push({
        createParagraphBullets: {
          range: { startIndex: bulletStart, endIndex: bulletEnd },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    }
    appendParagraph(' ');
  }

  // Indexed Sources
  if (briefing.articleTitles.length > 0) {
    appendParagraph('Sources Indexed', { namedStyle: 'HEADING_2' });
    briefing.articleTitles.forEach((srcTitle, idx) => {
      const prefix = `${idx + 1}. `;
      appendParagraph(`${prefix}${srcTitle}`, { boldPrefixLength: prefix.length });
    });
    appendParagraph(' ');
  }

  // Broadcast Chapters & Speaker Script
  briefing.segments.forEach((seg, idx) => {
    appendParagraph(`Chapter ${idx + 1}: ${seg.title}`, {
      namedStyle: 'HEADING_2',
    });
    appendParagraph(`${seg.category} · Key Point: ${seg.keyPoint}`, {
      italicLine: true,
    });
    for (const line of seg.lines) {
      const speakerPrefix = `${line.speaker}: `;
      appendParagraph(`${speakerPrefix}${line.text}`, {
        boldPrefixLength: speakerPrefix.length,
      });
    }
    appendParagraph(' ');
  });

  const fullText = chunks.join('');
  const requests: Array<Record<string, unknown>> = [
    {
      insertText: {
        location: { index: 1 },
        text: fullText,
      },
    },
    ...styleOps,
  ];

  return { fullText, requests };
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBriefingHtmlDocument(briefing: AudioBriefing): string {
  const createdDate = new Date(briefing.createdAt).toLocaleString();
  const takeawaysHtml =
    briefing.takeaways.length > 0
      ? `<h2>Key Takeaways</h2><ul>${briefing.takeaways
          .map((t) => `<li>${escapeHtml(t)}</li>`)
          .join('')}</ul>`
      : '';

  const sourcesHtml =
    briefing.articleTitles.length > 0
      ? `<h2>Sources Indexed</h2><ol>${briefing.articleTitles
          .map((s) => `<li>${escapeHtml(s)}</li>`)
          .join('')}</ol>`
      : '';

  const chaptersHtml = briefing.segments
    .map((seg, idx) => {
      const linesHtml = seg.lines
        .map(
          (line) =>
            `<p><strong>${escapeHtml(line.speaker)}:</strong> ${escapeHtml(line.text)}</p>`
        )
        .join('');
      return `
        <hr />
        <h2>Chapter ${idx + 1}: ${escapeHtml(seg.title)}</h2>
        <p><em>${escapeHtml(seg.category)} · Key Point: ${escapeHtml(seg.keyPoint)}</em></p>
        ${linesHtml}
      `;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8" /><title>${escapeHtml(briefing.editionTitle)}</title></head>
  <body>
    <h1>${escapeHtml(briefing.editionTitle)}</h1>
    <p><strong>${escapeHtml(briefing.editionSubtitle)}</strong></p>
    <p>Generated in Dispatch Studio · ${escapeHtml(createdDate)} · ${
      briefing.preferences.format === 'podcast' ? 'Two-Host Podcast' : 'Solo Anchor'
    }</p>
    ${takeawaysHtml}
    ${sourcesHtml}
    ${chaptersHtml}
  </body>
</html>`;
}

async function uploadBriefingDocViaMultipartFallback(params: {
  accessToken: string;
  briefing: AudioBriefing;
  parentFolderId?: string | null;
  overwriteFileId?: string | null;
}): Promise<DriveFileItem> {
  const { accessToken, briefing, parentFolderId, overwriteFileId } = params;
  const htmlBody = buildBriefingHtmlDocument(briefing);
  const boundary = `dispatch_boundary_${Date.now().toString(36)}`;

  const metadata: Record<string, unknown> = {
    name: briefing.editionTitle || 'Dispatch Briefing',
    mimeType: 'application/vnd.google-apps.document',
  };
  if (!overwriteFileId && parentFolderId) {
    metadata.parents = [parentFolderId];
  }

  const multipartBody = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`,
      htmlBody,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );

  const endpoint = overwriteFileId
    ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(overwriteFileId)}?uploadType=multipart&fields=id,name,mimeType,webViewLink,modifiedTime`
    : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,modifiedTime`;

  const res = await fetch(endpoint, {
    method: overwriteFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!res.ok) await parseWorkspaceError(res, 'Google Drive');
  return (await res.json()) as DriveFileItem;
}

/**
 * Creates or updates a richly formatted native Google Doc using Google Docs API v1
 * (`documents.create` + `documents.batchUpdate`) and places it in the target Drive folder.
 */
export async function uploadBriefingDocToDrive(params: {
  accessToken: string;
  briefing: AudioBriefing;
  parentFolderId?: string | null;
  overwriteFileId?: string | null;
}): Promise<DriveFileItem> {
  const { accessToken, briefing, parentFolderId, overwriteFileId } = params;
  const docTitle = briefing.editionTitle || 'Dispatch Briefing';
  const { requests } = buildGoogleDocsBatchRequests(briefing);

  try {
    let targetDocId = overwriteFileId || '';
    const preRequests: Array<Record<string, unknown>> = [];

    if (targetDocId) {
      // Inspect existing Google Doc endIndex so we can replace its body cleanly
      const existingRes = await fetch(
        `${DOCS_API_BASE}/${encodeURIComponent(targetDocId)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (existingRes.status === 401) {
        await parseWorkspaceError(existingRes, 'Google Docs');
      }
      if (!existingRes.ok) {
        // Target file may not be a native Google Doc; use multipart fallback
        return await uploadBriefingDocViaMultipartFallback(params);
      }
      const existingJson = (await existingRes.json()) as {
        body?: { content?: GoogleDocStructuralElement[] };
      };
      const contentArr = existingJson.body?.content ?? [];
      const lastEndIndex =
        contentArr.length > 0
          ? contentArr[contentArr.length - 1]?.endIndex ?? 1
          : 1;
      if (lastEndIndex > 2) {
        preRequests.push({
          deleteContentRange: {
            range: { startIndex: 1, endIndex: lastEndIndex - 1 },
          },
        });
      }
    } else {
      const createRes = await fetch(DOCS_API_BASE, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: docTitle }),
      });
      if (createRes.status === 401) {
        await parseWorkspaceError(createRes, 'Google Docs');
      }
      if (!createRes.ok) {
        return await uploadBriefingDocViaMultipartFallback(params);
      }
      const createdDoc = (await createRes.json()) as { documentId?: string };
      if (!createdDoc.documentId) {
        return await uploadBriefingDocViaMultipartFallback(params);
      }
      targetDocId = createdDoc.documentId;
    }

    const batchRes = await fetch(
      `${DOCS_API_BASE}/${encodeURIComponent(targetDocId)}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [...preRequests, ...requests],
        }),
      }
    );

    if (!batchRes.ok) {
      await parseWorkspaceError(batchRes, 'Google Docs');
    }

    // Move newly created Google Doc into Dispatch Studio folder (if requested) and fetch Drive metadata
    const drivePatchUrl = new URL(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(targetDocId)}`
    );
    drivePatchUrl.searchParams.set(
      'fields',
      'id,name,mimeType,webViewLink,modifiedTime,parents'
    );
    if (!overwriteFileId && parentFolderId) {
      drivePatchUrl.searchParams.set('addParents', parentFolderId);
    }

    const metaRes = await fetch(drivePatchUrl.toString(), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: docTitle }),
    });

    if (metaRes.ok) {
      return (await metaRes.json()) as DriveFileItem;
    }

    return {
      id: targetDocId,
      name: docTitle,
      mimeType: 'application/vnd.google-apps.document',
      webViewLink: `https://docs.google.com/document/d/${encodeURIComponent(targetDocId)}/edit`,
      modifiedTime: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof DriveAuthExpiredError) {
      throw err;
    }
    return await uploadBriefingDocViaMultipartFallback(params);
  }
}

export async function uploadWavEpisodeToDrive(params: {
  accessToken: string;
  fileName: string;
  wavBlob: Blob;
  parentFolderId?: string | null;
  overwriteFileId?: string | null;
}): Promise<DriveFileItem> {
  const { accessToken, fileName, wavBlob, parentFolderId, overwriteFileId } = params;
  const boundary = `dispatch_wav_${Date.now().toString(36)}`;

  const metadata: Record<string, unknown> = {
    name: fileName.endsWith('.wav') ? fileName : `${fileName}.wav`,
    mimeType: 'audio/wav',
  };
  if (!overwriteFileId && parentFolderId) {
    metadata.parents = [parentFolderId];
  }

  const multipartBody = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: audio/wav\r\n\r\n`,
      wavBlob,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );

  const endpoint = overwriteFileId
    ? `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(overwriteFileId)}?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,modifiedTime`
    : `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,modifiedTime`;

  const res = await fetch(endpoint, {
    method: overwriteFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!res.ok) await parseWorkspaceError(res, 'Google Drive');
  return (await res.json()) as DriveFileItem;
}

export async function moveDriveFilesToTrash(params: {
  accessToken: string;
  fileIds: string[];
}): Promise<void> {
  const { accessToken, fileIds } = params;
  for (const fileId of fileIds) {
    const res = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ trashed: true }),
      }
    );
    if (!res.ok) {
      await parseWorkspaceError(res, 'Google Drive');
    }
  }
}
