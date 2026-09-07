import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WhatsNewBody } from "./WhatsNewDialog";

describe("WhatsNewBody", () => {
  it("renders the version notes without the changelog heading", () => {
    const markup = renderToStaticMarkup(
      createElement(WhatsNewBody, { version: "0.1.25" }),
    );

    expect(markup).toContain("whats-new-md");
    expect(markup).toContain("What&#x27;s new in release 0.1.25");
    expect(markup).not.toContain("## [0.1.25]");
  });
});

describe("WhatsNewBody with feed notes", () => {
  it("renders a changelog section from the feed without its heading", () => {
    const markup = renderToStaticMarkup(
      createElement(WhatsNewBody, {
        version: "9.9.9",
        markdown:
          "## [9.9.9] - 2026-09-03\n\n### Changed\n\n- First auto-updating release\n",
      }),
    );

    expect(markup).toContain("First auto-updating release");
    expect(markup).not.toContain("[9.9.9]");
  });

  it("renders plain feed notes as they are", () => {
    const markup = renderToStaticMarkup(
      createElement(WhatsNewBody, { version: "9.9.9", markdown: "Bug fixes." }),
    );

    expect(markup).toContain("Bug fixes.");
    expect(markup).not.toContain("not available in this build");
  });
});
