# Mac Worker B LAN pairing

On Windows, start a fresh bridge with `start.ps1`. It prints one exact, one-time `GET /pair/<token>` URL. Give that URL to the Mac Codex agent; the user never runs a script. The legacy `/bootstrap/<token>` shell endpoint remains only for backward compatibility and is not part of first-use pairing.

## Mac Codex JSON pairing (no shell bootstrap)

The Mac Codex agent consumes the pair URL exactly once. First perform the direct TCP precheck against the bridge host and port without requesting the URL. Then make one direct no-proxy HTTP GET, parse the JSON in memory, base64-decode `workerPyBase64`, and verify its SHA-256 equals `workerSha256`. Do not print `pairingSecret`.

Write `~/Library/Application Support/SpikeWorkerB/worker.py` atomically with mode 700, compile it with `expectedPythonPath`, and write the LaunchAgent plist atomically with mode 600. The plist should point at the exact Python path, worker path, `bridgeUrl`, `workerPort`, and pairing secret. Use the local Mac Codex command tool to `launchctl bootstrap`/load the plist; no shell bootstrap or downloaded script execution is involved.

Finally verify the worker process, `/health`, bridge `/register`, and ongoing `/heartbeat`. Never run `codex login` or `codex logout`, and do not touch Codex auth. The JSON contains only pairing transport material and worker policy; it contains no auth.json, cookies, tokens, keychain data, or ChatGPT credentials.

Windows JSON wrappers are available under this directory. Start a fresh bridge with `powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap\mac-worker-b\start.ps1`; it launches detached, waits for listening, and returns the current one-time Mac command. Use `status.ps1`, `stop.ps1`, `submit.ps1 -TaskId ... -Task ... -TargetCwd ...`, and `poll.ps1 -TaskId ...` for the corresponding JSON operations. The wrappers derive the task bearer locally and never print the pairing secret.

The bridge API uses `Authorization: Bearer <HMAC(task-api-v1, pairing secret)>`: `POST /api/submit`, `GET /api/poll/:taskId`, and JSON status wrappers at `/api/status`, `/api/worker/start`, `/api/worker/status`, `/api/worker/stop`. The bridge accepts registration only from the pairing bearer and stores sanitized facts.

The Mac installer checks `codex --version` and `codex login status`, never runs `codex login`, and installs a LaunchAgent at `~/Library/LaunchAgents/com.spikehome.worker-b.plist`. The daemon exposes only `/health`, `/task`, and `/task/:taskId`; it never exposes a shell. `SPIKE_WORKER_B_FIXTURE=1` enables a local lifecycle fixture and does not invoke Codex.

Stop/uninstall without touching auth: `launchctl unload "$HOME/Library/LaunchAgents/com.spikehome.worker-b.plist"; rm -rf "$HOME/Library/Application Support/SpikeWorkerB" "$HOME/Library/LaunchAgents/com.spikehome.worker-b.plist"`.

If Windows Firewall blocks LAN traffic, run `firewall-private-profile.ps1` explicitly. It refuses to add a rule unless an active Private profile exists and never opens Public networks.
