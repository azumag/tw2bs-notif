import { describe, expect, it } from "vitest";
import {
  DEFAULT_POST_TEMPLATE,
  formatStreamPostText,
  MAX_POST_TEXT_LENGTH,
  validatePostTemplate,
} from "../src/lib/post-template";

const context = {
  title: "朝の練習配信",
  category: "Music",
  channel: "あずまぐ",
  url: "https://www.twitch.tv/azumagbanjo",
};

describe("post template", () => {
  it("テンプレートに書いた変数を配信情報へ展開する", () => {
    expect(formatStreamPostText(DEFAULT_POST_TEMPLATE, context)).toBe(
      "配信開始しました\n朝の練習配信\nMusic",
    );
  });

  it("テンプレートに書かなかった変数と空行は本文に出ない", () => {
    expect(formatStreamPostText("配信開始しました", context)).toBe(
      "配信開始しました",
    );
  });

  it("チャンネル名とURLを使った自由なフォーマットを作れる", () => {
    expect(formatStreamPostText("{channel} is live!\n{url}", context)).toBe(
      "あずまぐ is live!\nhttps://www.twitch.tv/azumagbanjo",
    );
  });

  it("展開後の本文をBluesky上限内へ切り詰める", () => {
    const text = formatStreamPostText("あ".repeat(400), context);
    expect(Array.from(text)).toHaveLength(MAX_POST_TEXT_LENGTH);
    expect(text.endsWith("…")).toBe(true);
  });

  it("空欄と未対応変数を拒否する", () => {
    expect(validatePostTemplate("   ")).toContain("入力してください");
    expect(validatePostTemplate("{unknown}")).toContain("使用できない変数");
    expect(validatePostTemplate("{title}\n{category}")).toBeNull();
  });
});
