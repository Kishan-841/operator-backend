import { z } from 'zod';

// A fiber segment chosen at feasibility. Three kinds:
//   OWN    — our own network (no vendor, no client).
//   VENDOR — a Vendor record; the server snapshots vendorName/vendorType from the
//            DB, so clients only send kind/vendorId here.
//   CLIENT — Client Fiber: NOT a vendor. The feasibility user free-types the name
//            of the client whose fiber we'll use; extra details go in the notes.
// Every kind carries a point-to-point length in metres and an optional A→B path.
const point = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

const segmentSchema = z
  .object({
    kind: z.enum(['OWN', 'VENDOR', 'CLIENT'], {
      message: 'Each segment must be Own Network, a vendor, or client fiber.',
    }),
    vendorId: z.string().uuid().optional(),
    clientName: z.string().trim().min(1, 'Enter the client name.').max(200).optional(),
    fiberMeters: z.coerce.number().positive('Fiber metres must be greater than 0.'),
    // Optional path — all four coordinates required together, or omit entirely.
    path: z.object({ a: point, b: point }).optional(),
  })
  .refine((s) => (s.kind === 'VENDOR' ? Boolean(s.vendorId) : true), {
    message: 'A vendor must be selected for vendor segments.',
    path: ['vendorId'],
  })
  .refine((s) => (s.kind === 'CLIENT' ? Boolean(s.clientName) : true), {
    message: 'Enter the name of the client whose fiber we will use.',
    path: ['clientName'],
  })
  .refine((s) => (s.kind === 'OWN' ? !s.vendorId && !s.clientName : true), {
    message: 'Own Network segments cannot reference a vendor or client.',
    path: ['vendorId'],
  });

const vendorsSchema = z.array(segmentSchema).min(1, 'Add at least one fiber segment.');

/**
 * Validate the feasibility segment list a client submits.
 * Returns { ok, data } or { ok:false, errors:[{path,message}] }.
 * Vendor existence + name/type enrichment happens in the state machine.
 */
export const validateFeasibilityVendors = (input) => {
  const result = vendorsSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  return { ok: true, data: result.data };
};
