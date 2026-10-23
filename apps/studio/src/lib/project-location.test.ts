import { expect, test } from "bun:test";
import { pastedLocation } from "./project-location";

test("pasted coordinates and Google Maps links become a location without a lookup", () => {
  expect(pastedLocation("-33.45, -70.66")).toEqual({ label: "-33.45, -70.66", latitude: -33.45, longitude: -70.66 });
  expect(pastedLocation(" -33.4372 -70.6506 ")).toEqual({ label: "-33.4372, -70.6506", latitude: -33.4372, longitude: -70.6506 });
  expect(pastedLocation("https://www.google.com/maps/place/Plaza+de+Armas/@-33.4378305,-70.6504492,17z/data=!3m1")).toEqual({ label: "-33.43783, -70.65045", latitude: -33.4378305, longitude: -70.6504492 });
  expect(pastedLocation("https://maps.google.com/?q=-33.45%2C-70.66")?.latitude).toBe(-33.45);
  for (const text of ["Plaza de Armas, Santiago", "91, 10", "10, 181", "", "-33.45"]) expect(pastedLocation(text)).toBeNull();
});
