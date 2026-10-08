# COSMIC COMMONS — the application

Created by Leland Jourdan II / C&L Strategy · © 2026

COMMONS App **1.0.1** is a complete local reasoning workspace around the public COMMONS **0.2.2** engines. Create your own cases in guided forms, keep explicit evidence and assumptions, run decisions, retain exact receipts, and recover your workspace from backups. The original cream, violet, and ink interface remains.

## Included engines

**The actual engines are included in this download.** The application executes the compiled code in `vendor/commons/dist/src/`; the TypeScript source is in `vendor/commons/src/`. These implement COMMONS evidence policy, finite-hypothesis inference, scoped binary adequacy, canonicalization, receipts, and replay verification. They are not placeholders or remote services.

The complete original engine distribution is also retained as `engine/COSMIC-Commons-v0.2.2-PUBLIC.zip`. Its files are locked by `engine/engine-lock.json`. The application uses the modular engine's real run and verify functions in a local child process; no engine compilation or dependency installation is needed.

This is the selected public COMMONS engine set. It does not include the full private COSMIC system or the full suite of separately named COSMIC engines. See [the engine boundary](docs/ENGINE-BOUNDARY.md).

## Start

Install **Node 24.19.0**, extract this complete folder, and run these commands inside it:

```sh
node scripts/doctor.mjs
node server.mjs
```

Open **http://127.0.0.1:4320**. Keep the terminal running; Ctrl+C stops it. No `npm install`, account, model, external API, or internet connection is needed to use the app. macOS users can run `Start-COMMONS.command`; Windows users can run `Start-COMMONS.bat`. Launchers require Node on PATH. On macOS, running the two terminal commands works if Finder will not open the launcher. Use the numeric loopback address shown above.

## Use it

- **Cases:** create an evidence-policy case or an investigation; search, archive, duplicate, or fork it. Saves create immutable versions. Runs use the saved revision, never an invisible draft.
- **Evidence policy:** enter text, JSON, a reference, or an uploaded file; assert typed facts and their source; declare requirements and the evaluation time. Results show ALLOW, DENY, DEFER, or ERROR with the engine’s trace.
- **Investigation:** declare hypotheses, priors, experiment likelihoods, budgets, optional binary adequacy assumptions, and action losses. Choose an observation before adding it. Saved observations and their model are frozen; use a fresh fork to revise those assumptions.
- **Templates:** use the included synthetic examples or save your own case definition and supporting files as a template.
- **History and notes:** inspect old inputs, results, exact receipts, and human notes. An older run remains labeled with the revision it evaluated.
- **Receipts:** upload the original raw file; check integrity, computation replay, and an optional independently retained digest separately.
- **Recovery:** export a complete case or download a full workspace backup. Imports validate manifests, files, and replayable runs. Restore validates before replacing the current workspace; malformed backups leave it intact.

See [operation instructions](docs/OPERATION.md), [engine boundary](docs/ENGINE-BOUNDARY.md), [verification](VERIFICATION.md).

## Data and limits

Data stays in the displayed workspace directory: `~/Library/Application Support/COMMONS` on macOS, `~/.local/share/commons` elsewhere. Set `COMMONS_DATA_DIR` to choose a different directory; set `PORT` to change the default port. The SQLite database, audit records, and file blobs persist across restarts. Export before moving or replacing a workspace. This is a single local workspace, without encryption or user accounts; operating-system access controls protect its files.

Inputs, receipts, and package metadata are capped at 2,000,000 bytes, individual attachments at 10 MiB, and transport packages at 64 MiB. The storage validator also caps canonical bundle JSON (including base64 file content) at 64 MiB. Stored file bytes can reach 250 MiB, so a large workspace can exceed the full-backup limit. Exports refuse explicitly rather than truncate. Export smaller cases while below their limits. See OPERATION for details.

## Validate this package

```sh
node VERIFY-APP.mjs
node scripts/verify-engine.mjs
node vendor/commons/VERIFY-PACKAGE.mjs
node vendor/commons/bin/cosmic.mjs prove
node --test tests/*.test.mjs
node scripts/build.mjs
```

The optional browser workflow test is documented in VERIFICATION; its tools are testing dependencies only. The app uses native browser modules, Node HTTP, and SQLite, keeping operation dependency-free and the engines outside the application build pipeline.

## Scope and attribution

This distribution contains only the selected public COMMONS engine, not the full COSMIC system. It provides explicit, conditional calculations; it does not prove entered facts, perform real-world actions, or turn a hash into a signature. This is a local application; no public hosting, external intake connector, or remote service is included.

Apache-2.0 applies; retain the supplied LICENSE, NOTICE, and relevant attribution as their terms require. The application displays **Leland Jourdan II / C&L Strategy** credit. The license does not require every downstream interface to display that footer. The original engine notices are unchanged. Read the actual license rather than assuming a stronger name-display condition.
