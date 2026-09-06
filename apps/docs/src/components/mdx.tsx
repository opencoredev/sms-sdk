import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { ProviderCapabilityMatrix } from "@/components/capability-table";
import { ProviderAISDKExample } from "@/components/provider-ai-sdk-example";
import { ProviderCatalog } from "@/components/provider-catalog";
import { ProviderDocsLink } from "@/components/provider-docs-link";
import { QuestBoard } from "@/components/quest-board";
import { ReleaseTrack } from "@/components/release-track";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ProviderAISDKExample,
    ProviderCapabilityMatrix,
    ProviderCatalog,
    ProviderDocsLink,
    QuestBoard,
    ReleaseTrack,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
