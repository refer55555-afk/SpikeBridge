# Spike Bridge project hygiene

- Permanent production files belong in their reviewed project directories. Do not drop one-off probes, debug scripts, screenshots, canary databases, gate outputs, or temporary patches in the repository root.
- Put one-off maintenance artifacts under `tmp/generated/<task>/`. This directory is housekeeping-managed and must never contain credentials or the only copy of important work.
- If a temporary root-level script is unavoidable, add `spike-housekeeping: ephemeral` in its first 1 KB; housekeeping may quarantine it after the configured age.
- Never mark secrets, account homes, runtime binaries, tunnel profiles, durable agent state, configuration, source code, or recovery archives as ephemeral.
- Housekeeping is intentionally conservative: it may manage `tmp/`, old `.log` files, explicit ephemeral markers, and its own quarantine only. Expanding deletion scope requires an explicit reviewed policy change.

- START-SPIKE-BRIDGE.cmd is the canonical persistent production/operator entrypoint. Its cutover mode is permanent maintenance surface and must never be quarantined or deleted by cleanup.
- Production port 7690 is owned exclusively by Safe-Boot. Normal startup must use `START-SPIKE-BRIDGE.cmd` / Safe-Boot `ensure`; release activation must use Safe-Boot `verify` + `promote` (or one-time `adopt-lkg`). Do not call `bootstrap/start-spike-bridge.ps1` for port 7690. Direct mutable 7690 launch is break-glass rollback only and must use the explicit `-BreakGlassMutableProduction` flag from Safe-Boot recovery code. Development/canary work uses port 7691 or another non-production port.
- `runtime/safe-boot/spike-home-production.g3.mjs` is the canonical Safe-Boot implementation. `runtime/safe-boot/spike-home-production.mjs` is compatibility-only and its operational `main()` must continue delegating to G3; never add new production behavior only to the legacy file.
- Run repository-root `npm test` before freezing/promoting a normal candidate. Live Provider gates that spend model quota remain separate from this default non-model regression.
- Account A/B Fast Entry tunnels are single-owned by the `SpikeBridge-Account-A` and `SpikeBridge-Account-B` Scheduled Tasks. Do not leave a healthy orphaned `tunnel-client.exe` without its task owner; use the task runner's verified adoption path instead of starting a second tunnel.
- Content-addressed directories under `state/safe-boot/releases/` are immutable recovery artifacts. Never edit a frozen release in place; freeze and verify a new candidate instead.

