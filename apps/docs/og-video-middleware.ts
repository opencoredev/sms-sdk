import type { MiddlewareHandler } from "astro";

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

/**
 * Adds the `og:video` tags to the homepage's HTML. The URL is built from the
 * configured site, so it follows the production domain. Every other route,
 * and any non-HTML answer for `/` (such as its Markdown twin), passes through.
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  const response = await next();
  const isHomeHtml =
    context.url.pathname === "/" &&
    response.headers.get("content-type")?.startsWith("text/html") === true;
  if (!isHomeHtml || !context.site) {
    return response;
  }
  const html = await response.text();
  const tags = ogVideoTags(new URL(VIDEO_PATH, context.site).href);
  return new Response(html.replace("</head>", `${tags}</head>`), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};
