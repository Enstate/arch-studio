import type { ProjectFacts } from "@arch/project";

export type ProjectLocation = NonNullable<ProjectFacts["location"]>;

const number = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
// A Google Maps link carries the place as "@lat,lon" in its path or as "q=lat,lon" in its query.
const mapLink = new RegExp(String.raw`(?:@|[?&](?:q|query|ll)=)${number}(?:,|%2C)\s*${number}`, "i");
const pair = new RegExp(String.raw`^${number}\s*[,;\s]\s*${number}$`);

/**
 * Coordinates pasted as "-33.45, -70.66" or found in a Google Maps link. Works offline, so a
 * location never depends on reaching OpenStreetMap.
 */
export function pastedLocation(text: string): ProjectLocation | null {
  const value = text.trim();
  const match = mapLink.exec(value) ?? pair.exec(value);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { label: coordinates({ latitude, longitude }), latitude, longitude };
}

/** Latitude and longitude as people paste them, about a metre precise. */
export function coordinates(location: Pick<ProjectLocation, "latitude" | "longitude">) {
  const short = (value: number) => String(Number(value.toFixed(5)));
  return `${short(location.latitude)}, ${short(location.longitude)}`;
}

export const sameLocation = (a: ProjectLocation | undefined, b: ProjectLocation | undefined) =>
  !!a && !!b && a.label === b.label && a.latitude === b.latitude && a.longitude === b.longitude;
