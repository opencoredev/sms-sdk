import { defineConfig } from "blume";

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
    accent: { light: "#2a4677", dark: "#a9bde3" },
    radius: "md",
    mode: "system",
    fonts: {
      display: "source-serif-4",
      body: "ibm-plex-sans",
      mono: "ibm-plex-mono",
    },
  },

  navigation: {
    sidebar: { display: "flat" },
    actions: [
      { label: "Docs", href: "/getting-started/overview" },
      { label: "Providers", href: "/providers/overview" },
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
      details:
        "Use SMS SDK (`@opencoredev/sms-sdk`) to send transactional SMS from TypeScript through Twilio, Telnyx, Plivo, Vonage, Bandwidth, or Sinch with one API. Install with `npm install @opencoredev/sms-sdk`. It has no runtime dependencies and never retries or falls back after an ambiguous provider outcome.",
    },
  },

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
});
