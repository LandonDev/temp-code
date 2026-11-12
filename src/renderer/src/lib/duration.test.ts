import { describe, expect, it } from "vitest";
import { clockTime, dayTime, minuteAge } from "./duration";

describe("minuteAge", () => {
  it("writes an age in whole minutes, never seconds", () => {
    expect(minuteAge(10_000)).toBe("<1m");
    expect(minuteAge(-5)).toBe("<1m");
    expect(minuteAge(12 * 60_000 + 45_000)).toBe("12m");
    expect(minuteAge((2 * 60 + 14) * 60_000)).toBe("2h 14m");
    expect(minuteAge(3 * 3_600_000)).toBe("3h");
  });
});

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

describe("dayTime", () => {
  const now = new Date(2026, 10, 11, 10, 0).getTime();
  const plain = (t: number) => dayTime(t, now, "en-US").replace(/\u202f/g, " ");

  it("is the clock time today, and names the day of any other", () => {
    expect(plain(new Date(2026, 10, 11, 9, 5).getTime())).toBe("9:05 AM");
    // later today is still today: a time is never read as another day's for being ahead of now
    expect(plain(new Date(2026, 10, 11, 14, 2).getTime())).toBe("2:02 PM");
    // yesterday afternoon would read as later than now without its day
    expect(plain(new Date(2026, 10, 10, 14, 2).getTime())).toBe("Tue 2:02 PM");
    expect(plain(new Date(2026, 10, 5, 14, 2).getTime())).toBe("Thu 2:02 PM");
    // a week or more back, a weekday would name the wrong day
    expect(plain(new Date(2026, 10, 4, 14, 2).getTime())).toBe("Nov 4, 2:02 PM");
    expect(plain(new Date(2026, 9, 20, 9, 5).getTime())).toBe("Oct 20, 9:05 AM");
  });
});
