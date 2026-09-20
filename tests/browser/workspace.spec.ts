import { test, expect } from "@playwright/test";
test("demo navigation, editable presentation and honest execution boundary", async ({
  page,
  isMobile,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: "Good to see you, Alex." }),
  ).toBeVisible();
  await expect(
    page.getByText("Explore Harbor with fictional data.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare for a meeting", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Give your assistant a task" }),
  ).toHaveValue("Prepare for a meeting");
  await page.getByRole("button", { name: "Start task", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "This demo sends no requests",
  );
  if (isMobile)
    await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "My assistant", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Cove");
  await page
    .getByRole("button", { name: "Save preferences", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Cove", exact: true }),
  ).toBeVisible();
  if (isMobile)
    await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "My wiki", exact: true }).click();
  await page.getByRole("button", { name: "Edit page", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Page content" })
    .fill("A fictional corrected preference.");
  await page.getByRole("button", { name: "Save page" }).click();
  await expect(
    page.getByText("A fictional corrected preference.", { exact: true }),
  ).toBeVisible();
  if (isMobile)
    await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: "Administration", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "A clear view for IT." }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "Alex Morgan" })).toBeVisible();
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
