import { describe, expect, it } from "vitest";
import { clockTime } from "./duration";

describe("clockTime", () => {
  const noon = new Date(2026, 10, 1, 12, 8).getTime();
  const afternoon = new Date(2026, 10, 1, 14, 2).getTime();
  const morning = new Date(2026, 10, 1, 9, 5).getTime();
  const midnight = new Date(2026, 10, 1, 0, 30).getTime();

  it("reads 12-hour with AM or PM where the locale does, the hour unpadded", () => {
    // ICU writes one space or a narrow no-break space before the period.
    const plain = (t: number) => clockTime(t, "en-US").replace(/ /g, " ");
    expect(plain(noon)).toBe("12:08 PM");
    expect(plain(afternoon)).toBe("2:02 PM");
    expect(plain(morning)).toBe("9:05 AM");
    expect(plain(midnight)).toBe("12:30 AM");
    expect(clockTime(afternoon, "en-US")).toMatch(/^2:02[  ]PM$/);
  });

  it("follows a 24-hour locale", () => {
    expect(clockTime(afternoon, "en-GB")).toBe("14:02");
  });
});
