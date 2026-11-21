import type { NewsArticle, SourcePassage } from '../types';

/**
 * Splits source text into clean, readable numbered passages (roughly 250–650 chars each)
 * so citations can deterministically jump to and highlight exact excerpts.
 */
export function buildPassagesFromText(
  sourceId: string,
  content: string,
  maxPassages = 32
): SourcePassage[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const rawBlocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter((b) => b.length > 0);

  const merged: string[] = [];
  for (const block of rawBlocks) {
    if (block.length > 720) {
      // Split long single blocks cleanly on sentence boundaries
      const sentences = block.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [block];
      let buf = '';
      for (const sentence of sentences) {
        const s = sentence.trim();
        if (!s) continue;
        if (buf.length + s.length + 1 > 560 && buf.length > 140) {
          merged.push(buf.trim());
          buf = s;
        } else {
          buf = buf ? `${buf} ${s}` : s;
        }
      }
      if (buf.trim()) merged.push(buf.trim());
    } else if (
      merged.length > 0 &&
      block.length < 110 &&
      merged[merged.length - 1].length < 420
    ) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${block}`;
    } else {
      merged.push(block);
    }
  }

  return merged.slice(0, maxPassages).map((text, idx) => ({
    id: `${sourceId}-p${idx + 1}`,
    index: idx + 1,
    text,
  }));
}

export function ensureArticlePassages(article: NewsArticle): NewsArticle {
  const passages =
    Array.isArray(article.passages) && article.passages.length > 0
      ? article.passages
      : buildPassagesFromText(article.id, article.content || article.summary);
  return {
    ...article,
    sourceType: article.sourceType || 'article',
    passages,
  };
}

/**
 * Strips visual citation markers like [1] or [1, 2] before sending script text to TTS
 * so hosts never read bracket numbers aloud.
 */
export function stripCitationMarkersForSpeech(text: string): string {
  return text
    .replace(/\s*\[(?:\d+(?:\s*,\s*\d+)*)\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
