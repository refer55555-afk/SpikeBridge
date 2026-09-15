import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePinnedCodex } from "../../runtime/safe-boot/codex-runtime.mjs";

function fixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "spike-public-codex-"));
  const configDir = path.join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const bin = path.join(root, "codex.exe");
  writeFileSync(bin, "fixture");
  writeFileSync(path.join(configDir, "local.json"), JSON.stringify({ schemaVersion: 1, codexBin: bin }));
  const previous = process.env.CODEX_BIN;
  try { delete process.env.CODEX_BIN; run({ root, bin }); } finally {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolves Codex from public local configuration", () => fixture(({ root, bin }) => {
  assert.equal(resolvePinnedCodex(root), path.resolve(bin));
}));

test("CODEX_BIN overrides local configuration", () => fixture(({ root }) => {
  const override = path.join(root, "override-codex.exe");
  writeFileSync(override, "fixture-override");
  const previous = process.env.CODEX_BIN;
  try {
    process.env.CODEX_BIN = override;
    assert.equal(resolvePinnedCodex(root), path.resolve(override));
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
  }
}));

test("missing public Codex configuration fails closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spike-public-codex-missing-"));
  const previous = process.env.CODEX_BIN;
  try {
    delete process.env.CODEX_BIN;
    assert.throws(() => resolvePinnedCodex(root), /not configured/i);
  } finally {
    if (previous !== undefined) process.env.CODEX_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured missing executable fails closed", () => fixture(({ root }) => {
  const previous = process.env.CODEX_BIN;
  try {
    delete process.env.CODEX_BIN;
    writeFileSync(path.join(root, "config", "local.json"), JSON.stringify({ codexBin: path.join(root, "missing.exe") }));
    assert.throws(() => resolvePinnedCodex(root), /does not exist/i);
  } finally {
    if (previous !== undefined) process.env.CODEX_BIN = previous;
  }
}));