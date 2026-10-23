import type { APIContext, MiddlewareHandler, MiddlewareNext } from "astro";

// The approved loop lives at public/og/og-video.mp4, rendered at twice the
// 1200×630 card size.
const VIDEO_PATH = "/og/og-video.mp4";
const VIDEO_WIDTH = 2400;
const VIDEO_HEIGHT = 1260;

/** The five `og:video` tags for a video at `videoUrl` (absolute). */
export const ogVideoTags = (videoUrl: string): string =>
  [
    ["og:video", videoUrl],
    ["og:video:secure_url", videoUrl],
    ["og:video:type", "video/mp4"],
    ["og:video:width", String(VIDEO_WIDTH)],
    ["og:video:height", String(VIDEO_HEIGHT)],
  ]
    .map(([property, content]) => `<meta content="${content}" property="${property}">`)
    .join("");

/** `html` with the `og:video` tags for the video on `site` closing its head. */
export const injectOgVideoTags = ({ html, site }: { html: string; site: URL }): string =>
  html.replace("</head>", `${ogVideoTags(new URL(VIDEO_PATH, site).href)}</head>`);

/**
 * Adds the `og:video` tags to the homepage's HTML. The URL is built from the
 * configured site, so it follows the production domain. Every other route,
 * any non-HTML answer for `/` (such as its Markdown twin), and every answer
 * when no site is configured pass through.
 */
export const onRequest = (async (
  context: Pick<APIContext, "site" | "url">,
  next: MiddlewareNext,
) => {
  const response = await next();
  const isHomeHtml =
    context.url.pathname === "/" &&
    response.headers.get("content-type")?.startsWith("text/html") === true;
  if (!isHomeHtml || !context.site) {
    return response;
  }
  const html = await response.text();
  return new Response(injectOgVideoTags({ html, site: context.site }), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}) satisfies MiddlewareHandler;
