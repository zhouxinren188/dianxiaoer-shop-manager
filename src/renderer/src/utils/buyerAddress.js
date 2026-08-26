export function normalizeBuyerAddress(value) {
  return String(value || '')
    .trim()
    .replace(/[.。．]+\s*$/u, '')
    .trimEnd()
}
