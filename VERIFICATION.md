# Verifying COMMONS Application 1.0.1

The commands below let you check the delivered file set, original engine bytes, executable tests, and application syntax yourself. Run them with **Node 24.19.0** from the application directory. No runtime dependency installation is required.

## Package and engine integrity

```sh
node VERIFY-APP.mjs
node scripts/verify-engine.mjs
node vendor/commons/VERIFY-PACKAGE.mjs
```

`VERIFY-APP.mjs` compares the full application tree with `CHECKSUMS-APP.sha256`. `RELEASE.json` records the application version, source-file hashes, and source digest. These commitments detect differences from this package's recorded bytes; a hash is not a signature or independent proof of authorship.

The retained `engine/COSMIC-Commons-v0.2.2-PUBLIC.zip` SHA256 is `a7a644f9d99a49c17905ae8ff08cf0aa2c8a69883e89c9964028662d431b5a26`. The application lock covers all 213 original vendor files. The upstream package verifier covers 212 files because its checksum manifest excludes itself. The actual engine TypeScript source and compiled JavaScript are both present under `vendor/commons`.

## Executable tests

```sh
node vendor/commons/bin/cosmic.mjs prove
node --test tests/*.test.mjs
node scripts/build.mjs
```

The shipped engine suite has an expected **106 tests**. The application suite has an expected **66 tests**. A successful execution has no failures or skipped tests; check the actual output and exit status on your machine. These counts describe the supplied suites, not a claim about a run you have not performed.

Application tests exercise the HTTP server, child-process engine, SQLite store, and file storage: policy outcomes and time semantics, conditional investigations, frozen observation histories and fresh forks, optimistic revisions, concurrent and idempotent runs, restart persistence, templates, exact receipts and files, case import/export, and transactional workspace restoration. Adversarial cases cover duplicate and escaped-equivalent JSON keys, malformed UTF-8, excessive numeric precision, unsafe integers, forged and rehashed receipts, result and file linkage mismatches, missing blobs, invalid package manifests, path traversal, symlinks, wrong Host/Origin/session/token, oversized bodies, and an isolated altered engine tree.

The build command validates JavaScript syntax and required application assets. Native modules run directly. It does not compile, bundle, regenerate, or write the frozen engine files.

Tests use temporary synthetic workspaces. Do not configure a test with your real workspace path. Application tests do not establish source truth or real-world decision suitability.

## Optional browser workflows

`tests/browser-gate.mjs` exercises the production application in a real Chromium browser, including desktop and a narrow viewport. It uses a fresh synthetic workspace and blocks external requests. Browser tools are development-only dependencies and are not needed to use the application.

Install Playwright and its Chromium browser in a separate tools directory, then run:

```sh
COMMONS_BROWSER_MODULES=/absolute/path/to/browser-tools node tests/browser-gate.mjs
```

That directory may instead contain `playwright` plus `@sparticuz/chromium`. `COMMONS_PLAYWRIGHT_MODULE` can select an exact Playwright module path, and `COMMONS_CHROMIUM_EXECUTABLE` can select an already installed browser. Check the script's actual output, exit status, and generated results. Missing tools, absent results, or a failed workflow are not successful verification.

## Receipt checks and scope

Receipt integrity, computation replay, and trusted anchoring are separate checks. Replay binds the engine's recorded runtime identity, including OS and architecture. A receipt created on another runtime can report UNSUPPORTED_RUNTIME even when its byte integrity is valid. Obtain a fresh local receipt rather than relabeling that refusal as a match.

An expected digest is trusted only when retained independently of the receipt being checked. Copying a digest from the uploaded file does not create an independent anchor. Successful checks establish consistency with the declared computation, not source truth, authorship, or a cryptographic signature.

Operational scope and finite storage/export limits are documented in [OPERATION](docs/OPERATION.md). The distribution contains the selected public COMMONS engines, not the full private COSMIC system.
