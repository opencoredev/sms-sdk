import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { BrandMark } from "@/components/brand-mark";
import { CompactThemeSwitch } from "@/components/compact-theme-switch";
import { FieldGuideIcon } from "@/components/docs-icon";

import { appName, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <BrandMark className="h-5 w-auto" />
          <span>{appName}</span>
        </>
      ),
      url: "/docs",
    },
    links: [
      { text: "Email", url: "/docs/email" },
      { text: "Sandbox", url: "/docs/sandbox" },
      { text: "Releases", url: "/docs/releases" },
      { text: "Support", url: "/docs/support" },
      {
        type: "icon",
        text: "GitHub",
        label: "GitHub",
        url: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
        external: true,
        icon: <FieldGuideIcon aria-hidden="true" name="github" />,
      },
    ],
    slots: {
      themeSwitch: CompactThemeSwitch,
    },
  };
}
