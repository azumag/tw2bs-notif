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
  it("選択した配信情報をテンプレートへ展開する", () => {
    expect(
      formatStreamPostText(DEFAULT_POST_TEMPLATE, context, {
        includeTitle: true,
        includeCategory: true,
      }),
    ).toBe("配信開始しました\n朝の練習配信\nMusic");
  });

  it("OFFの情報と空行を本文から除く", () => {
    expect(
      formatStreamPostText(DEFAULT_POST_TEMPLATE, context, {
        includeTitle: false,
        includeCategory: false,
      }),
    ).toBe("配信開始しました");
  });

  it("チャンネル名とURLを使った自由なフォーマットを作れる", () => {
    expect(
      formatStreamPostText("{channel} is live!\n{url}", context, {
        includeTitle: false,
        includeCategory: false,
      }),
    ).toBe("あずまぐ is live!\nhttps://www.twitch.tv/azumagbanjo");
  });

  it("展開後の本文をBluesky上限内へ切り詰める", () => {
    const text = formatStreamPostText("あ".repeat(400), context, {
      includeTitle: true,
      includeCategory: true,
    });
    expect(Array.from(text)).toHaveLength(MAX_POST_TEXT_LENGTH);
    expect(text.endsWith("…")).toBe(true);
  });

  it("空欄と未対応変数を拒否する", () => {
    expect(validatePostTemplate("   ")).toContain("入力してください");
    expect(validatePostTemplate("{unknown}")).toContain("使用できない変数");
    expect(validatePostTemplate("{title}\n{category}")).toBeNull();
  });
});
