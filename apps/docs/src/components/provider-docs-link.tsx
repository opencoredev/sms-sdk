import type { ProviderName } from "@opencoredev/sandbox-sdk";
import { getProviderMetadata } from "@opencoredev/sandbox-sdk/metadata";
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import { FieldGuideIcon } from "./docs-icon";

export function ProviderDocsLink({
  provider,
  variant = "inline",
}: {
  provider: ProviderName;
  variant?: "inline" | "button";
}) {
  const metadata = getProviderMetadata(provider);

  return (
    <a
      href={metadata.officialUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${metadata.displayName} documentation in a new tab`}
      className={
        variant === "button"
          ? buttonVariants({
              color: "secondary",
              size: "sm",
              className: "gap-2 not-prose [&_svg]:size-3.5 [&_svg]:text-fd-muted-foreground",
            })
          : "inline-flex items-center gap-1 whitespace-nowrap"
      }
    >
      {variant === "button" ? "Provider docs" : "Official docs"}
      <FieldGuideIcon aria-hidden="true" className="size-3.5" name="externalLink" />
    </a>
  );
}
