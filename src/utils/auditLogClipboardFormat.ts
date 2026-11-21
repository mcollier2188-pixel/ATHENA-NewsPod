import { extractAuditStateTransition } from '../components/AdminAuditLogPanel';
import type {
  AuditAccountabilityDomain,
  AuditLogCategory,
  OwnerActivityLogEntry,
} from '../services/suiteApi';

export type AuditClipboardFormat = 'markdown' | 'csv';

const DOMAIN_LABELS: Record<AuditAccountabilityDomain, string> = {
  auth_history: 'User Login & Auth',
  privilege_modifications: 'Privilege Change',
  system_config: 'System Config Update',
  system_data_changes: 'Workspace Data Event',
};

const CATEGORY_LABELS: Record<AuditLogCategory, string> = {
  auth: 'Authentication',
  governance: 'Governance & RBAC',
  system_config: 'System Configuration',
  ai_desk: 'AI Desk',
  media_lab: 'Media Lab',
  mockup: 'Site Mockup',
  spatial: 'Spatial & Map',
  share: 'Public Shares',
};

function escapeCsvCell(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeMarkdownTableCell(value: string | number | null | undefined): string {
  const raw = String(value ?? '—')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  return raw || '—';
}

function formatRoleLabel(role: string): string {
  if (role === 'owner') return 'Ultra Owner';
  if (role === 'admin') return 'Studio Admin';
  if (role === 'guest') return 'Guest';
  if (role === 'member') return 'Member';
  return role || 'Member';
}

function safeIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value || '—');
  return parsed.toISOString();
}

/**
 * Formats activity audit log entries as an RFC 4180 CSV string suitable for spreadsheets,
 * SIEM ingestion, or compliance archival.
 */
export function formatAuditLogsAsCsv(entries: OwnerActivityLogEntry[]): string {
  const headers = [
    'Timestamp (ISO)',
    'Event ID',
    'Accountability Domain',
    'Severity',
    'Actor Name',
    'Actor Email',
    'Role',
    'Auth Status',
    'Category',
    'Action',
    'State Transition',
    'Summary',
    'Client Context',
    'Resource Type',
    'Resource ID',
    'Metadata JSON',
  ];

  const rows = entries.map((log) => {
    const diff = extractAuditStateTransition(log);
    return [
      safeIsoTimestamp(log.createdAt),
      log.id,
      log.domain,
      log.severity,
      log.actorName || 'Dispatch Member',
      log.actorEmail,
      log.actorRole,
      log.authStatus,
      log.category,
      log.action,
      diff ? `${diff.before} -> ${diff.after}` : '',
      log.summary,
      log.clientContext || 'Studio Web',
      log.resourceType || 'workspace',
      log.resourceId || '',
      JSON.stringify(log.metadata || {}),
    ];
  });

  return [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => row.map(escapeCsvCell).join(',')),
  ].join('\n');
}

/**
 * Formats activity audit log entries as a clean GitHub-Flavored Markdown report
 * with executive posture counts and a chronological event table for sharing outside the app.
 */
export function formatAuditLogsAsMarkdown(
  entries: OwnerActivityLogEntry[],
  options: {
    exportedByEmail?: string;
    sortOrder?: 'desc' | 'asc';
    scopeLabel?: string;
  } = {}
): string {
  const generatedIso = new Date().toISOString();
  const sortLabel =
    options.sortOrder === 'asc'
      ? 'Chronological (Oldest First)'
      : 'Reverse Chronological (Newest First)';
  const scopeLabel = options.scopeLabel || 'Full Activity Audit Log';

  let authCount = 0;
  let privilegeCount = 0;
  let configCount = 0;
  let dataCount = 0;
  let elevatedOrCriticalCount = 0;

  for (const entry of entries) {
    if (entry.domain === 'auth_history') authCount += 1;
    else if (entry.domain === 'privilege_modifications') privilegeCount += 1;
    else if (entry.domain === 'system_config') configCount += 1;
    else dataCount += 1;

    if (entry.severity === 'critical' || entry.severity === 'elevated') {
      elevatedOrCriticalCount += 1;
    }
  }

  const lines: string[] = [
    '# Security & Activity Audit Log',
    '',
    `- **Generated (UTC):** \`${generatedIso}\``,
    options.exportedByEmail
      ? `- **Exported By:** \`${options.exportedByEmail}\``
      : null,
    `- **Scope:** ${scopeLabel}`,
    `- **Total Events:** ${entries.length}`,
    `- **Sort Order:** ${sortLabel}`,
    `- **Domain Breakdown:** ${authCount} Login/Auth · ${privilegeCount} Privilege Changes · ${configCount} System Config · ${dataCount} Workspace/Share Events (${elevatedOrCriticalCount} Critical/Elevated)`,
    '',
    '## Chronological Event Ledger',
    '',
    '| Timestamp (UTC) | Severity | Domain & Category | Actor | Action & State Transition | Summary | Resource & Client Context |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  ].filter((line): line is string => line !== null);

  for (const entry of entries) {
    const iso = safeIsoTimestamp(entry.createdAt);
    const severityLabel =
      entry.severity === 'critical'
        ? 'CRITICAL'
        : entry.severity === 'elevated'
          ? 'ELEVATED'
          : 'Standard';
    const domainText = `${DOMAIN_LABELS[entry.domain] || entry.domain} (${
      CATEGORY_LABELS[entry.category] || entry.category
    })`;
    const actorLabel = entry.actorName
      ? `${entry.actorName} <${entry.actorEmail}> · ${formatRoleLabel(entry.actorRole)} · ${entry.authStatus}`
      : `${entry.actorEmail} · ${formatRoleLabel(entry.actorRole)} · ${entry.authStatus}`;
    const diff = extractAuditStateTransition(entry);
    const actionText = diff
      ? `\`${entry.action}\` (${diff.before} → ${diff.after})`
      : `\`${entry.action}\``;
    const resourceText = `${
      entry.resourceType
        ? `${entry.resourceType}${entry.resourceId ? `#${entry.resourceId}` : ''}`
        : 'workspace'
    } · ${entry.clientContext || 'Studio Web'}`;

    lines.push(
      `| \`${escapeMarkdownTableCell(iso)}\` | ${escapeMarkdownTableCell(
        severityLabel
      )} | ${escapeMarkdownTableCell(domainText)} | ${escapeMarkdownTableCell(
        actorLabel
      )} | ${escapeMarkdownTableCell(actionText)} | ${escapeMarkdownTableCell(
        entry.summary
      )} | ${escapeMarkdownTableCell(resourceText)} |`
    );
  }

  lines.push('');
  return lines.join('\n');
}
