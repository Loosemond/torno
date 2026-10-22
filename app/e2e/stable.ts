import { expect, type Locator } from '@playwright/test'

// The bars at the foot of the view slide a row up or down (a finite transition of `bottom`, 120 ms) when the line
// there comes or goes, or the view's width changes. A test that reads where one is waits for it to be still:
// never a fixed sleep.

/** The box of an element once it has stopped moving: the same on two reads a frame or so apart. */
export async function stableBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = ''
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await locator.boundingBox())
        const still = now === last
        last = now
        return still
      },
      { intervals: [50] }
    )
    .toBe(true)
  return (await locator.boundingBox())!
}
