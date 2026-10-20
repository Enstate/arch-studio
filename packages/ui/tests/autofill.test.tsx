import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Input } from "../src/components/input";
import { Textarea } from "../src/components/textarea";

test.each([
  ["project names", () => <Input name="project-name" />],
  ["invitation addresses", () => <Input name="invitation-email" type="email" />],
  ["comments", () => <Textarea name="comment" />],
])("%s opt out of saved autofill", (_label, control) => {
  const html = renderToStaticMarkup(control());
  expect(html).toMatch(/autocomplete="off"/i);
  expect(html).toContain('data-1p-ignore="true"');
});

test("authentication autocomplete tokens keep password-manager filling enabled", () => {
  for (const autoComplete of ["username", "email", "current-password", "new-password"]) {
    const html = renderToStaticMarkup(<Input autoComplete={autoComplete} />);
    expect(html).toMatch(new RegExp(`autocomplete="${autoComplete}"`, "i"));
    expect(html).not.toContain('data-1p-ignore="true"');
  }
});
