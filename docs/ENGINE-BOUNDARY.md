# Frozen engine boundary

COMMONS App 1.0.2 includes and executes the existing compiled modular COMMONS 0.2.2 engine in a child process. The actual TypeScript source is in `vendor/commons/src/`; the executable JavaScript is in `vendor/commons/dist/src/`. Browser forms, storage, packaging, and workflow management live outside that engine. Engine implementation changes are not part of this application.

| Evidence | Value |
| --- | --- |
| Original archive | `engine/COSMIC-Commons-v0.2.2-PUBLIC.zip` |
| SHA256 | `a7a644f9d99a49c17905ae8ff08cf0aa2c8a69883e89c9964028662d431b5a26` |
| Engine directory | `vendor/commons` |
| App byte lock | `engine/engine-lock.json`: 213 original files |
| Upstream package verification | 212 files; its manifest excludes itself |
| Execution mode | `modular-compiled` |

`assertEngine` checks the complete vendor file set and byte hashes on startup and before worker operations. Changed, missing, additional, or symlinked engine files refuse execution. The retained original archive is separately checked by `scripts/verify-engine.mjs`. Application build validation only checks JavaScript syntax; it does not transpile, bundle, regenerate, or write engine files. The original engine’s runtime binding and refusal behavior remain intact.

The adapter passes raw input/receipt text to the original strict parser, runner, and verifier. It does not calculate posteriors or override verdicts. Storage retains raw receipts and extracts display fields from them. Imported run receipts must pass integrity and cannot contain a mismatched replay; an unsupported runtime remains explicit, rather than being presented as a successful replay.

The selected public engines provide evidence policy, finite-hypothesis inference, scoped binary adequacy, canonicalization, receipts, and replay verification. This package does not include the full private COSMIC system or the full suite of separately named COSMIC engines.

The worker imports `vendor/commons/dist/src/index.js` and calls the original `runRequest`, `verifyRunText`, and strict parser. The engine is a local dependency, not a remote service, placeholder, or code download performed at runtime.

The application uses zero runtime npm dependencies: native DOM ES modules, Node HTTP, and Node SQLite. This implementation choice keeps the engine outside any application compilation pipeline. LICENSE and NOTICE remain intact, and the application retains **Leland Jourdan II / JourdanLabs** attribution. File hashes establish byte consistency; they do not sign the distribution or establish source truth.
