import { describe, expect, test } from "bun:test";
import { detectKeyword, HELP_KEYWORDS, OPT_OUT_KEYWORDS } from "../../src/webhooks/index.js";

describe("detectKeyword", () => {
  test("the keyword lists match the documented set", () => {
    expect(OPT_OUT_KEYWORDS).toEqual(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
    expect(HELP_KEYWORDS).toEqual(["HELP", "INFO"]);
  });

  test.each(OPT_OUT_KEYWORDS.map((keyword) => [keyword]))("%s is an opt-out", (keyword) => {
    expect(detectKeyword(keyword)).toEqual({ kind: "opted_out", keyword });
  });

  test.each(HELP_KEYWORDS.map((keyword) => [keyword]))("%s is a help request", (keyword) => {
    expect(detectKeyword(keyword)).toEqual({ kind: "help", keyword });
  });

  test.each([["stop"], ["  Stop  "], ["STOP."], ["stop!!"], ["Quit?"]])("normalizes %j", (body) => {
    expect(detectKeyword(body)?.kind).toBe("opted_out");
  });

  test.each([["please stop"], ["stop it"], ["STOPPED"], ["unstoppable"], [""], ["help me"], ["start"]])(
    "does not match %j",
    (body) => {
      expect(detectKeyword(body)).toBeUndefined();
    },
  );
});
