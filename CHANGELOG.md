# Changelog

## 1.0.0-rc.1 - 2026-09-06

- Add the redesigned local memory workspace, provider configuration, knowledge/graph views, task continuity, session modes, and recall budgets.
- Support confirmed targeted feedback and prevent disabled or correction-discussion turns from later queue replay.
- Add three pinned embedding/reranker profiles and Windows runtime preview controls; explicit local identity bypasses cloud login and disables cloud model task execution.
- Ship the verified backend with automatic private Python setup and local identity discovery. `local-install` opens setup without a TMCRA account or server; stale cloud requests are blocked after local selection.
- Ship all generated runtime chunks and workspace assets. Full-local compiler, organizer, and restart acceptance remains incomplete.

## 0.1.7 - 2026-09-04

- Activate the configured Writer and background-organizer providers through the authenticated TMCRA user-provider task protocol.
- Keep provider credentials and raw response envelopes in the local Harness process while returning only validated JSON results and normalized usage.
- Add fair stage scheduling, lease heartbeats, bounded provider responses, shutdown cancellation, failure backoff, and end-to-end executor contracts.

## 0.1.6 - 2026-09-04

- Add a local setup command and loopback settings UI for separate Writer and background-organizer providers.
- Share the local provider configuration with the Codex plugin without exposing credential values to Harness or model output.
- Prevent a saved credential from being reused after its provider or Base URL changes.

## 0.1.5 - 2026-09-04

- Canonicalize the executable mode and use a deterministic stored-DEFLATE gzip stream for byte-for-byte identical release tarballs on Windows and Linux.

## 0.1.4 - 2026-09-04

- Normalize packaged text to UTF-8/LF and strip build-machine prefixes from generated region comments.
- Keep package payload contents identical across Windows and Linux release runners.

## 0.1.3 - 2026-09-04

- Fix the real DSH package compatibility probe on Windows, where `npm pack` returns an absolute path and the probe previously joined that path twice.
- Run the full DSH package-install, profile-composition, Web-readiness, type, unit, packaging, and audit contracts on both Ubuntu and Windows.
- Add a tag-driven release workflow that publishes the tested tarball and SHA-256 checksum.
- Keep compatibility pinned to the current stable `@deepseek-ai/dsh` `0.1.1-rc.2` release.

## 0.1.2 - 2026-08-25

- Update the complete DeepSeek Harness development and runtime contract set from `0.1.0-rc.6` to `0.1.1-rc.2`.
- Add a real-package compatibility test that installs the release tarball through the current `dsh plugin` command, verifies bundle/profile composition, and boots DSH Web to HTTP readiness.
- Add an explicit pnpm build-script allowlist for the reviewed native dependencies required by the latest official DSH package.
- Keep the Windows local-path workaround explicit: DSH rc.2 still mis-parses package paths containing spaces or non-ASCII characters, while release-URL installation works normally.
- Bump the plugin client identity to `0.1.2`.

## 0.1.1 - 2026-08-14

- Rename the public package and repository to `dsh-tmcra-memory` to follow the DeepSeek Harness community convention.
- Add a PKCE-protected TMCRA account login for ordinary users.
- Store the issued API base URL, scoped token, global scope, and project-scope prefix in the Harness credential store.
- Add `login`, `status`, and `logout` plugin commands without exposing token values.
- Recover interrupted device authorization without starting a second authorization request.
- Preserve unrelated Harness credentials during account connection and logout.
- Clarify production acceptance accounting and document the verified cleanup of disposable sessions, indexes, and credentials.
- Document cross-app and cross-conversation continuity through the shared TMCRA account and project scopes while preserving project isolation.

## 0.1.0 - 2026-08-14

Technical preview for DeepSeek Harness `0.1.0-rc.6`.

- Recall account-global and current-project memory before the first model request.
- Inject traceable TMCRA evidence into the durable Harness session log.
- Write user and assistant turns as separate records after a successful turn.
- Preserve project, session, agent, parent-agent, and delegation provenance.
- Redact common credential forms before network transmission.
- Retain failed writeback in a crash-safe local outbox.
- Attribute usage to the `deepseek_harness` platform ledger.
