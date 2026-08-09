export const DEFAULT_POST_TEMPLATE = `配信開始しました
{title}
{category}`;

export const MAX_POST_TEMPLATE_LENGTH = 1_000;
export const MAX_POST_TEXT_LENGTH = 300;

const SUPPORTED_VARIABLES = new Set(["title", "category", "channel", "url"]);

export interface PostTemplateContext {
  title?: string;
  category?: string;
  channel: string;
  url: string;
}

/** 保存前にテンプレートのサイズと変数名を検証する。 */
export function validatePostTemplate(template: string): string | null {
  if (!template.trim()) {
    return "ポスト本文のフォーマットを入力してください。";
  }
  if (template.length > MAX_POST_TEMPLATE_LENGTH) {
    return `ポスト本文のフォーマットは${MAX_POST_TEMPLATE_LENGTH}文字以内で入力してください。`;
  }

  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    const variable = match[1];
    if (!SUPPORTED_VARIABLES.has(variable)) {
      return `使用できない変数です: {${variable}}`;
    }
  }
  return null;
}

/** Bluesky の本文上限を超えないよう、Unicodeコードポイント単位で切り詰める。 */
function truncatePostText(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= MAX_POST_TEXT_LENGTH) return text;
  return `${codePoints.slice(0, MAX_POST_TEXT_LENGTH - 1).join("")}…`;
}

/**
 * チャネル設定と配信情報から投稿本文を生成する。
 * テンプレートに含めた変数だけが展開される({title}/{category} を
 * 書かなければその情報は本文に出ない。個別のON/OFFスイッチは持たない)。
 */
export function formatStreamPostText(
  template: string,
  context: PostTemplateContext,
): string {
  const values: Record<string, string> = {
    title: context.title ?? "",
    category: context.category ?? "",
    channel: context.channel,
    url: context.url,
  };

  const rendered = template
    .replace(/\{(title|category|channel|url)\}/g, (_match, key: string) => values[key])
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .trim();

  return truncatePostText(rendered || "配信開始しました");
}
