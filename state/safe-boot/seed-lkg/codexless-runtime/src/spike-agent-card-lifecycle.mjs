// Spike Agent Card lifecycle state machine (Spike Bridge).
//
// Single source of truth for the card widget's multi-turn acceptance rules.
// The SAME function bodies run in Node gates and inside the widget:
// spike-agent-card-ui.mjs embeds Function.prototype.toString() of these exports
// into the delivered HTML. Refresh cadence is deliberately NOT part of this
// state machine: the mounted card refreshes only on explicit user action.

export const AGENT_CARD_SCHEMA_VERSION = "spike.agent-card.v1";

export function agentCardIsTerminalStatus(status) {
  return ["completed", "failed", "interrupted", "rejected", "lost"].includes(status);
}

export function createAgentCardView() {
  return {
    provider: null, // provider id of the mounted task
    taskRef: null, // mounted task identity (stable across turns when the provider reports one)
    opRef: null, // operational ref for spike.agent_status / spike.agent_cancel
    turnRef: null, // current turn
    turns: [], // accepted turn refs, oldest first
    revision: -1,
    updatedAt: 0,
    startedAt: null,
    terminal: false,
    status: null,
    capabilities: {},
    approval: null,
    card: null, // last accepted canonical card
  };
}

// Accept or reject one incoming canonical card for this widget instance.
// Returns { ok, reason, view } where `view` is the (possibly unchanged) view.
//
// Rules (Spike Agent Card V1 contract):
//   same taskRef + same turnRef -> terminal never reverts to non-terminal
//   same taskRef + new turnRef  -> completed may become running again
//   a superseded (older) turn   -> never repaints the card
//   stale revision/updatedAt    -> never overwrites a newer same-turn response
//   a foreign taskRef           -> never pollutes the mounted card
export function acceptAgentCardView(previous, card) {
  const view = previous && typeof previous === "object" ? previous : createAgentCardView();
  if (!card || typeof card !== "object" || card.schemaVersion !== "spike.agent-card.v1") {
    return { ok: false, reason: "schema", view };
  }
  const providerId = card.provider && typeof card.provider.id === "string" && card.provider.id ? card.provider.id : null;
  if (!providerId) return { ok: false, reason: "missing-provider", view };
  const turnRef = card.turn && typeof card.turn.turnRef === "string" && card.turn.turnRef ? card.turn.turnRef : null;
  if (!turnRef) return { ok: false, reason: "missing-turn", view };

  const incomingStatus = card.state && typeof card.state.status === "string" && card.state.status ? card.state.status : "unknown";
  const incomingTerminal = (card.state && card.state.terminal === true) || agentCardIsTerminalStatus(incomingStatus);
  const incomingRevision = card.turn && Number.isFinite(card.turn.revision) ? card.turn.revision : -1;
  const incomingUpdatedAt = card.state && Number.isFinite(card.state.updatedAt) ? card.state.updatedAt : 0;
  const taskRef = card.task && typeof card.task.taskRef === "string" && card.task.taskRef ? card.task.taskRef : null;
  const parentTaskRef = card.task && typeof card.task.parentTaskRef === "string" && card.task.parentTaskRef ? card.task.parentTaskRef : null;

  const sameTurn = view.turnRef !== null && turnRef === view.turnRef;
  if (view.provider !== null) {
    if (providerId !== view.provider) return { ok: false, reason: "provider-mismatch", view };
    if (sameTurn) {
      // Terminal is sticky within one turn.
      if (view.terminal && !incomingTerminal) return { ok: false, reason: "terminal-sticky", view };
      const hasStableRevision = incomingRevision >= 0 && view.revision >= 0;
      const newer = hasStableRevision
        ? incomingRevision > view.revision
        : incomingUpdatedAt > view.updatedAt;
      if (!newer) return { ok: false, reason: "stale", view };
    } else {
      // A turn this card already superseded may never repaint it.
      if (view.turns.includes(turnRef)) return { ok: false, reason: "superseded-turn", view };
      // New-turn linkage: explicit taskRef equality, ancestry into any turn we
      // have seen (send chaining), or a provider that reports no task identity
      // at all (the widget channel itself is then the task scope).
      const linked = taskRef !== null && (taskRef === view.taskRef || view.turns.includes(taskRef));
      const ancestry = parentTaskRef !== null && (parentTaskRef === view.turnRef || view.turns.includes(parentTaskRef));
      const unlinked = taskRef === null;
      if (!linked && !ancestry && !unlinked) return { ok: false, reason: "foreign-task", view };
      // New turn reached: terminal -> running is legal again (multi-turn fix).
    }
  }

  let acceptedCard = card;
  if (view.card && typeof view.card === "object") {
    const prior = view.card;
    const keep = (incoming, fallback) => incoming !== null && incoming !== undefined && incoming !== "" ? incoming : (fallback ?? null);
    const mergeKnown = (previousValue, incomingValue, keys) => {
      const previousObject = previousValue && typeof previousValue === "object" ? previousValue : {};
      const incomingObject = incomingValue && typeof incomingValue === "object" ? incomingValue : {};
      const merged = { ...previousObject, ...incomingObject };
      for (const key of keys) merged[key] = keep(incomingObject[key], previousObject[key]);
      return merged;
    };
    const task = mergeKnown(prior.task, card.task, ["title", "project", "cwd", "invocationRationale"]);
    const execution = mergeKnown(prior.execution, card.execution, ["requestedModel", "resolvedModel", "reasoningEffort", "sessionId", "host"]);
    const account = prior.account || card.account
      ? mergeKnown(prior.account, card.account, ["slot", "label", "plan", "name", "identifier"])
      : null;
    let quota = card.quota;
    let usage = card.usage;
    let result = card.result;
    const carryCallSnapshot = sameTurn || view.status === "consent_required";
    if (carryCallSnapshot) {
      const previousQuota = prior.quota && typeof prior.quota === "object" ? prior.quota : {};
      const incomingQuota = card.quota && typeof card.quota === "object" ? card.quota : {};
      if (previousQuota.available === true || incomingQuota.available === true) {
        quota = {
          ...previousQuota,
          ...incomingQuota,
          available: previousQuota.available === true || incomingQuota.available === true,
          plan: keep(incomingQuota.plan, previousQuota.plan),
          before: incomingQuota.before ?? previousQuota.before ?? null,
          after: incomingQuota.after ?? previousQuota.after ?? null,
        };
      }
      const previousUsage = prior.usage && typeof prior.usage === "object" ? prior.usage : {};
      const incomingUsage = card.usage && typeof card.usage === "object" ? card.usage : {};
      if (previousUsage.available === true || incomingUsage.available === true) {
        usage = {
          ...previousUsage,
          ...incomingUsage,
          available: previousUsage.available === true || incomingUsage.available === true,
          turn: incomingUsage.turn ?? previousUsage.turn ?? null,
          cumulative: incomingUsage.cumulative ?? previousUsage.cumulative ?? null,
          contextWindow: keep(incomingUsage.contextWindow, previousUsage.contextWindow),
        };
      }
      result = mergeKnown(prior.result, card.result, ["summary", "error", "changedFiles", "verification"]);
    }
    acceptedCard = { ...card, task, execution, account, quota, usage, result };
  }

  const next = { ...view, turns: view.turns.slice() };
  next.provider = providerId;
  if (next.taskRef === null || (taskRef !== null && taskRef !== next.taskRef)) next.taskRef = taskRef ?? next.taskRef;
  if (!next.turns.includes(turnRef)) next.turns.push(turnRef);
  if (next.turns.length > 50) next.turns.splice(0, next.turns.length - 50);
  next.turnRef = turnRef;
  next.opRef = card.task && typeof card.task.agentRef === "string" && card.task.agentRef ? card.task.agentRef : turnRef;
  next.terminal = incomingTerminal;
  next.status = incomingStatus;
  next.revision = incomingRevision;
  next.updatedAt = incomingUpdatedAt;
  next.startedAt = card.state && Number.isFinite(card.state.startedAt) ? card.state.startedAt : null;
  next.capabilities = card.capabilities && typeof card.capabilities === "object" ? card.capabilities : {};
  next.approval = card.approval && typeof card.approval === "object" ? card.approval : null;
  next.card = acceptedCard;
  return { ok: true, reason: sameTurn ? "update" : "new-turn", view: next };
}
