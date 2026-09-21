# Security policy

## Local boundary

- The Bridge listens on `127.0.0.1` only.
- `/health` is the only unauthenticated endpoint.
- All other endpoints require the Pairing Token from the existing `sol-codex-bridge` installation.
- The extension sends the token through `X-Bridge-Token` and stores it only in extension local storage.
- No wildcard CORS is enabled.

## Context boundary

Context reads continue to use the existing `sol-codex-bridge` workspace guard. Do not bypass it or expose arbitrary absolute file paths.

Do not publish Pairing Tokens, local paths, session transcripts, logs, or copied runtime files in issues or pull requests.
