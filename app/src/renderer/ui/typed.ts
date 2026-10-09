/** What was typed as a number; NaN for what is none. */
export const typed = (text: string): number => {
  const cleaned = text.trim().replace(',', '.').replace('−', '-')
  return cleaned === '' ? Number.NaN : Number(cleaned)
}
