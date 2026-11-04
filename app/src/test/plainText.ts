/** The text of some markup, tags taken out: the replace is repeated until nothing changes, so a tag cannot be left whole by taking out another. */
export function plainText(markup: string): string {
  let text = markup
  for (let before = ''; before !== text; ) {
    before = text
    text = text.replace(/<[^>]*>/g, '')
  }
  return text
}
