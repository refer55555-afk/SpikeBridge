import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "./redaction.mjs";
import { resolveSpikeBridgeRoot, spikeMemoryDbFile } from "../spike-paths.mjs";
import { normalizeMemoryProvider } from "./provider-identity.mjs";

const KINDS = new Set(["fact", "lesson", "procedure", "runbook", "do_not_retry"]);
const STATUSES = new Set(["candidate", "active", "superseded", "expired", "rejected"]);
const CONFIDENCE = new Set(["low", "medium", "verified"]);
const SCOPES = new Set(["global", "machine", "provider", "project", "tool"]);

function nowIso() { return new Date().toISOString(); }
function cleanText(value) {
  if (value === null || value === undefined) return null;
  return redactSecrets(String(value)).trim() || null;
}
function cleanJson(value, fallback = []) {
  const parsed = Array.isArray(value) ? value : fallback;
  return JSON.stringify(parsed.map((v) => cleanText(v)).filter(Boolean));
}
function normalizeNullable(value) {
  const text = cleanText(value);
  return text || null;
}
function boolInt(value) { return value ? 1 : 0; }

export function defaultMemoryDbPath() {
  return process.env.SPIKE_BRIDGE_MEMORY_DB?.trim()
    || spikeMemoryDbFile(resolveSpikeBridgeRoot({ defaultCwd: process.cwd() }));
}

