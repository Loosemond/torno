/**
 * What of the CLI's `permission_suggestions` torno passes back as `updatedPermissions` when the person says "Allow
 * for this session": the rules to add (`addRules`), each made a rule of the session. Where the CLI would keep a rule
 * (`localSettings` is a file in the object's folder, `userSettings` the person's own), what it would do to the
 * directories it may reach, and the mode it would switch to, are not for a button in a chat to decide: every other
 * kind is dropped, and so is a rule that names no rule.
 */
export function sessionRules(suggestions: unknown): unknown[] {
  if (!Array.isArray(suggestions)) return []
  return suggestions.flatMap((one) => {
    if (typeof one !== 'object' || one === null) return []
    const suggestion = one as { type?: unknown; rules?: unknown }
    if (suggestion.type !== 'addRules' || !Array.isArray(suggestion.rules) || suggestion.rules.length === 0) return []
    return [{ ...suggestion, destination: 'session' }]
  })
}
