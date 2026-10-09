# Contributing

Application improvements belong in `web/`, `app/`, the server, and application tests. Run the Node `>=24.15 <25` checks in [VERIFICATION](VERIFICATION.md). Preserve truthful verdicts, raw receipt verification, optimistic revisions, saved observation immutability, and transactional restore.

Treat `vendor/commons/` and the original engine archive as immutable pinned dependencies. An engine change requires a separate upstream release and a newly pinned archive; do not patch the retained engine in place or duplicate its calculations in the application. Keep application and engine versions distinct.

Run browser workflow tests for form or workflow changes, including keyboard use and a narrow viewport. Document commands and observed results accurately; do not describe unexecuted or failed checks as successful. Preserve the local-only operating scope unless a separate design explicitly changes it.

Preserve LICENSE, NOTICE, and relevant attribution, including **Leland Jourdan II / C&L Strategy**, in accordance with the supplied Apache-2.0 terms.

## Importing the complete distribution into Git

The supplied ignore rules exclude build-output directories, including the retained compiled engine. When importing this distribution into a repository, stage the full public tree, then explicitly stage the shipped executable engine:

```sh
git add .
git add -f -- vendor/commons/dist
```

Inspect any other ignored shipped files before committing. The TypeScript source alone is not the runnable distribution. Verify a fresh clone with `node VERIFY-APP.mjs` and `node scripts/doctor.mjs`; both must succeed with Node `>=24.15 <25` before treating that repository as complete.
