import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestBoard } from "./quest-board";

describe("QuestBoard", () => {
  test("exposes quest completion as a progress bar", () => {
    const html = renderToStaticMarkup(
      <QuestBoard id="test" steps={[{ id: "install", label: "Install the package" }]} />,
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-label="Quest progress"');
    expect(html).toContain('aria-valuenow="0"');
  });
});
