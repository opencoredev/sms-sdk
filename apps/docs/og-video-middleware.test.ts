import { describe, expect, test } from "bun:test";
import { injectOgVideoTags, onRequest } from "./og-video-middleware";

const site = new URL("https://www.sms-sdk.com");
const videoUrl = "https://www.sms-sdk.com/og/og-video.mp4";
const ogImage = '<meta content="https://www.sms-sdk.com/og/home.png" property="og:image">';
const page = `<!doctype html><html><head><title>SMS SDK</title>${ogImage}</head><body>Hi</body></html>`;

const videoTag = `<meta content="${videoUrl}" property="og:video">`;
const expectedTags = [
  videoTag,
  `<meta content="${videoUrl}" property="og:video:secure_url">`,
  '<meta content="video/mp4" property="og:video:type">',
  '<meta content="2400" property="og:video:width">',
  '<meta content="1260" property="og:video:height">',
];

const respond = ({ body, contentType }: { body: string; contentType: string }) =>
  new Response(body, { headers: { "content-type": contentType }, status: 200 });

const run = async ({
  path,
  site,
  response,
}: {
  path: string;
  site: URL | undefined;
  response: Response;
}) => onRequest({ site, url: new URL(path, "https://www.sms-sdk.com") }, async () => response);

describe("injectOgVideoTags", () => {
  test("puts all five tags at the end of the head, with an absolute URL", () => {
    expect(injectOgVideoTags({ html: page, site })).toBe(
      page.replace("</head>", `${expectedTags.join("")}</head>`),
    );
  });

  test("builds the URL from the configured site", () => {
    const html = injectOgVideoTags({ html: page, site: new URL("https://preview.example.dev/") });
    expect(html).toContain('<meta content="https://preview.example.dev/og/og-video.mp4" property="og:video">');
  });
});

describe("og:video middleware", () => {
  test("adds the five tags to the homepage HTML and keeps og:image", async () => {
    const response = await run({ path: "/", site, response: respond({ body: page, contentType: "text/html; charset=utf-8" }) });
    const html = await response.text();
    for (const tag of expectedTags) {
      expect(html).toContain(tag);
    }
    expect(html.match(/property="og:video/g)).toHaveLength(5);
    expect(html).toContain(ogImage);
    expect(html.indexOf(videoTag)).toBeLessThan(html.indexOf("</head>"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("passes a docs page through untouched", async () => {
    const original = respond({ body: page, contentType: "text/html; charset=utf-8" });
    expect(await run({ path: "/getting-started/quick-start", site, response: original })).toBe(original);
  });

  test("passes the homepage's Markdown twin through untouched", async () => {
    const original = respond({ body: "# SMS SDK", contentType: "text/markdown; charset=utf-8" });
    expect(await run({ path: "/", site, response: original })).toBe(original);
  });

  test("passes a non-HTML homepage answer through untouched", async () => {
    const original = respond({ body: "{}", contentType: "application/json" });
    expect(await run({ path: "/", site, response: original })).toBe(original);
  });

  test("passes the homepage through untouched when no site is configured", async () => {
    const original = respond({ body: page, contentType: "text/html" });
    const response = await run({ path: "/", site: undefined, response: original });
    expect(response).toBe(original);
    expect(await response.text()).toBe(page);
  });
});
