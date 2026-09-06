import { FieldGuideIcon } from "./docs-icon";

const releases = [
  { id: "01", title: "Foundation", href: "/docs/releases/foundation" },
  { id: "02", title: "Email paths", href: "/docs/releases/email" },
  { id: "03", title: "Safe sandboxes", href: "/docs/releases/sandbox" },
  { id: "04", title: "Field guide", href: "/docs/releases/field-guide" },
] as const;

export function ReleaseTrack() {
  return (
    <nav aria-label="Four-release path" className="release-track not-prose my-8">
      {releases.map((release) => (
        <a className="release-track__item" href={release.href} key={release.id}>
          <span className="release-track__number">{release.id}</span>
          <FieldGuideIcon className="release-track__badge" name="checkBadge" />
          <span>{release.title}</span>
          <FieldGuideIcon className="release-track__arrow" name="arrowRight" />
        </a>
      ))}
    </nav>
  );
}
