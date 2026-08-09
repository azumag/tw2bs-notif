/**
 * Bluesky は本文中のURLやハッシュタグを自動ではリンクにしない。
 * リンクとして表示・検索させるには、レコードに facets(本文中の範囲と
 * その種別)を添える必要がある。公式アプリは投稿時にクライアント側で
 * これを組み立てているので、API から投稿する場合は自前で用意する。
 *
 * facets のオフセットは UTF-8 のバイト単位で、JavaScript の文字
 * インデックスとは一致しない(日本語は1文字3バイト)。
 */

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: "app.bsky.richtext.facet#link"; uri: string }
    | { $type: "app.bsky.richtext.facet#tag"; tag: string }
  >;
}

const encoder = new TextEncoder();

// Bluesky のタグ長上限
const MAX_TAG_LENGTH = 64;

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TAG_PATTERN = /(^|\s)([#＃])([^\s#＃]+)/g;

const TRAILING_PUNCTUATION = ".,;:!?。、！？";
const TRAILING_BRACKETS: Record<string, string> = {
  ")": "(",
  "）": "（",
  "]": "[",
  "」": "「",
  "』": "『",
  "】": "【",
};

/** 文字インデックスを UTF-8 バイトオフセットへ変換する。 */
function byteOffset(text: string, charIndex: number): number {
  return encoder.encode(text.slice(0, charIndex)).length;
}

/**
 * 「URLの直後に句点」のように、本文の区切りが混ざった末尾を取り除く。
 * 閉じ括弧は、対応する開き括弧が無いときだけ本文側とみなす。
 */
function trimTail(value: string): string {
  let trimmed = value;
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (TRAILING_PUNCTUATION.includes(last)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    const opening = TRAILING_BRACKETS[last];
    if (opening && !trimmed.includes(opening)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    break;
  }
  return trimmed;
}

/** 本文からURL・ハッシュタグを検出して facets を組み立てる。 */
export function detectFacets(text: string): Facet[] {
  const facets: Facet[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const uri = trimTail(match[0]);
    if (!uri) continue;
    const start = match.index ?? 0;
    facets.push({
      index: {
        byteStart: byteOffset(text, start),
        byteEnd: byteOffset(text, start + uri.length),
      },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    });
  }

  for (const match of text.matchAll(TAG_PATTERN)) {
    const lead = match[1] ?? "";
    const marker = match[2];
    const tag = trimTail(match[3]);
    // 数字だけのタグは Bluesky 側で扱われないため送らない
    if (!tag || tag.length > MAX_TAG_LENGTH || /^\d+$/.test(tag)) continue;
    const markerStart = (match.index ?? 0) + lead.length;
    facets.push({
      index: {
        byteStart: byteOffset(text, markerStart),
        byteEnd: byteOffset(text, markerStart + marker.length + tag.length),
      },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
