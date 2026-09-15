// Generic Agent Card view (Spike Bridge).
//
// Provider-agnostic DATA MODEL for agent cards. This does not replace the
// Codex Task Card presentation (agent-card-ui.mjs) — Codex agent tools keep
// their exact fixed-text surface. This view gives every provider's payload a
// common normalized shape:
//
//   { provider, ref, model, status, durationMs, usage, quota, task, result, error }
//
// Discipline: fields that cannot be observed are "UNKNOWN" (or null for
// task/result which may legitimately be absent). Nothing is guessed.

const UNKNOWN = "UNKNOWN";

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

export function renderAgentCard(payload, canonicalCard = null) {
  if (canonicalCard && typeof canonicalCard === "object" && canonicalCard.schemaVersion === "spike.agent-card.v1") {
    const execution = canonicalCard.execution ?? {};
    const task = canonicalCard.task ?? {};
    const usage = canonicalCard.usage?.available === true
      ? (canonicalCard.usage.turn ?? canonicalCard.usage.cumulative ?? UNKNOWN)
      : UNKNOWN;
    const quota = canonicalCard.quota?.available === true ? canonicalCard.quota : UNKNOWN;
    return {
      provider: canonicalCard.provider?.id ?? payload?.provider ?? UNKNOWN,
      ref: firstDefined(task.agentRef, canonicalCard.turn?.turnRef, payload?.ref, payload?.agentRef) ?? UNKNOWN,
      model: firstDefined(execution.resolvedModel, execution.requestedModel) ?? UNKNOWN,
      status: canonicalCard.state?.status ?? payload?.status ?? UNKNOWN,
      durationMs: Number.isFinite(canonicalCard.state?.elapsedMs) ? canonicalCard.state.elapsedMs : UNKNOWN,
      usage,
      quota,
      task: firstDefined(task.title, task.project, payload?.task, payload?.prompt) ?? null,
      result: canonicalCard.result?.summary ?? null,
      error: canonicalCard.result?.error ?? null,
    };
  }
  if (!payload || typeof payload !== "object") {
    return { provider: UNKNOWN, ref: UNKNOWN, model: UNKNOWN, status: UNKNOWN, durationMs: UNKNOWN, usage: UNKNOWN, quota: UNKNOWN, task: null, result: null, error: "no provider payload" };
  }
  const card = payload.taskCard && typeof payload.taskCard === "object" ? payload.taskCard : {};
  const usage = firstDefined(payload.usage, card.usage) ?? UNKNOWN;
  const quota = firstDefined(payload.quota, card.quota) ?? UNKNOWN;
  return {
    provider: payload.provider ?? UNKNOWN,
    ref: firstDefined(payload.ref, payload.agentRef, card.agentRef) ?? UNKNOWN,
    model: firstDefined(payload.model, card.model) ?? UNKNOWN,
    status: firstDefined(payload.status, payload.agentState?.status) ?? UNKNOWN,
    durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : UNKNOWN,
    usage,
    quota,
    task: firstDefined(payload.task, card.task, payload.prompt) ?? null,
    result: firstDefined(payload.response, payload.lastMessage, card.lastMessagePreview, payload.result) ?? null,
    error: firstDefined(payload.error, payload.detail) ?? null,
  };
}
