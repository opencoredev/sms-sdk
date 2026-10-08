import { defineConfig } from "blume";

export default defineConfig({
  title: "SMS SDK",
  description:
    "One TypeScript SDK for SMS providers. Send with Twilio, Telnyx, Plivo, or Vonage through one typed API, with safe fallback and zero runtime dependencies.",
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
    accent: { light: "#2b46c9", dark: "#8fa2ff" },
    radius: "md",
    mode: "system",
    fonts: {
      display: "ibm-plex-sans",
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
      { href: "/sending/retries-and-fallback", label: "Retries and fallback" },
      { href: "/receiving/delivery-status-webhooks", label: "Delivery status webhooks" },
      { href: "/reference/create-sms-client", label: "createSmsClient" },
    ],
  },

  agents: {
    llmsTxt: {
      details:
        "Use SMS SDK (`@opencoredev/sms-sdk`) to send transactional SMS from TypeScript through Twilio, Telnyx, Plivo, or Vonage with one API. Install with `npm install @opencoredev/sms-sdk`. It has no runtime dependencies and never retries or falls back after an ambiguous provider outcome.",
    },
  },

  // No analytics adapter is configured, so a rating would go nowhere.
  feedback: false,
});
