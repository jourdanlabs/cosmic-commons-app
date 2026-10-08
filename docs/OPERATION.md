# Operating COMMONS

## Work with your own evidence

Create a **Policy** case in Cases. Give it a title and question. In Inputs, add sources and typed facts, then requirements that reference their fact IDs. Numeric text goes to the server’s strict parser before it becomes a number; rejected text stays visible. Choose an explicit evaluation time. Expiry and observation timestamps apply at that time.

Files retain their original bytes in local storage. The engine receives the uploaded file’s committed projection, including its hash, filename, media type, and application attachment ID. A file commitment does not establish its meaning or authenticity. Facts and excerpts are your assertions about a source; COMMONS does not silently extract or certify them.

Wait for the saved indicator or press **Save now**, then run. Results carry the saved revision and exact engine receipt. A change to inputs makes the earlier result historical. Missing evidence produces DEFER; malformed declarations can produce ERROR; neither authorizes action. Inspect the trace before relying on an ALLOW or DENY.

## Investigate a declared family

Create an **Investigate** case. Configure the finite hypotheses and priors, experiment outcomes and likelihoods, costs/budget, stopping settings, and optional action losses. The form does not silently normalize your declarations. If using binary adequacy, explicitly record its scope and independence assumption. Unsupported adequacy, a rejected family, or unsupported observations must remain visible in the result. Posterior weights are conditional on your declarations, not calibrated confidence in real-world truth.

Choose the ID, experiment, and outcome in the observation composer, then add it. Saved observations become read-only. You can append observations, but cannot edit or reorder the saved prefix. The observed model and adequacy/action definition are frozen. Fork creates a new case, fresh epoch, and empty observations while preserving the old case and its history. Corrections belong in that fresh case; a note may explain the reason.

## Save, inspect, and recover

Autosave retains invalid form text without saving a substituted value. Run is blocked while fields are invalid. On a revision conflict, the draft stays visible; resolve it against the saved version or create a fresh fork. Metadata and source assertion notes are separate from the engine’s verdict. Notes never change a result. Duplicate copies a case; fork explicitly resets an investigation.

Case export includes its revisions, runs, notes, attachments, manifest, and audit history. Import gives local records new identities, preserving exact receipt bytes and original input commitments. Saving a template captures the current saved definition, human assertion metadata, and files; it does not transfer case identity or make the example true. Built-in templates are synthetic.

In Settings, download a workspace backup before restoring. Choose a backup, type **RESTORE**, and confirm. The server validates the complete envelope and stored run receipts, stages the new workspace, then swaps it into place. A failed validation or tested swap failure rolls back to the original database and file store. Restore replaces the workspace; it does not merge. A recorded verification history is historical evidence of an earlier attempt, not a fresh replay on the restoring machine. Re-upload a receipt to obtain new checks.

## Verify a receipt

Upload the original receipt in Receipts. The browser sends raw text before parsing; the server rejects duplicate keys (including escaped-equivalent keys), malformed UTF-8, and non-round-trippable numbers. Integrity, replay, and trusted anchoring are separate fields. Same-runtime replay requires the engine’s recorded runtime identity, including OS/architecture. A Linux receipt can refuse replay on macOS with UNSUPPORTED_RUNTIME; keep the refusal and obtain a fresh local receipt instead of claiming a match.

Supply an expected digest from a separate trusted record if you need an anchor. Copying the digest from the uploaded file does not make it independently trusted. Successful checks establish consistency with the declared computation, not source truth, authorship, or a cryptographic signature.

## Local storage and recovery limits

The app binds to `127.0.0.1` only, uses a local session cookie and CSRF token, and requires the matching Host and Origin. It does not expose remote multi-user access. SQLite and blobs live beneath the Settings data directory; backups are sensitive if your inputs are sensitive. The app adds no at-rest encryption. Avoid editing database rows or blobs manually; inconsistent records fail validation.

| Boundary | Limit |
| --- | --- |
| Raw JSON input or receipt | 2,000,000 bytes |
| One attachment | 10 MiB |
| Unique stored attachment bytes | 250 MiB |
| Attachments in one package | 200 |
| Binary case/backup package | 64 MiB |
| Package metadata header | 2,000,000 bytes |
| Canonical validated bundle, with base64 blobs | 64 MiB |

A workspace can be larger than one valid backup. Large histories can also exceed the metadata cap. The app refuses oversized exports explicitly. Keep regular backups and individual case exports within these limits; do not assume every 250 MiB workspace fits a single backup. Packages use a versioned binary envelope with per-file hashes, not executable archives. Legacy small JSON envelopes are also accepted through the strict parser.

Quit with Ctrl+C. Restarting retains data. To test without touching your workspace, use a separate `COMMONS_DATA_DIR`; never point a test or example at your real data directory. A second instance using the same database is not a supported collaboration mode.