export class MemoryStore {
  constructor({ dbPath = defaultMemoryDbPath(), readonly = false } = {}) {
    this.dbPath = path.resolve(dbPath);
    this.readonly = readonly;
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { readOnly: readonly });
    this.ftsAvailable = false;
    this.#init();
  }

  #init() {
    if (!this.readonly) {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2500;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_items (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          scope TEXT NOT NULL,
          provider TEXT,
          provider_family TEXT,
          provider_id TEXT,
          project TEXT,
          tool TEXT,
          title TEXT NOT NULL,
          trigger TEXT,
          summary TEXT,
          failed_approach TEXT,
          root_cause TEXT,
          verified_fix TEXT,
          do_not_retry TEXT,
          error_signature TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          confidence TEXT NOT NULL,
          status TEXT NOT NULL,
          core INTEGER NOT NULL DEFAULT 0,
          evidence_ref TEXT,
          valid_from TEXT,
          valid_to TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_verified_at TEXT,
          last_used_at TEXT,
          use_count INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT
        );
        CREATE TABLE IF NOT EXISTS memory_evidence (
          id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          job_id TEXT,
          provider TEXT,
          provider_family TEXT,
          provider_id TEXT,
          project TEXT,
          tool TEXT,
          event_type TEXT NOT NULL,
          error_code TEXT,
          error_excerpt TEXT,
          result_excerpt TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          FOREIGN KEY(memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_memory_items_active_scope ON memory_items(status, scope, provider, project, tool);
        CREATE INDEX IF NOT EXISTS idx_memory_items_signature ON memory_items(error_signature, status);
        CREATE INDEX IF NOT EXISTS idx_memory_items_expiry ON memory_items(expires_at, status);
        CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory ON memory_evidence(memory_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_memory_evidence_expiry ON memory_evidence(expires_at);

        CREATE TABLE IF NOT EXISTS memory_jobs (
          job_key TEXT PRIMARY KEY,
          provider TEXT,
          provider_family TEXT,
          provider_id TEXT,
          project TEXT,
          task_hash TEXT,
          ref TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_jobs_ref ON memory_jobs(provider_family, provider_id, ref, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_jobs_expiry ON memory_jobs(expires_at);

        CREATE TABLE IF NOT EXISTS memory_failures (
          id TEXT PRIMARY KEY,
          job_key TEXT NOT NULL,
          signature TEXT NOT NULL,
          provider_family TEXT,
          provider_id TEXT,
          project TEXT,
          tool TEXT,
          observed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_failures_job ON memory_failures(job_key, signature, observed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_failures_scope ON memory_failures(signature, provider_family, provider_id, project, tool, observed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_failures_expiry ON memory_failures(expires_at);
      `);
      this.#ensureColumn("memory_items", "root_cause", "TEXT");
      this.#ensureColumn("memory_items", "core", "INTEGER NOT NULL DEFAULT 0");
      this.#ensureColumn("memory_items", "provider_family", "TEXT");
      this.#ensureColumn("memory_items", "provider_id", "TEXT");
      this.#ensureColumn("memory_evidence", "provider_family", "TEXT");
      this.#ensureColumn("memory_evidence", "provider_id", "TEXT");
      this.#ensureColumn("memory_evidence", "failure_id", "TEXT");
      this.#ensureColumn("memory_failures", "error_code", "TEXT");
      this.#ensureColumn("memory_failures", "error_excerpt", "TEXT");
      this.#ensureColumn("memory_failures", "resolved_at", "TEXT");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_evidence_failure ON memory_evidence(memory_id,failure_id) WHERE failure_id IS NOT NULL;");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_items_core ON memory_items(core, status);");
      this.#migrateProviderIdentity();
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_memory_items_provider_identity ON memory_items(status,scope,provider_family,provider_id,project,tool);");
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
            memory_id UNINDEXED,
            title,
            trigger,
            summary,
            failed_approach,
            root_cause,
            verified_fix,
            do_not_retry,
            tags
          );
          CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
            INSERT INTO memory_items_fts(memory_id,title,trigger,summary,failed_approach,root_cause,verified_fix,do_not_retry,tags)
            VALUES(new.id,new.title,coalesce(new.trigger,''),coalesce(new.summary,''),coalesce(new.failed_approach,''),coalesce(new.root_cause,''),coalesce(new.verified_fix,''),coalesce(new.do_not_retry,''),coalesce(new.tags_json,'[]'));
          END;
          CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
            DELETE FROM memory_items_fts WHERE memory_id=old.id;
          END;
          CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
            DELETE FROM memory_items_fts WHERE memory_id=old.id;
            INSERT INTO memory_items_fts(memory_id,title,trigger,summary,failed_approach,root_cause,verified_fix,do_not_retry,tags)
            VALUES(new.id,new.title,coalesce(new.trigger,''),coalesce(new.summary,''),coalesce(new.failed_approach,''),coalesce(new.root_cause,''),coalesce(new.verified_fix,''),coalesce(new.do_not_retry,''),coalesce(new.tags_json,'[]'));
          END;
        `);
        this.ftsAvailable = true;
        const count = this.db.prepare("SELECT count(*) AS n FROM memory_items_fts").get()?.n ?? 0;
        const itemCount = this.db.prepare("SELECT count(*) AS n FROM memory_items").get()?.n ?? 0;
        if (itemCount > 0 && count === 0) {
          this.db.exec(`
            INSERT INTO memory_items_fts(memory_id,title,trigger,summary,failed_approach,root_cause,verified_fix,do_not_retry,tags)
            SELECT id,title,coalesce(trigger,''),coalesce(summary,''),coalesce(failed_approach,''),coalesce(root_cause,''),coalesce(verified_fix,''),coalesce(do_not_retry,''),coalesce(tags_json,'[]')
            FROM memory_items;
          `);
        }
      } catch {
        this.ftsAvailable = false;
      }
    } else {
      try {
        this.db.prepare("SELECT rowid FROM memory_items_fts LIMIT 1").get();
        this.ftsAvailable = true;
      } catch {
        this.ftsAvailable = false;
      }
    }
  }

  #ensureColumn(table, column, ddl) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  #migrateProviderIdentity() {
    const itemUpdate = this.db.prepare("UPDATE memory_items SET provider=?,provider_family=?,provider_id=? WHERE id=?");
    for (const row of this.db.prepare("SELECT id,provider,provider_family,provider_id FROM memory_items WHERE provider IS NOT NULL AND (provider_family IS NULL OR provider='workbee')").all()) {
      const identity = normalizeMemoryProvider(row.provider_id || row.provider || row.provider_family);
      itemUpdate.run(identity.provider, row.provider_family || identity.provider_family, row.provider_id || identity.provider_id, row.id);
    }
    const evidenceUpdate = this.db.prepare("UPDATE memory_evidence SET provider=?,provider_family=?,provider_id=? WHERE id=?");
    for (const row of this.db.prepare("SELECT id,provider,provider_family,provider_id FROM memory_evidence WHERE provider IS NOT NULL AND (provider_family IS NULL OR provider='workbee')").all()) {
      const identity = normalizeMemoryProvider(row.provider_id || row.provider || row.provider_family);
      evidenceUpdate.run(identity.provider, row.provider_family || identity.provider_family, row.provider_id || identity.provider_id, row.id);
    }
  }

  transaction(fn) {
    const nested = this.transactionDepth > 0;
    const savepoint = "memory_" + (this.transactionDepth || 0);
    this.db.exec(nested ? "SAVEPOINT " + savepoint : "BEGIN IMMEDIATE");
    this.transactionDepth = (this.transactionDepth || 0) + 1;
    try {
      const result = fn();
      this.db.exec(nested ? "RELEASE SAVEPOINT " + savepoint : "COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec(nested ? "ROLLBACK TO SAVEPOINT " + savepoint : "ROLLBACK");
        if (nested) this.db.exec("RELEASE SAVEPOINT " + savepoint);
      } catch {}
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  sameItemIdentity(item, context) {
    const identity = normalizeMemoryProvider(context.provider_id || context.provider || context.provider_family);
    return item.scope === context.scope
      && (item.provider_family || null) === identity.provider_family
      && (item.provider_id || null) === identity.provider_id
      && (item.project || null) === normalizeNullable(context.project)
      && (item.tool || null) === normalizeNullable(context.tool);
  }

  findMatchingItems(input = {}) {
    const identity = normalizeMemoryProvider(input.provider_id || input.provider || input.provider_family);
    const clauses = ["scope=?", "coalesce(provider_family,'')=coalesce(?,'')",
      "coalesce(provider_id,'')=coalesce(?,'')", "coalesce(project,'')=coalesce(?,'')",
      "coalesce(tool,'')=coalesce(?,'')", "status IN ('candidate','active')", "(expires_at IS NULL OR expires_at>?)"];
    const args = [input.scope, identity.provider_family, identity.provider_id, normalizeNullable(input.project), normalizeNullable(input.tool), nowIso()];
    for (const key of ["title", "kind", "error_signature"]) {
      if (input[key] !== undefined) { clauses.push(`coalesce(${key},'')=coalesce(?,'')`); args.push(cleanText(input[key])); }
    }
    return this.db.prepare(`SELECT * FROM memory_items WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC, id ASC`)
      .all(...args).map((row) => this.#hydrate(row));
  }

  #scopeFilter(context, alias = "") {
    if (!context) return { sql: "", args: [] };
    const p = alias ? alias + "." : "";
    const identity = normalizeMemoryProvider(context.provider);
    const project = normalizeNullable(context.project);
    const tools = (context.tools || (context.tool ? [context.tool] : [])).filter(Boolean);
    return {
      sql: ` AND (${p}provider_id IS NULL OR ${p}provider_id=?)
        AND (${p}provider_family IS NULL OR ${p}provider_family=?)
        AND (${p}project IS NULL OR ${p}project=?)
        AND (${p}tool IS NULL OR ${tools.length ? p + "tool IN (" + tools.map(() => "?").join(",") + ")" : "0"})
        AND (${p}scope IN ('global','machine')
          OR (${p}scope='provider' AND ? IS NOT NULL AND ${p}provider_family IS NOT NULL)
          OR (${p}scope='project' AND ? IS NOT NULL AND ${p}project IS NOT NULL)
          OR (${p}scope='tool' AND ${p}tool IS NOT NULL))`,
      args: [identity.provider_id, identity.provider_family, project, ...tools, identity.provider_family, project],
    };
  }

  putItem(input = {}) {
    if (this.readonly) throw new Error("memory store is read-only");
    const kind = KINDS.has(input.kind) ? input.kind : "lesson";
    const scope = SCOPES.has(input.scope) ? input.scope : "global";
    const status = STATUSES.has(input.status) ? input.status : "candidate";
    const confidence = CONFIDENCE.has(input.confidence) ? input.confidence : "low";
    const id = cleanText(input.id) || `mem_${randomUUID()}`;
    const now = nowIso();
    const providerIdentity = normalizeMemoryProvider(input.provider_id || input.provider || input.provider_family);
    const record = {
      id,
      kind,
      scope,
      provider: providerIdentity.provider,
      provider_family: normalizeNullable(input.provider_family) || providerIdentity.provider_family,
      provider_id: normalizeNullable(input.provider_id) || providerIdentity.provider_id,
      project: normalizeNullable(input.project),
      tool: normalizeNullable(input.tool),
      title: cleanText(input.title) || "Untitled memory",
      trigger: cleanText(input.trigger),
      summary: cleanText(input.summary),
      failed_approach: cleanText(input.failed_approach),
      root_cause: cleanText(input.root_cause),
      verified_fix: cleanText(input.verified_fix),
      do_not_retry: cleanText(input.do_not_retry),
      error_signature: cleanText(input.error_signature),
      tags_json: cleanJson(input.tags),
      confidence,
      status,
      core: boolInt(input.core),
      evidence_ref: cleanText(input.evidence_ref),
      valid_from: cleanText(input.valid_from) || (status === "active" ? now : null),
      valid_to: cleanText(input.valid_to),
      created_at: cleanText(input.created_at) || now,
      updated_at: now,
      last_verified_at: cleanText(input.last_verified_at) || (confidence === "verified" && status === "active" ? now : null),
      last_used_at: cleanText(input.last_used_at),
      use_count: Number.isInteger(input.use_count) && input.use_count >= 0 ? input.use_count : 0,
      expires_at: cleanText(input.expires_at),
    };

    return this.transaction(() => {
      if (record.kind === "fact" && record.status === "active") {
        const conflicts = this.db.prepare(`
          SELECT id, summary FROM memory_items
          WHERE status='active' AND kind='fact' AND title=?
            AND scope=? AND coalesce(provider_family,'')=coalesce(?,'')
            AND coalesce(provider_id,'')=coalesce(?,'')
            AND coalesce(project,'')=coalesce(?,'') AND coalesce(tool,'')=coalesce(?,'')
            AND id<>?
        `).all(record.title, record.scope, record.provider_family, record.provider_id, record.project, record.tool, record.id);
        for (const old of conflicts) {
          if ((old.summary ?? "") !== (record.summary ?? "")) {
            this.db.prepare("UPDATE memory_items SET status='superseded', valid_to=?, updated_at=? WHERE id=?")
              .run(now, now, old.id);
          }
        }
      }

      this.db.prepare(`
        INSERT INTO memory_items (
          id,kind,scope,provider,provider_family,provider_id,project,tool,title,trigger,summary,failed_approach,root_cause,
          verified_fix,do_not_retry,error_signature,tags_json,confidence,status,core,evidence_ref,
          valid_from,valid_to,created_at,updated_at,last_verified_at,last_used_at,use_count,expires_at
        ) VALUES (
          @id,@kind,@scope,@provider,@provider_family,@provider_id,@project,@tool,@title,@trigger,@summary,@failed_approach,@root_cause,
          @verified_fix,@do_not_retry,@error_signature,@tags_json,@confidence,@status,@core,@evidence_ref,
          @valid_from,@valid_to,@created_at,@updated_at,@last_verified_at,@last_used_at,@use_count,@expires_at
        )
        ON CONFLICT(id) DO UPDATE SET
          kind=excluded.kind, scope=excluded.scope, provider=excluded.provider,
          provider_family=excluded.provider_family, provider_id=excluded.provider_id, project=excluded.project,
          tool=excluded.tool, title=excluded.title, trigger=excluded.trigger, summary=excluded.summary,
          failed_approach=excluded.failed_approach, root_cause=excluded.root_cause,
          verified_fix=excluded.verified_fix, do_not_retry=excluded.do_not_retry,
          error_signature=excluded.error_signature, tags_json=excluded.tags_json,
          confidence=excluded.confidence, status=excluded.status, core=excluded.core,
          evidence_ref=excluded.evidence_ref, valid_from=excluded.valid_from, valid_to=excluded.valid_to,
          updated_at=excluded.updated_at, last_verified_at=excluded.last_verified_at,
          last_used_at=excluded.last_used_at, use_count=excluded.use_count, expires_at=excluded.expires_at
      `).run(record);
      return this.getItem(id);
    });
  }

  ensureItem(input = {}) {
    const title = cleanText(input.title) || "";
    const scope = SCOPES.has(input.scope) ? input.scope : "global";
    const providerIdentity = normalizeMemoryProvider(input.provider_id || input.provider || input.provider_family);
    const providerFamily = normalizeNullable(input.provider_family) || providerIdentity.provider_family;
    const providerId = normalizeNullable(input.provider_id) || providerIdentity.provider_id;
    const project = normalizeNullable(input.project);
    const tool = normalizeNullable(input.tool);
    const signature = cleanText(input.error_signature);
    const existing = this.db.prepare(`
      SELECT * FROM memory_items
      WHERE title=? AND scope=?
        AND coalesce(provider_family,'')=coalesce(?,'')
        AND coalesce(provider_id,'')=coalesce(?,'')
        AND coalesce(project,'')=coalesce(?,'')
        AND coalesce(tool,'')=coalesce(?,'')
        AND coalesce(error_signature,'')=coalesce(?,'')
        AND status IN ('active','candidate')
      ORDER BY created_at ASC LIMIT 1
    `).get(title, scope, providerFamily, providerId, project, tool, signature);
    if (existing) return this.#hydrate(existing);
    return this.putItem(input);
  }

  addEvidence(memoryId, input = {}) {
    if (this.readonly) throw new Error("memory store is read-only");
    if (!this.getItem(memoryId)) throw new Error(`unknown memory id: ${memoryId}`);
    const id = cleanText(input.id) || `ev_${randomUUID()}`;
    const created = cleanText(input.created_at) || nowIso();
    const expires = cleanText(input.expires_at) || new Date(Date.parse(created) + 14 * 86400000).toISOString();
    const providerIdentity = normalizeMemoryProvider(input.provider_id || input.provider || input.provider_family);
    this.db.prepare(`
      INSERT INTO memory_evidence (
        id,memory_id,job_id,provider,provider_family,provider_id,project,tool,event_type,error_code,error_excerpt,result_excerpt,created_at,expires_at,failure_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, memoryId, cleanText(input.job_id), providerIdentity.provider,
      normalizeNullable(input.provider_family) || providerIdentity.provider_family,
      normalizeNullable(input.provider_id) || providerIdentity.provider_id,
      cleanText(input.project), cleanText(input.tool), cleanText(input.event_type) || "evidence", cleanText(input.error_code),
      cleanText(input.error_excerpt)?.slice(0, 1200) ?? null,
      cleanText(input.result_excerpt)?.slice(0, 1200) ?? null, created, expires, cleanText(input.failure_id)
    );
    return this.db.prepare("SELECT * FROM memory_evidence WHERE id=?").get(id);
  }

  getItem(id) {
    const row = this.db.prepare("SELECT * FROM memory_items WHERE id=?").get(String(id));
    return row ? this.#hydrate(row) : null;
  }


  itemsForJob(jobKey) {
    return this.db.prepare(`SELECT m.* FROM memory_items m WHERE EXISTS (
      SELECT 1 FROM memory_evidence e WHERE e.memory_id=m.id AND e.job_id=?
        AND e.event_type IN ('failure','verification_pass')
    ) ORDER BY m.updated_at DESC,m.id ASC`).all(String(jobKey)).map((row) => this.#hydrate(row));
  }

  getEvidence(memoryId, { limit = 50 } = {}) {
    return this.db.prepare("SELECT * FROM memory_evidence WHERE memory_id=? ORDER BY created_at DESC LIMIT ?")
      .all(String(memoryId), Math.max(1, Math.min(500, limit)));
  }

  findBySignature(signature, { activeOnly = true, limit = 50, context = null } = {}) {
    if (!signature) return [];
    const filter = this.#scopeFilter(context);
    return this.db.prepare(`SELECT * FROM memory_items WHERE error_signature=?
      ${activeOnly ? "AND status='active' AND (expires_at IS NULL OR expires_at>?)" : ""}
      ${filter.sql} ORDER BY core DESC,last_verified_at DESC,updated_at DESC LIMIT ?`)
      .all(String(signature), ...(activeOnly ? [nowIso()] : []), ...filter.args, limit).map((row) => this.#hydrate(row));
  }

  listCore({ limit = 50, context = {} } = {}) {
    const filter = this.#scopeFilter(context);
    return this.db.prepare(`
      SELECT * FROM memory_items
      WHERE core=1 AND status='active' AND (expires_at IS NULL OR expires_at>?) ${filter.sql}
      ORDER BY CASE confidence WHEN 'verified' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
               coalesce(last_verified_at, updated_at) DESC
      LIMIT ?
    `).all(nowIso(), ...filter.args, Math.max(1, Math.min(100, limit))).map((row) => this.#hydrate(row));
  }

  searchActive({ query = "", signatures = [], limit = 100, context = {} } = {}) {
    const filter = this.#scopeFilter(context);
    const joinedFilter = this.#scopeFilter(context, "m");
    const out = new Map();
    const now = nowIso();
    for (const signature of [...new Set(signatures.filter(Boolean))].slice(0, 12)) {
      for (const row of this.db.prepare(`
        SELECT * FROM memory_items
        WHERE error_signature=? AND status='active' AND (expires_at IS NULL OR expires_at>?) ${filter.sql}
        ORDER BY core DESC,last_verified_at DESC,updated_at DESC LIMIT 50
      `).all(String(signature), now, ...filter.args)) out.set(row.id, this.#hydrate(row));
    }

    const text = cleanText(query) || "";
    if (text) {
      if (this.ftsAvailable) {
        const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 16);
        if (terms.length) {
          const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
          try {
            const rows = this.db.prepare(`
              SELECT m.*, bm25(memory_items_fts) AS fts_rank
              FROM memory_items_fts
              JOIN memory_items m ON m.id=memory_items_fts.memory_id
              WHERE memory_items_fts MATCH ?
                AND m.status='active' AND (m.expires_at IS NULL OR m.expires_at>?) ${joinedFilter.sql}
              ORDER BY bm25(memory_items_fts), m.updated_at DESC LIMIT ?
            `).all(ftsQuery, now, ...joinedFilter.args, Math.max(20, Math.min(300, limit * 3)));
            for (const row of rows) out.set(row.id, this.#hydrate(row));
          } catch {}
        }
      }
      if (out.size < Math.min(30, limit)) {
        const needle = `%${text.slice(0, 200).replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        const rows = this.db.prepare(`
          SELECT * FROM memory_items
          WHERE status='active' AND (expires_at IS NULL OR expires_at>?) ${filter.sql}
            AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR trigger LIKE ? ESCAPE '\\'
              OR verified_fix LIKE ? ESCAPE '\\' OR do_not_retry LIKE ? ESCAPE '\\')
          ORDER BY updated_at DESC LIMIT ?
        `).all(now, ...filter.args, needle, needle, needle, needle, needle, Math.max(20, Math.min(200, limit)));
        for (const row of rows) out.set(row.id, this.#hydrate(row));
      }
    }

    if (!text && out.size === 0) {
      const rows = this.db.prepare(`
        SELECT * FROM memory_items
        WHERE status='active' AND core=0 AND (expires_at IS NULL OR expires_at>?) ${filter.sql}
        ORDER BY coalesce(last_verified_at,updated_at) DESC LIMIT ?
      `).all(now, ...filter.args, Math.max(20, Math.min(200, limit)));
      for (const row of rows) out.set(row.id, this.#hydrate(row));
    }
    return [...out.values()].slice(0, Math.max(1, limit));
  }

  markUsed(ids = []) {
    if (this.readonly || !Array.isArray(ids) || ids.length === 0) return;
    const now = nowIso();
    const stmt = this.db.prepare("UPDATE memory_items SET last_used_at=?, use_count=use_count+1, updated_at=? WHERE id=?");
    this.transaction(() => { for (const id of new Set(ids.filter(Boolean))) stmt.run(now, now, String(id)); });
  }

  updateStatus(id, status, { validTo = undefined, confidence = undefined, lastVerifiedAt = undefined } = {}) {
    if (this.readonly) throw new Error("memory store is read-only");
    if (!STATUSES.has(status)) throw new Error(`invalid memory status: ${status}`);
    const now = nowIso();
    const item = this.getItem(id);
    if (!item) return null;
    const nextConfidence = CONFIDENCE.has(confidence) ? confidence : item.confidence;
    const nextValidTo = validTo === undefined ? (status === "superseded" || status === "expired" ? now : item.valid_to) : validTo;
    const verifiedAt = lastVerifiedAt === undefined ? item.last_verified_at : lastVerifiedAt;
    this.db.prepare("UPDATE memory_items SET status=?,confidence=?,valid_to=?,last_verified_at=?,updated_at=? WHERE id=?")
      .run(status, nextConfidence, nextValidTo, verifiedAt, now, String(id));
    return this.getItem(id);
  }

  deleteItem(id) {
    if (this.readonly) throw new Error("memory store is read-only");
    const result = this.db.prepare("DELETE FROM memory_items WHERE id=?").run(String(id));
    return Number(result.changes ?? 0) > 0;
  }

  allItems({ includeRejected = false, limit = 100000 } = {}) {
    const where = includeRejected ? "" : "WHERE status<>'rejected'";
    return this.db.prepare(`SELECT * FROM memory_items ${where} ORDER BY created_at ASC LIMIT ?`)
      .all(Math.max(1, Math.min(100000, limit))).map((row) => this.#hydrate(row));
  }

  upsertJob({ jobKey, provider = null, project = null, task = null, ref = null, status = "active", ttlDays = 14 } = {}) {
    if (this.readonly) throw new Error("memory store is read-only");
    const key = cleanText(jobKey);
    if (!key) throw new Error("memory job requires jobKey");
    const identity = normalizeMemoryProvider(provider);
    const now = nowIso();
    const expires = new Date(Date.now() + Math.max(1, Math.min(90, Number(ttlDays) || 14)) * 86400000).toISOString();
    const taskHash = task === null || task === undefined ? null : createHash("sha256").update(String(task), "utf8").digest("hex");
    this.db.prepare(`
      INSERT INTO memory_jobs (job_key,provider,provider_family,provider_id,project,task_hash,ref,status,started_at,updated_at,completed_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_key) DO UPDATE SET
        provider=excluded.provider,
        provider_family=excluded.provider_family,
        provider_id=excluded.provider_id,
        project=coalesce(excluded.project,memory_jobs.project),
        task_hash=coalesce(excluded.task_hash,memory_jobs.task_hash),
        ref=coalesce(excluded.ref,memory_jobs.ref),
        status=excluded.status,
        updated_at=excluded.updated_at,
        completed_at=CASE WHEN excluded.status='active' THEN NULL ELSE memory_jobs.completed_at END,
        expires_at=excluded.expires_at
    `).run(key, identity.provider, identity.provider_family, identity.provider_id, cleanText(project), taskHash, cleanText(ref), cleanText(status) || "active", now, now, null, expires);
    return this.getJob(key);
  }

  getJob(jobKey) {
    return this.db.prepare("SELECT * FROM memory_jobs WHERE job_key=?").get(String(jobKey)) ?? null;
  }

  bindJobRef(jobKey, ref) {
    if (this.readonly) throw new Error("memory store is read-only");
    const result = this.db.prepare("UPDATE memory_jobs SET ref=?,updated_at=? WHERE job_key=?")
      .run(cleanText(ref), nowIso(), String(jobKey));
    return Number(result.changes ?? 0) > 0 ? this.getJob(jobKey) : null;
  }

  findJobForRef(provider, ref) {
    const identity = normalizeMemoryProvider(provider);
    const row = this.db.prepare(`
      SELECT * FROM memory_jobs
      WHERE ref=?
        AND coalesce(provider_family,'')=coalesce(?,'')
        AND coalesce(provider_id,'')=coalesce(?,'')
        AND expires_at>?
      ORDER BY updated_at DESC LIMIT 1
    `).get(cleanText(ref), identity.provider_family, identity.provider_id, nowIso());
    return row ?? null;
  }

  finishJob(jobKey, status = "completed") {
    if (this.readonly) throw new Error("memory store is read-only");
    const now = nowIso();
    const expires = new Date(Date.now() + 2 * 86400000).toISOString();
    const result = this.db.prepare("UPDATE memory_jobs SET status=?,completed_at=?,updated_at=?,expires_at=? WHERE job_key=?")
      .run(cleanText(status) || "completed", now, now, expires, String(jobKey));
    return Number(result.changes ?? 0) > 0 ? this.getJob(jobKey) : null;
  }


  scopedFailures(signature, { provider = null, provider_family = null, provider_id = null, project = null, tool = null } = {}) {
    if (!signature) return [];
    const identity = normalizeMemoryProvider(provider_id || provider || provider_family);
    return this.db.prepare(`SELECT * FROM memory_failures
      WHERE signature=?
        AND coalesce(provider_family,'')=coalesce(?,'')
        AND coalesce(provider_id,'')=coalesce(?,'')
        AND coalesce(project,'')=coalesce(?,'')
        AND coalesce(tool,'')=coalesce(?,'')
        AND expires_at>?
      ORDER BY observed_at ASC,id ASC`)
      .all(cleanText(signature), identity.provider_family, identity.provider_id, cleanText(project), cleanText(tool), nowIso());
  }

  linkFailureEvidence(memoryId) {
    const item = this.getItem(memoryId);
    if (!item) throw new Error("unknown memory item for failure evidence");
    return this.transaction(() => {
      const failures = this.scopedFailures(item.error_signature, item);
      for (const failure of failures) {
        const id = "ev_failure_" + createHash("sha256").update(JSON.stringify([item.id, failure.id])).digest("hex");
        if (this.db.prepare("SELECT id FROM memory_evidence WHERE memory_id=? AND failure_id=?").get(item.id, failure.id)) continue;
        this.addEvidence(item.id, {
          id, failure_id: failure.id, job_id: failure.job_key,
          provider: failure.provider_id || failure.provider_family, project: failure.project, tool: failure.tool,
          event_type: "failure", error_code: failure.error_code, error_excerpt: failure.error_excerpt,
          created_at: failure.observed_at, expires_at: failure.expires_at,
        });
      }
      return failures.length;
    });
  }

  recordJobFailure({ jobKey, signature, provider = null, project = null, tool = null, error_code = null, error_excerpt = null, ttlDays = 14 } = {}) {
    if (this.readonly) throw new Error("memory store is read-only");
    const key = cleanText(jobKey);
    const sig = cleanText(signature);
    if (!key || !sig) throw new Error("memory failure requires jobKey and signature");
    const identity = normalizeMemoryProvider(provider);
    const now = nowIso();
    const expires = new Date(Date.now() + Math.max(1, Math.min(30, Number(ttlDays) || 14)) * 86400000).toISOString();
    return this.transaction(() => {
      const failureId = `fail_${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO memory_failures (id,job_key,signature,provider_family,provider_id,project,tool,error_code,error_excerpt,observed_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(failureId, key, sig, identity.provider_family, identity.provider_id, cleanText(project), cleanText(tool),
        cleanText(error_code), cleanText(error_excerpt)?.slice(0, 1200) ?? null, now, expires);
      return {
        failureId, signature: sig, sameJobCount: this.jobFailureCount(key, sig),
        scopeCount: this.scopedFailures(sig, { provider, project, tool }).length, observedAt: now,
      };
    });
  }

  jobFailureCount(jobKey, signature) {
    return Number(this.db.prepare("SELECT count(*) AS n FROM memory_failures WHERE job_key=? AND signature=? AND expires_at>? AND resolved_at IS NULL")
      .get(String(jobKey), String(signature), nowIso())?.n ?? 0);
  }

  lastJobFailure(jobKey, { includeResolved = false } = {}) {
    return this.db.prepare(`SELECT * FROM memory_failures WHERE job_key=? AND expires_at>?
      ${includeResolved ? "" : "AND resolved_at IS NULL"} ORDER BY observed_at DESC,rowid DESC LIMIT 1`)
      .get(String(jobKey), nowIso()) ?? null;
  }

  clearJobFailures(jobKey) {
    if (this.readonly) return 0;
    // Reset retry state without discarding provenance needed by later verification.
    const result = this.db.prepare("UPDATE memory_failures SET resolved_at=? WHERE job_key=? AND resolved_at IS NULL")
      .run(nowIso(), String(jobKey));
    return Number(result.changes ?? 0);
  }

  pruneOperational({ now = Date.now() } = {}) {
    if (this.readonly) return { jobsDeleted: 0, failuresDeleted: 0 };
    const iso = new Date(now).toISOString();
    return this.transaction(() => {
      const failures = this.db.prepare("DELETE FROM memory_failures WHERE expires_at<=?").run(iso);
      const jobs = this.db.prepare("DELETE FROM memory_jobs WHERE expires_at<=?").run(iso);
      return { jobsDeleted: Number(jobs.changes ?? 0), failuresDeleted: Number(failures.changes ?? 0) };
    });
  }

  stats() {
    const counts = Object.fromEntries(this.db.prepare("SELECT status,count(*) AS n FROM memory_items GROUP BY status").all().map((r) => [r.status, r.n]));
    const kindCounts = Object.fromEntries(this.db.prepare("SELECT kind,count(*) AS n FROM memory_items GROUP BY kind").all().map((r) => [r.kind, r.n]));
    const evidence = this.db.prepare("SELECT count(*) AS n FROM memory_evidence").get()?.n ?? 0;
    const core = this.db.prepare("SELECT count(*) AS n FROM memory_items WHERE core=1 AND status='active'").get()?.n ?? 0;
    const operationalJobs = this.db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE expires_at>?").get(nowIso())?.n ?? 0;
    const operationalFailures = this.db.prepare("SELECT count(*) AS n FROM memory_failures WHERE expires_at>? AND resolved_at IS NULL").get(nowIso())?.n ?? 0;
    return { dbPath: this.dbPath, fts5: this.ftsAvailable, items: Object.values(counts).reduce((a, b) => a + Number(b), 0), statuses: counts, kinds: kindCounts, evidence, core, operationalJobs, operationalFailures };
  }

  optimize({ vacuum = false } = {}) {
    if (this.readonly) return;
    try { this.db.exec("PRAGMA optimize"); } catch {}
    if (vacuum) {
      try { this.db.exec("VACUUM"); } catch {}
    }
  }

  close() {
    try { this.db.close(); } catch {}
  }

  #hydrate(row) {
    const item = { ...row, core: row.core === 1 };
    try { item.tags = JSON.parse(row.tags_json || "[]"); } catch { item.tags = []; }
    delete item.tags_json;
    return item;
  }
}
 
