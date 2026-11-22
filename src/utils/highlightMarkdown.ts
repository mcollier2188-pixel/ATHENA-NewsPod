import type {
  HighlightsMetaSummary,
  NewsArticle,
  SourceType,
} from '../types';

function formatSourceKindLabel(type?: SourceType): string {
  switch (type) {
    case 'pdf':
      return 'PDF Document';
    case 'docx':
      return 'Word (DOCX)';
    case 'markdown':
      return 'Markdown';
    case 'txt':
      return 'Text Note';
    default:
      return 'News Article';
  }
}

function escapeMarkdownLinkLabel(text: string): string {
  return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

export function formatArticleHighlightsMarkdown(article: NewsArticle): string {
  const highlights = article.highlights || [];
  if (highlights.length === 0) return '';

  const title = (article.title || 'Untitled Source').trim();
  const safeTitle = escapeMarkdownLinkLabel(title);
  const publication = (article.source || 'Notebook Source').trim();
  const category = (article.category || 'General').trim();
  const kindLabel = formatSourceKindLabel(article.sourceType);

  const rawHref = (article.driveWebViewLink || article.url || '').trim();
  const canonicalUrl = /^https?:\/\//i.test(rawHref) ? rawHref : '';

  const headingTitle = canonicalUrl ? `[${safeTitle}](${canonicalUrl})` : `**${title}**`;
  const lines: string[] = [
    `### ${headingTitle}`,
    `*Source: ${publication} · ${category} · ${kindLabel}*`,
    '',
  ];

  const passages = article.passages || [];

  highlights.forEach((hl, idx) => {
    const cleanedQuote = hl.text.replace(/\s+/g, ' ').trim();
    if (!cleanedQuote) return;

    let resolvedPassageIndex = hl.passageIndex > 0 ? hl.passageIndex : 0;
    if (resolvedPassageIndex === 0 && passages.length > 0) {
      const needle = cleanedQuote.toLowerCase();
      const matched = passages.find((p) =>
        p.text.replace(/\s+/g, ' ').toLowerCase().includes(needle)
      );
      if (matched) {
        resolvedPassageIndex = matched.index;
      }
    }

    const citationSourcePart = canonicalUrl
      ? `[${safeTitle}](${canonicalUrl}), ${publication}`
      : `${title}, ${publication}`;
    const passageSuffix =
      resolvedPassageIndex > 0 ? ` (Passage ${resolvedPassageIndex})` : '';

    lines.push(`> "${cleanedQuote}"`);
    lines.push(`> — *${citationSourcePart}${passageSuffix}*`);

    if (idx < highlights.length - 1) {
      lines.push('');
    }
  });

  return lines.join('\n');
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback for restricted iframe contexts
    }
  }

  if (typeof document === 'undefined') return false;

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

export function formatHighlightsMetaSummaryMarkdown(
  summary: HighlightsMetaSummary
): string {
  const lines: string[] = [
    `# ${summary.title}`,
    `*${summary.subtitle}*`,
    `*Synthesized from ${summary.highlightCount} ${
      summary.highlightCount === 1 ? 'highlight' : 'highlights'
    } across ${summary.sourceCount} ${
      summary.sourceCount === 1 ? 'source' : 'sources'
    }*`,
    '',
    '## Executive Overview',
    summary.executiveOverview.trim(),
  ];

  if (summary.themes.length > 0) {
    lines.push('', '## Cross-Source Themes');
    summary.themes.forEach((theme, idx) => {
      const sourcesNote =
        theme.sourceTitles.length > 0
          ? ` *(${theme.sourceTitles.join(' · ')})*`
          : '';
      lines.push(`### ${idx + 1}. ${theme.heading}${sourcesNote}`);
      lines.push(theme.synthesis.trim());
      lines.push('');
    });
  }

  if (summary.keyTakeaways.length > 0) {
    lines.push('## Key Takeaways');
    summary.keyTakeaways.forEach((item) => {
      lines.push(`- ${item}`);
    });
  }

  if (summary.citations.length > 0) {
    lines.push('', '## Cited Passages');
    summary.citations.forEach((cit) => {
      lines.push(
        `- **[${cit.marker}]** ${cit.sourceTitle} (Passage ${cit.passageIndex}) — "${cit.excerpt}"`
      );
    });
  }

  return lines.join('\n').trim();
}

