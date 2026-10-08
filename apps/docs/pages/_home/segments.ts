// Build-time segment math for the landing page's segment ruler. These are the
// standard GSM 03.38 rules, not the SDK's implementation; the docs content
// agent can swap this for `@opencoredev/sms-sdk/encoding` once it ships.

const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENDED = "^{}\\[~]|€\f";

export type Encoding = "GSM-7" | "UCS-2";

export interface SegmentEstimate {
  encoding: Encoding;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  units: number;
  /** Units that fit in one segment of this message. */
  perSegment: number;
  segments: number;
}

export const estimateSegments = (body: string): SegmentEstimate => {
  let septets = 0;
  for (const char of body) {
    if (GSM7_BASIC.includes(char)) septets += 1;
    else if (GSM7_EXTENDED.includes(char)) septets += 2;
    else {
      const units = body.length;
      const perSegment = units <= 70 ? 70 : 67;
      return { encoding: "UCS-2", units, perSegment, segments: Math.ceil(units / perSegment) };
    }
  }
  const perSegment = septets <= 160 ? 160 : 153;
  return { encoding: "GSM-7", units: septets, perSegment, segments: Math.ceil(septets / perSegment) };
};
