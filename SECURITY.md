# Security policy

Do not open a public issue with a Pairing Token, local project path, session data, or reproduction logs. Report security issues privately to the repository maintainer.

## Bridge boundary

- The Bridge listens on `127.0.0.1` only.
- All endpoints except `/api/health` require the Pairing Token.
- There is no public server, reverse tunnel, OAuth flow, MCP endpoint, or wildcard `Access-Control-Allow-Origin`.

## Reverse Context

`← Codex` is an explicit, read-only Context Pull. Reading a project requires a per-project permission stored as normalized realpath in `readAllowedProjects`; turning it off makes Context APIs return `403`.

Workspace Guard rejects:

- traversal, absolute paths outside the project, and symlink escape;
- `.env` files, private keys, credentials, `.git`, `node_modules`, build output and cache directories;
- binary files and files over the default 1 MB limit (4 MB absolute ceiling).

Project File reads accept only `projectPath` plus a project-relative `relativePath`. Users cannot provide an arbitrary `source_path`, command, or file-write operation.

Session transcript reads use only the indexed `sessionId` and its indexed `rolloutPath`, after confirming the Session belongs to the selected project. Reasoning, encrypted reasoning, and internal system/developer metadata are excluded; tool output is bounded.

Context is inserted into the ChatGPT composer only after the user clicks “插入 ChatGPT”. The extension never clicks ChatGPT Send automatically.
