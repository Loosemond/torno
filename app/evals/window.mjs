// Opening a project in the window as a person does, for the evals: what `e2e/objects.ts` `openListed` does, in plain
// JavaScript (the runner is not compiled). Keep the two alike.

export async function openListed(page, name) {
  const list = page.getByRole('navigation', { name: 'Projects' })
  await list.locator('.object-row, .object-switcher').first().waitFor()
  const switcher = list.locator('.object-switcher')
  if (await switcher.isVisible()) {
    if ((await switcher.getAttribute('aria-pressed')) !== 'true' && (await switcher.locator('.row-name').innerText()) === name) return
    await switcher.click()
    await page.getByRole('menu', { name: 'Projects' }).getByRole('menuitem', { name, exact: true }).click()
  } else await list.getByRole('button', { name, exact: true }).click()
}
