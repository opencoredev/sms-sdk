# Provider logo sources

Sidebar marks for the Providers section. `theme.css` draws them; `blume.config.ts`
picks the variant with `PROVIDER_LOGOS=color|mono` (default `mono`).

- `color/` holds the official marks in brand colors. Plivo and Vonage publish
  black marks, so each has a white `-dark.svg` for dark mode, as their own
  sites do.
- `mono/` holds the same paths with `fill="currentColor"`. The sidebar uses
  them as CSS masks, so they take the row's text color.
- `neutral/` holds Lucide glyphs (ISC license) for the Overview and adapter
  guide rows.

| Mark | Source | Notes |
| --- | --- | --- |
| Twilio | Simple Icons `twilio` (CC0), https://cdn.jsdelivr.net/npm/simple-icons@16.34.0/icons/twilio.svg | Matches Twilio's pinned-tab mark on twilio.com. Color `#F22F46` from that mask-icon tag. |
| Telnyx | Favicon at https://telnyx.com/favicon.ico (750x750 PNG, same mark as the media kit at https://telnyx.com/media-kit) | Telnyx publishes this mark only as PNG, so it was traced to a vector with potrace. Color `#00E3AA` sampled from the favicon. |
| Plivo | https://www.plivo.com/images/brand/plivo-symbol.svg (linked from https://www.plivo.com/brand/) | Official symbol, viewBox cropped to the mark. |
| Vonage | Simple Icons `vonage` (CC0), source https://www.vonage.com | Brand color is black (`#000000`). |
| Overview | Lucide `layout-grid` via https://api.iconify.design/lucide/layout-grid.svg | |
| Adapter guide | Lucide `puzzle` via https://api.iconify.design/lucide/puzzle.svg | |

Brand marks belong to their owners and are used here only to identify each
provider's adapter.
