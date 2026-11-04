import type { Building, Society, User, UserConsent } from '@prisma/client';

export function presentMe(
  user: User,
  society: Society | null,
  building: Building | null,
  consents: UserConsent[],
) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    photoUrl: user.photoUrl,
    language: user.language,
    role: user.role,
    membershipStatus: user.membershipStatus,
    flatNumber: user.flatNumber,
    society: society
      ? {
          id: society.id,
          name: society.name,
          area: society.area,
          city: society.city,
          code: society.code,
        }
      : null,
    building: building ? { id: building.id, name: building.name } : null,
    consents: consents.map((consent) => ({
      type: consent.type,
      version: consent.version,
      granted: consent.granted,
      createdAt: consent.createdAt.toISOString(),
    })),
  };
}
