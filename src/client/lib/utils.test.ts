import { describe, expect, test } from "bun:test";
import { formatDisplayVersion } from "./utils";

describe("formatDisplayVersion", () => {
  test("hides timestamp build metadata", () => {
    expect(formatDisplayVersion("4.1.2+20260803231914")).toBe("4.1.2");
    expect(formatDisplayVersion("4.1.2-dev+20260803231914")).toBe("4.1.2-dev");
  });

  test("preserves non-date build metadata", () => {
    expect(formatDisplayVersion("4.1.2+beta.1")).toBe("4.1.2+beta.1");
    expect(formatDisplayVersion("4.1.2+20260803")).toBe("4.1.2+20260803");
  });
});
