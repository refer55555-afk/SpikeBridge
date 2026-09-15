const DAY = 86_400_000;

function textKey(item) {
  return [
    item.kind, item.scope, item.provider || "", item.project || "", item.tool || "",
    item.title || "", item.error_signature || "", item.verified_fix || "", item.do_not_retry || "",
  ].map((value) => String(value).trim().toLowerCase()).join("\u001f");
}

function sameFactIdentity(a, b) {
  return a.kind === "fact" && b.kind === "fact" && a.title === b.title && a.scope === b.scope
    && (a.provider || null) === (b.provider || null)
    && (a.project || null) === (b.project || null)
    && (a.tool || null) === (b.tool || null);
}

function dateMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export class MemoryCompactor {
  constructor({ store } = {}) {
    if (!store) throw new TypeError("MemoryCompactor requires store");
    this.store = store;
  }

  compact({ now = Date.now(), vacuum = false } = {}) {
    const items = this.store.allItems({ includeRejected: true, limit: 100000 });
    const result = { duplicateMerged: 0, signatureMerged: 0, superseded: 0, expired: 0, evidenceDeleted: 0, rejectedDeleted: 0 };

    const exact = new Map();
    for (const item of items.filter((entry) => ["active", "candidate"].includes(entry.status))) {
      const key = textKey(item);
      const incumbent = exact.get(key);
      if (!incumbent) {
        exact.set(key, item);
        continue;
      }
      const keep = (incumbent.confidence === "verified" && item.confidence !== "verified") || dateMs(incumbent.created_at) <= dateMs(item.created_at)
        ? incumbent : item;
      const drop = keep.id === incumbent.id ? item : incumbent;
      this.store.updateStatus(drop.id, "rejected");
      const totalUses = Math.max(0, Number(keep.use_count ?? 0)) + Math.max(0, Number(drop.use_count ?? 0));
      const raw = this.store.getItem(keep.id);
      if (raw && totalUses > raw.use_count) {
        this.store.db.prepare("UPDATE memory_items SET use_count=?, updated_at=? WHERE id=?")
          .run(totalUses, new Date(now).toISOString(), keep.id);
      }
      exact.set(key, keep);
      result.duplicateMerged += 1;
    }

    const active = this.store.allItems({ includeRejected: false, limit: 100000 }).filter((entry) => entry.status === "active");
    const signatureGroups = new Map();
    for (const item of active) {
      if (!item.error_signature || !item.verified_fix) continue;
      const key = [item.scope, item.provider || "", item.project || "", item.tool || "", item.error_signature, item.verified_fix.toLowerCase()].join("\u001f");
      if (!signatureGroups.has(key)) signatureGroups.set(key, []);
      signatureGroups.get(key).push(item);
    }
    for (const group of signatureGroups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => (b.confidence === "verified") - (a.confidence === "verified") || dateMs(a.created_at) - dateMs(b.created_at));
      const keep = group[0];
      for (const drop of group.slice(1)) {
        this.store.updateStatus(drop.id, "superseded");
        result.signatureMerged += 1;
      }
      if (keep.confidence === "verified") this.store.updateStatus(keep.id, "active", { confidence: "verified", lastVerifiedAt: keep.last_verified_at });
    }

    const facts = this.store.allItems({ includeRejected: false, limit: 100000 })
      .filter((entry) => entry.kind === "fact" && entry.status === "active")
      .sort((a, b) => dateMs(a.valid_from || a.created_at) - dateMs(b.valid_from || b.created_at));
    for (let i = 0; i < facts.length; i += 1) {
      for (let j = i + 1; j < facts.length; j += 1) {
        const older = facts[i];
        const newer = facts[j];
        if (!sameFactIdentity(older, newer)) continue;
        if ((older.summary || "") === (newer.summary || "")) continue;
        if (this.store.getItem(older.id)?.status === "active") {
          this.store.updateStatus(older.id, "superseded", { validTo: newer.valid_from || newer.created_at || new Date(now).toISOString() });
          result.superseded += 1;
        }
      }
    }

    const current = this.store.allItems({ includeRejected: true, limit: 100000 });
    for (const item of current) {
      if (["superseded", "expired", "rejected"].includes(item.status)) continue;
      let shouldExpire = Boolean(item.expires_at && dateMs(item.expires_at) > 0 && dateMs(item.expires_at) <= now);
      if (!shouldExpire && item.status === "candidate" && item.confidence === "low") {
        shouldExpire = dateMs(item.updated_at || item.created_at) + 7 * DAY <= now;
      }
      if (!shouldExpire && item.status === "candidate" && item.confidence !== "verified") {
        shouldExpire = dateMs(item.updated_at || item.created_at) + 30 * DAY <= now;
      }
      if (shouldExpire) {
        this.store.updateStatus(item.id, "expired");
        result.expired += 1;
      }
    }

    if (!this.store.readonly) {
      const iso = new Date(now).toISOString();
      const operational = this.store.pruneOperational({ now });
      result.operationalJobsDeleted = operational.jobsDeleted;
      result.operationalFailuresDeleted = operational.failuresDeleted;
      const ev = this.store.db.prepare("DELETE FROM memory_evidence WHERE expires_at IS NOT NULL AND expires_at<=?").run(iso);
      result.evidenceDeleted = Number(ev.changes ?? 0);
      const rejectedCutoff = new Date(now - 30 * DAY).toISOString();
      const rej = this.store.db.prepare("DELETE FROM memory_items WHERE status='rejected' AND updated_at<=?").run(rejectedCutoff);
      result.rejectedDeleted = Number(rej.changes ?? 0);
      this.store.optimize({ vacuum });
    }
    return { ...result, stats: this.store.stats() };
  }
}
 
