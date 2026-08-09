import { describe, expect, it } from "vitest";
import { detectFacets } from "../src/lib/facets";

const encoder = new TextEncoder();

/** facet の範囲が本文の該当部分を正しく指しているかを実際に切り出して確かめる。 */
function sliceByFacet(text: string, byteStart: number, byteEnd: number): string {
  return new TextDecoder().decode(encoder.encode(text).slice(byteStart, byteEnd));
}

describe("detectFacets", () => {
  it("URLをリンクのfacetにする", () => {
    const text = "配信開始しました\nhttps://www.twitch.tv/azumagbanjo";
    const facets = detectFacets(text);

    expect(facets).toHaveLength(1);
    expect(facets[0].features).toEqual([
      {
        $type: "app.bsky.richtext.facet#link",
        uri: "https://www.twitch.tv/azumagbanjo",
      },
    ]);
    expect(
      sliceByFacet(text, facets[0].index.byteStart, facets[0].index.byteEnd),
    ).toBe("https://www.twitch.tv/azumagbanjo");
  });

  it("日本語の後ろでもバイトオフセットがずれない", () => {
    // 「配信開始しました」は8文字=24バイト。文字インデックスのままだと壊れる
    const text = "配信開始しました https://www.twitch.tv/azumagbanjo";
    const facets = detectFacets(text);

    expect(facets[0].index.byteStart).toBe(25);
    expect(
      sliceByFacet(text, facets[0].index.byteStart, facets[0].index.byteEnd),
    ).toBe("https://www.twitch.tv/azumagbanjo");
  });

  it("ハッシュタグをタグのfacetにする(#は範囲に含む)", () => {
    const text = "週末の雑談配信 #twitch";
    const facets = detectFacets(text);

    expect(facets).toHaveLength(1);
    expect(facets[0].features).toEqual([
      { $type: "app.bsky.richtext.facet#tag", tag: "twitch" },
    ]);
    expect(
      sliceByFacet(text, facets[0].index.byteStart, facets[0].index.byteEnd),
    ).toBe("#twitch");
  });

  it("日本語のハッシュタグと全角#も扱う", () => {
    const text = "配信中 #ゲーム実況 ＃雑談";
    const facets = detectFacets(text);

    expect(facets.map((f) => f.features[0])).toEqual([
      { $type: "app.bsky.richtext.facet#tag", tag: "ゲーム実況" },
      { $type: "app.bsky.richtext.facet#tag", tag: "雑談" },
    ]);
    expect(
      sliceByFacet(text, facets[0].index.byteStart, facets[0].index.byteEnd),
    ).toBe("#ゲーム実況");
    expect(
      sliceByFacet(text, facets[1].index.byteStart, facets[1].index.byteEnd),
    ).toBe("＃雑談");
  });

  it("URLとタグが混在しても、それぞれ本文の該当部分を指す", () => {
    const text = "あずまぐ 配信中\nテスト配信 #twitch\nhttps://www.twitch.tv/cool_user";
    const facets = detectFacets(text);

    expect(facets).toHaveLength(2);
    // byteStart の昇順に並ぶ
    expect(facets[0].index.byteStart).toBeLessThan(facets[1].index.byteStart);
    expect(
      sliceByFacet(text, facets[0].index.byteStart, facets[0].index.byteEnd),
    ).toBe("#twitch");
    expect(
      sliceByFacet(text, facets[1].index.byteStart, facets[1].index.byteEnd),
    ).toBe("https://www.twitch.tv/cool_user");
  });

  it("URL末尾の句読点や対応しない閉じ括弧はリンクに含めない", () => {
    const text = "詳しくは https://example.com/live。 (https://example.com/a)";
    const facets = detectFacets(text);

    expect(facets.map((f) => f.features[0])).toEqual([
      { $type: "app.bsky.richtext.facet#link", uri: "https://example.com/live" },
      { $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a" },
    ]);
    expect(
      sliceByFacet(text, facets[0].index.byteStart, facets[0].index.byteEnd),
    ).toBe("https://example.com/live");
    expect(
      sliceByFacet(text, facets[1].index.byteStart, facets[1].index.byteEnd),
    ).toBe("https://example.com/a");
  });

  it("URL中の#フラグメントはタグにしない", () => {
    const text = "https://example.com/live#section";
    const facets = detectFacets(text);

    expect(facets).toHaveLength(1);
    expect(facets[0].features[0].$type).toBe("app.bsky.richtext.facet#link");
  });

  it("数字だけ・長すぎるタグは送らない", () => {
    const facets = detectFacets(`#123 #${"a".repeat(65)}`);
    expect(facets).toEqual([]);
  });

  it("URLもタグも無ければ空", () => {
    expect(detectFacets("配信開始しました")).toEqual([]);
  });
});
