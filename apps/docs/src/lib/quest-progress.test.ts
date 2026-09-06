import { describe, expect, test } from "bun:test";
import { getQuestProgress } from "./quest-progress";

describe("getQuestProgress", () => {
  test("returns zero progress for an empty quest", () => {
    expect(getQuestProgress([])).toEqual({ completedCount: 0, percent: 0, xp: 0 });
  });

  test("counts completed steps and awards 25 XP per step", () => {
    expect(getQuestProgress([true, false, true, true])).toEqual({
      completedCount: 3,
      percent: 75,
      xp: 75,
    });
  });
});
