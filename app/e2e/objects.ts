import { expect, type Page } from '@playwright/test'

// The list of objects in the left column as a person uses it: its row, or, while it is folded to the switcher
// (an object open in a workspace of several), the switcher's menu. The menu's items have the objects' names, as
// the rows do.

/** The navigation of the objects in the left column. */
export const objectList = (page: Page) => page.getByRole('navigation', { name: 'Projects' })

/** The switcher the list is folded to, while it is. */
export const switcher = (page: Page) => objectList(page).locator('.object-switcher')

/** Opens an object by its name, as a person does: its row, or the switcher's menu. The object open already stays as it is. */
export async function openListed(page: Page, name: string): Promise<void> {
  const list = objectList(page)
  // One of the two is there once the workspace is.
  await expect(list.locator('.object-row, .object-switcher').first()).toBeVisible()
  if (await switcher(page).isVisible()) {
    if ((await switcher(page).getAttribute('aria-pressed')) !== 'true' && (await switcherName(page)) === name) return
    await switcher(page).click()
    await page.getByRole('menu', { name: 'Projects' }).getByRole('menuitem', { name, exact: true }).click()
  } else await list.getByRole('button', { name, exact: true }).click()
}

/** "New object", from the list, or from the foot of the switcher's menu. */
export async function newFromList(page: Page): Promise<void> {
  const list = objectList(page)
  await expect(list.locator('.new-object-button, .object-switcher').first()).toBeVisible()
  if (await switcher(page).isVisible()) {
    // The page of the new object is up already: the switcher says so, pressed.
    if ((await switcher(page).getAttribute('aria-pressed')) === 'true') return
    await switcher(page).click()
    await page.getByRole('menu', { name: 'Projects' }).getByRole('menuitem', { name: 'New project' }).click()
  } else await list.getByRole('button', { name: 'New project' }).click()
}

const switcherName = (page: Page): Promise<string> => switcher(page).locator('.row-name').innerText()
