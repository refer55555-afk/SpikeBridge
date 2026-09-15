# Third-party notices

Spike Bridge contains modified portions derived from **Codexless** (`liyana31811/Codexless`), which is distributed under the Apache License 2.0. Modified files in this repository are part of the Spike Bridge derivative work and remain distributed under Apache-2.0.

The embedded Codexless-derived runtime declares dependencies including Model Context Protocol packages, Hono, Zod, PDF.js, `@napi-rs/canvas`, and OpenAI Codex packages. Those packages retain their own licenses and notices. `npm ci` installs dependencies from the lockfiles; this repository does not vendor `node_modules` in the public source package.

Before publishing a release that vendors third-party binaries or dependency trees, re-check and include the exact license/NOTICE files required by that distribution shape.

OpenAI, Codex, ChatGPT, GitHub, Microsoft, Node.js and other third-party names are trademarks of their respective owners. This project does not claim ownership of those names or services.