import { z } from 'zod';

// Network handover details captured at the docs stage. The lead carries a LIST
// of typed IP entries: ISP IPs come with an IRINN email; Gazon IPs are ours, so
// no IRINN. IPv4/IPv6 are free text (blocks, ranges, or lists) — length-bounded
// rather than strictly format-checked. Everything optional: IP blocks are often
// assigned later.
const blankToUndef = (v) => {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  return v ?? undefined;
};

const optEmail = z.preprocess(blankToUndef, z.string().email('Enter a valid IRINN email.').max(200).optional());

// A list of IP strings. Accepts a bare string too (wrapped), drops blanks, and
// collapses to undefined when nothing usable remains.
const ipList = z.preprocess((v) => {
  const arr = Array.isArray(v) ? v : [v];
  const cleaned = arr.map(blankToUndef).filter((s) => s !== undefined);
  return cleaned.length ? cleaned : undefined;
}, z.array(z.string().max(500)).max(50).optional());

export const IP_ENTRY_TYPES = ['ISP', 'GAZON'];

const entrySchema = z.object({
  type: z.enum(IP_ENTRY_TYPES),
  irinnEmail: optEmail, // ISP entries only — stripped from GAZON below
  ipv4: ipList,
  ipv6: ipList,
});

const ipDetailsSchema = z.object({
  entries: z.array(entrySchema).max(50),
});

// Legacy flat body ({ irinnEmail, ipv4, ipv6 }) → a single ISP entry, so old
// clients/data keep working while everything persists in the list shape.
const toEntriesShape = (body = {}) =>
  Array.isArray(body.entries)
    ? { entries: body.entries }
    : { entries: [{ type: 'ISP', irinnEmail: body.irinnEmail, ipv4: body.ipv4, ipv6: body.ipv6 }] };

export const validateIpDetails = (body = {}) => {
  const result = ipDetailsSchema.safeParse(toEntriesShape(body));
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const entries = result.data.entries
    .map(({ type, irinnEmail, ipv4, ipv6 }) => ({
      type,
      // IRINN email belongs to ISP-sourced IPs only.
      ...(type === 'ISP' && irinnEmail !== undefined ? { irinnEmail } : {}),
      ...(ipv4 !== undefined ? { ipv4 } : {}),
      ...(ipv6 !== undefined ? { ipv6 } : {}),
    }))
    // Drop entries that carry no data at all (just a type picked, nothing typed).
    .filter((e) => Object.keys(e).length > 1);
  // Collapse an all-blank payload to null so we don't store empty noise.
  return { ok: true, data: entries.length ? { entries } : null };
};
