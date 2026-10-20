import { createCn } from "cn/config";

/** Class merging that knows the project's custom text sizes (`text-ui`, `text-2xs`), so a text colour never drops them. */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["ui", "2xs"] }] } },
});
