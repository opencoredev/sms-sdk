// Animated link preview for the homepage. iMessage, Discord, and Telegram play
// `og:video` in place of the still card; Slack and X keep showing `og:image`.
// Blume's PageLayout has no head slot and `seo.metatags` would reach every docs
// page (each has its own generated card), so this integration adds a
// middleware that splices the tags into `/` alone (see og-video-middleware.ts).

import type { AstroIntegration } from "astro";

export const ogVideo = (): AstroIntegration => ({
  name: "sms-sdk-og-video",
  hooks: {
    "astro:config:setup": ({ addMiddleware }) => {
      // Outermost, so it sees the page after Blume's own middleware finished it.
      addMiddleware({
        entrypoint: new URL("./og-video-middleware.ts", import.meta.url),
        order: "pre",
      });
    },
  },
});
