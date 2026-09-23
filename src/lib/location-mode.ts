import type { LocationType } from './types';

export const LOCATION_MODES = ['DIRECT', 'CONTROLLED'] as const;
export type LocationMode = (typeof LOCATION_MODES)[number];

export function locationMode(type: string | null | undefined): LocationMode {
  return type === 'WAREHOUSE' ? 'CONTROLLED' : 'DIRECT';
}

export const LOCATION_MODE_LABELS: Record<LocationMode, string> = {
  DIRECT: 'Fast / Direct Mode',
  CONTROLLED: 'Controlled / Audited Mode',
};

export const LOCATION_MODE_DESCRIPTIONS: Record<LocationMode, string> = {
  DIRECT: 'Immediate sales and stock updates for retail operations.',
  CONTROLLED: 'Stock changes require documented adjustments and approval.',
};

export function isControlledLocation(type: string | LocationType | null | undefined): boolean {
  return locationMode(type) === 'CONTROLLED';
}
