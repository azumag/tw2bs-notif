import { afterEach, describe, expect, it, vi } from "vitest";
import { logError } from "../src/lib/logger";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logError", () => {
  it("原因チェーンをメッセージだけで記録する", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = new TypeError("plc fetch failed");
    const wrapped = new Error("identity resolution failed", { cause: root });

    logError("bsky", "oauth callback failed", wrapped, { userId: "user-1" });

    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toBe(
      '[error][bsky] oauth callback failed {"userId":"user-1","error":"identity resolution failed","errorCauses":["TypeError: plc fetch failed"]}',
    );
  });

  it("cause の循環で最上位エラーを重複記録しない", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outer = new Error("outer");
    const inner = new Error("inner");
    outer.cause = inner;
    inner.cause = outer;

    logError("bsky", "failed", outer);

    expect(write.mock.calls[0][0]).toBe(
      '[error][bsky] failed {"error":"outer","errorCauses":["Error: inner"]}',
    );
  });

  it("自己参照 cause を記録しない", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("self");
    error.cause = error;

    logError("bsky", "failed", error);

    expect(write.mock.calls[0][0]).toBe(
      '[error][bsky] failed {"error":"self"}',
    );
  });

  it("cause は4階層まで記録する", () => {
    const write = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const errors = Array.from({ length: 6 }, (_, i) => new Error(`level-${i}`));
    for (let i = 0; i < errors.length - 1; i += 1) {
      errors[i].cause = errors[i + 1];
    }

    logError("bsky", "failed", errors[0]);

    expect(write.mock.calls[0][0]).toBe(
      '[error][bsky] failed {"error":"level-0","errorCauses":["Error: level-1","Error: level-2","Error: level-3","Error: level-4"]}',
    );
  });
});
