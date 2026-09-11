// Spherical geometry on the WGS84 mean radius. Distances are metres, angles degrees.

const R_EARTH_M = 6371008.8;
const DEG = Math.PI / 180;

/** Great-circle distance in metres between two WGS84 points. */
export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dPhi = (lat2 - lat1) * DEG;
  const dLambda = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing from point 1 to point 2, in degrees true [0, 360). */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEG;
  const phi2 = lat2 * DEG;
  const dLambda = (lon2 - lon1) * DEG;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return norm360((Math.atan2(y, x) * 180) / Math.PI);
}

/** Wrap an angle into [0, 360). */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Smallest absolute angle between two bearings, in [0, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(norm360(a) - norm360(b));
  return d > 180 ? 360 - d : d;
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** Latitude/longitude box that contains every point within `radiusM` of the centre. */
export function bboxAround(lat: number, lon: number, radiusM: number): BBox {
  const dLat = (radiusM / R_EARTH_M) / DEG;
  // Guard against the cosine collapsing near the poles; the widget only ever sees
  // Alpine latitudes, but a division by ~0 would produce a NaN box.
  const cos = Math.max(Math.cos(lat * DEG), 1e-6);
  const dLon = dLat / cos;
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon,
  };
}
