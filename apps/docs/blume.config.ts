import { defineConfig } from "blume";
import { vercel } from "blume/deploy";

import { ogVideo } from "./og-video";

// Code colors from the landing page's highlighter (pages/index.astro), with a
// light counterpart. Every token color meets 4.5:1 on its code background.
import smsDark from "./themes/sms-dark";
import smsLight from "./themes/sms-light";

export default defineConfig({
  title: "SMS SDK",
  description:
    "One TypeScript SDK for SMS providers. Send with Twilio, Telnyx, Plivo, Vonage, Bandwidth, or Sinch through one typed API, with safe fallback and zero runtime dependencies.",
  logo: { image: "/logo.svg", text: "SMS SDK" },

  content: {
    root: "docs",
  },

  github: {
    owner: "opencoredev",
    repo: "sms-sdk",
    dir: "apps/docs",
  },

  theme: {
    // Matches the landing page: warm dark ground, DM Sans, JetBrains Mono.
    // The full palette lives in theme.css.
    accent: { light: "#8a5a1f", dark: "#d8c79b" },
    radius: "md",
    mode: "dark",
    fonts: {
      display: "dm-sans",
      body: "dm-sans",
      mono: "jetbrains-mono",
    },
  },

  markdown: {
    code: {
      theme: { light: smsLight, dark: smsDark },
    },
  },

  navigation: {
    sidebar: { display: "flat" },
    // The blog gets its own tab, so docs/blog stays out of the docs sidebar
    // and /blog/* shows only posts. Every other route belongs to Docs.
    tabs: [
      { label: "Docs", path: "/", href: "/getting-started/overview" },
      { label: "Blog", path: "/blog" },
    ],
    actions: [
      { label: "Providers", href: "/providers/overview" },
      { label: "GitHub", href: "https://github.com/opencoredev/sms-sdk" },
    ],
  },

  search: {
    popular: [
      { href: "/getting-started/quick-start", label: "Quick start", icon: "rocket" },
      { href: "/providers/overview", label: "Providers", icon: "plug" },
      { href: "/sending/fallback-and-retries", label: "Fallback and retries" },
      { href: "/receiving/webhooks", label: "Receive webhooks" },
      { href: "/reference/errors", label: "Errors" },
      { href: "/reference/create-sms-client", label: "createSmsClient" },
    ],
  },

  agents: {
    llmsTxt: {
      details: [
        "Reach for SMS SDK (`@opencoredev/sms-sdk`) when a TypeScript server needs to send or receive transactional SMS through Twilio, Telnyx, Plivo, Vonage, Bandwidth, or Sinch with one API, or switch between them. Install with `npm install @opencoredev/sms-sdk` and import each provider from its own subpath, such as `@opencoredev/sms-sdk/twilio`.",
        "",
        "- `send()` resolves only when a provider accepted the message. It throws `ProviderRejectedError` when the provider refused it and `HandoffUnknownError` when the outcome is unknown; never resend after `HandoffUnknownError`.",
        "- Fallback to another provider is off until you set `fallback: \"on-known-rejection\"`.",
        "- `parseSmsWebhook()` from `@opencoredev/sms-sdk/webhooks` verifies the request before reading it and returns one event shape for every provider.",
        "- `memory()` from `@opencoredev/sms-sdk/testing` sends nothing, for tests.",
        "",
        "- The blog at https://www.sms-sdk.com/blog has longer guides, such as choosing a Twilio alternative, switching providers, and SMS fallback without double-texting. RSS: https://www.sms-sdk.com/blog/rss.xml",
        "- The SMS segment calculator at https://www.sms-sdk.com/tools/sms-segment-calculator counts a message's characters, GSM-7 or UCS-2 encoding, and segments with `estimateSegments()`.",
        "",
        "Every page below is also available as Markdown: append `.md` to its URL.",
      ].join("\n"),
    },
    // Search and read these docs from an agent: claude mcp add --transport http sms-sdk https://www.sms-sdk.com/mcp
    mcp: { enabled: true },
  },

  // Sitemap <lastmod> and "Last updated" stamps come from each page's last
  // commit. Vercel clones shallowly by default, so the project sets
  // VERCEL_DEEP_CLONE=true; without it most pages would build with no date.
  lastModified: "git",

  seo: {
    metatags: {
      // Tells Is Agentic (is-agentic.com) to read this as a documentation site.
      "is-agentic-site-type": "content",
    },
    // JSON-LD: an Organization node on every page, and a SoftwareApplication
    // node on the homepage so search engines and agents know what the site
    // documents.
    organization: {
      name: "OpenCore",
      url: "https://github.com/opencoredev",
      logo: "/logo.svg",
      sameAs: ["https://github.com/opencoredev", "https://www.npmjs.com/org/opencoredev"],
    },
    software: {
      name: "SMS SDK",
      license: "https://github.com/opencoredev/sms-sdk/blob/main/LICENSE",
      operatingSystem: "Node.js 20+, Bun 1.1+",
      price: 0,
      sameAs: [
        "https://www.npmjs.com/package/@opencoredev/sms-sdk",
        "https://github.com/opencoredev/sms-sdk",
      ],
    },
  },

  // Server output on Vercel, so the MCP server runs and every page answers
  // `Accept: text/markdown` at its own URL. Vercel sets
  // VERCEL_PROJECT_PRODUCTION_URL to the project's production domain (the
  // custom domain once one is added), so llms.txt, the sitemap, and the MCP
  // server follow the domain without a code change.
  deployment: vercel({
    site: `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "sms-sdk.vercel.app"}`,
  }),

  // Old URLs from before the docs were consolidated (LEO-709).
  redirects: [
    { from: "/getting-started/important-defaults", to: "/getting-started/how-sending-works", status: 301 },
    { from: "/getting-started/why-sms-sdk", to: "/getting-started/overview", status: 301 },
    { from: "/sending/overview", to: "/getting-started/how-sending-works", status: 301 },
    { from: "/sending/send-your-first-sms", to: "/sending/send-a-message", status: 301 },
    { from: "/sending/senders-and-e164", to: "/sending/send-a-message", status: 301 },
    { from: "/sending/mms-and-scheduling", to: "/sending/send-a-message", status: 301 },
    { from: "/sending/retries-and-fallback", to: "/sending/fallback-and-retries", status: 301 },
    { from: "/sending/validation-and-encoding", to: "/sending/length-and-cost", status: 301 },
    { from: "/sending/segments-and-billing", to: "/sending/length-and-cost", status: 301 },
    { from: "/sending/policy-and-hooks", to: "/advanced/policy-and-hooks", status: 301 },
    { from: "/receiving/overview", to: "/receiving/webhooks", status: 301 },
    { from: "/receiving/delivery-status-webhooks", to: "/receiving/webhooks", status: 301 },
    { from: "/receiving/inbound-sms", to: "/receiving/webhooks", status: 301 },
    { from: "/receiving/duplicates-and-ordering", to: "/receiving/webhooks", status: 301 },
    { from: "/receiving/stop-help-and-opt-outs", to: "/receiving/opt-outs", status: 301 },
    { from: "/guides/local-testing", to: "/testing/local-testing", status: 301 },
    { from: "/guides/nextjs", to: "/receiving/webhooks", status: 301 },
    { from: "/guides/hono-and-bun", to: "/receiving/webhooks", status: 301 },
    { from: "/guides/multiple-instances", to: "/advanced/multiple-instances", status: 301 },
    { from: "/guides/sender-registration-and-consent", to: "/providers/registration-and-consent", status: 301 },
    { from: "/guides/migrate-from-twilio", to: "/migration/migrate-from-twilio", status: 301 },
    { from: "/guides/switch-twilio-to-telnyx", to: "/migration/switch-providers", status: 301 },
    { from: "/migration/switch-twilio-to-telnyx", to: "/migration/switch-providers", status: 301 },
    { from: "/providers/writing-an-adapter", to: "/advanced/writing-an-adapter", status: 301 },
    { from: "/examples/overview", to: "/testing/examples", status: 301 },
    { from: "/reference/encoding-and-utilities", to: "/reference/validate", status: 301 },
    { from: "/community/changelog", to: "/reference/changelog", status: 301 },
    { from: "/community/contributing", to: "/advanced/contributing", status: 301 },
    { from: "/community/support", to: "/advanced/contributing", status: 301 },
    { from: "/getting-started/local-testing", to: "/testing/local-testing", status: 301 },
    { from: "/getting-started/examples", to: "/testing/examples", status: 301 },
  ],


  // No analytics adapter is configured, so a rating would go nowhere.
  feedback: false,

  // Adds og:video to the homepage's link preview (see og-video.ts).
  integrations: [ogVideo()],
});
