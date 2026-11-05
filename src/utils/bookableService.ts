export type ClinicServiceRow = {
  id: string;
  name: string;
  durationMinutes: number;
};

export type BookableService =
  | { ok: true; name: string; durationMinutes: number; serviceId: string | null }
  | { ok: false; code: 'SERVICE_UNAVAILABLE' | 'SERVICE_NOT_OFFERED'; message: string };

/**
 * A clinic with no service catalog keeps free-text booking.
 * A clinic with services only accepts an active name.
 * A doctor with linked services only accepts one of those links.
 */
export function pickBookableService(input: {
  requested: string;
  clinicServices: ClinicServiceRow[];
  doctorLinkedServiceIds: string[] | null;
}): BookableService {
  const requested = input.requested.trim();
  if (!input.clinicServices.length) {
    return {
      ok: true,
      name: requested || 'General Consultation',
      durationMinutes: 30,
      serviceId: null,
    };
  }

  const generic = !requested || requested.toLowerCase() === 'general consultation';
  let match = input.clinicServices.find(
    (row) => row.name.trim().toLowerCase() === requested.toLowerCase()
  );
  if (!match && generic) {
    const consults = input.clinicServices.filter((row) => {
      const name = row.name.trim().toLowerCase();
      return name === 'consultation' || name === 'consult' || name.includes('general consultation');
    });
    if (consults.length === 1) match = consults[0];
  }
  if (!match) {
    const names = input.clinicServices.map((row) => row.name).join(', ');
    return {
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: requested
        ? `"${requested}" is not an active service at this clinic. Available: ${names}.`
        : `Choose one of this clinic's services: ${names}.`,
    };
  }

  const links = input.doctorLinkedServiceIds;
  if (links && links.length > 0 && !links.includes(match.id)) {
    return {
      ok: false,
      code: 'SERVICE_NOT_OFFERED',
      message: `This doctor does not offer ${match.name}.`,
    };
  }

  return {
    ok: true,
    name: match.name,
    durationMinutes: match.durationMinutes > 0 ? match.durationMinutes : 30,
    serviceId: match.id,
  };
}
