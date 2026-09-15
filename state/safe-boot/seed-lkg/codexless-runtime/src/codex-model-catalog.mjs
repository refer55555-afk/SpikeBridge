export function projectCodexModel(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = typeof entry.id === "string" ? entry.id : null;
  const model = typeof entry.model === "string" ? entry.model : null;
  if (!id && !model) return null;
  return {
    id,
    model,
    displayName: typeof entry.displayName === "string" ? entry.displayName : null,
    description: typeof entry.description === "string" ? entry.description : null,
    modelSpecialty: typeof entry.modelSpecialty === "string" ? entry.modelSpecialty : null,
    hidden: entry.hidden === true,
    isDefault: entry.isDefault === true,
    defaultReasoningEffort: typeof entry.defaultReasoningEffort === "string" ? entry.defaultReasoningEffort : null,
    supportedReasoningEfforts: Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.map((option) => ({
          reasoningEffort: typeof option?.reasoningEffort === "string" ? option.reasoningEffort : null,
          description: typeof option?.description === "string" ? option.description : null,
        }))
      : [],
    serviceTiers: Array.isArray(entry.serviceTiers)
      ? entry.serviceTiers.map((tier) => ({
          id: typeof tier?.id === "string" ? tier.id : null,
          name: typeof tier?.name === "string" ? tier.name : null,
          description: typeof tier?.description === "string" ? tier.description : null,
        }))
      : [],
    defaultServiceTier: typeof entry.defaultServiceTier === "string" ? entry.defaultServiceTier : null,
  };
}
