# Cloud sync

Memnoter stays local-first and free; sync is the paid add-on that keeps notes
up to date across Mac, iPad and iPhone. Notes are end-to-end encrypted: the
server only stores ciphertext.

## How it works

```
 device A                         Cloudflare                        device B
 SQLite ── outbox ─▶ engine ══ WebSocket ══▶ Worker ─▶ Vault(userId) ══▶ engine ─▶ SQLite
 (Yjs updates)       encrypt                (auth)    SQLite log of      decrypt
                                                       opaque blobs
```

- **One Durable Object per user** (`Vault`) keeps an append-only log
  `(seq, doc, blob)` and pushes new entries to the user's other connected
  devices. Connections use WebSocket hibernation and pings are auto-answered,
  so an idle device costs no Durable Object time.
- **Everything is a Yjs document.** Each note already is; the module list is a
  "vault" Yjs document (`<id>.name`, `<id>.deleted`), so renames and deletions
  merge like text. Yjs updates commute and are idempotent, so there is no
  conflict resolution and resending is always safe.
- **Outbox.** `add_update` and the module commands write an outbox row in the
  same SQLite transaction as the change (`src-tauri/src/sync.rs`). The engine
  (`src/lib/sync/engine.ts`) merges a batch per document, encrypts it, pushes it
  and deletes the rows only after the server acknowledges them.
- **Cursor.** Each device stores the highest seq it has applied. Remote entries
  and the new cursor are committed together, so each is applied once.
- **Remote edits reach an open editor** through the same receipt and cache path
  as local saves (`acknowledgeContent` and the `["content", id]` query), so the
  editor's compaction never drops them.
- **Compaction.** The server hints when a document has 400+ entries; a device
  whose cursor covers them uploads an encrypted snapshot that replaces them.
- **Encryption** (`src/lib/sync/crypto.ts`): AES-256-GCM, key from PBKDF2-SHA256
  (600k iterations) of the sync passphrase and a per-account salt. The document
  id is authenticated data. A stored check value lets a new device verify the
  passphrase. Forgetting it loses only the cloud copy.
- **Sign-in**: a 6-digit code by email (Cloudflare Email Service), then an
  HMAC-signed token valid for 180 days. Sign-in requests are rate-limited per
  IP address. "Delete cloud data" empties the log and R2 and revokes every
  token issued before it, which signs out all devices (close code 4003).

### What syncs

| Data | How |
| --- | --- |
| Note text | Each note's Yjs document, by module id. |
| Module names and deletions | The vault document's "modules" map. |
| Images | Encrypted in R2 at `<user>/files/<id>`; the vault's "files" map announces them. Uploaded from `sync_file_uploads`, downloaded in the background, with images on screen first. |
| Card schedules and review history | One Yjs document per module, `r-<module id>`: FSRS state per card (the latest write wins) and review log rows by `sync_id`; an undone review becomes a tombstone. Cards indexed later get their state when they first appear. |
| Changes over the 1.9 MB row limit | Encrypted in R2 at `<user>/blobs/<id>`; the log holds a 33-byte reference, which the server deletes from R2 once the entry is compacted or dropped. |
| Deleted notes | Pushed as a `drop`, so the server removes their entries at once. |

Cards themselves are not synced: they are derived from note text on each
device.

## Cost

| Item | Price | Typical heavy user / month |
| --- | --- | --- |
| Workers Paid plan | $5 / account | shared by all users |
| DO requests (WebSocket messages count 20:1) | $0.15 / M | < $0.01 |
| DO SQLite rows written | $1.00 / M | ~$0.02 to $0.05 (batched pushes) |
| DO SQLite rows read / storage | $0.001 / M, $0.20 / GB | < $0.01 |

The log table has no secondary index on purpose: every index entry is a billed
row write, while the occasional scans are billed as reads, 1000x cheaper.

## Running it locally

```sh
scripts/sync-dev.sh          # local server + two app copies with throwaway data
cd sync-server && pnpm test  # Worker + Durable Objects + two-device engine tests
```

The two copies use `MEMNOTER_DATA_DIR` (debug builds only), so the real notes
are never touched. In development the sign-in code is shown on screen.

## Deploying

Production runs at `https://sync.memnoter.com` (a custom domain on the
`memnoter.com` zone; workers.dev is off), which release builds use by default.
Sign-in codes come from `sync@memnoter.com`; Email Sending is enabled for the
zone with its SPF, DKIM and DMARC records. To deploy a change:

```sh
cd sync-server && npx wrangler deploy
```

First-time setup, already done for memnoter.com:

```sh
cd sync-server
npx wrangler r2 bucket create memnoter-sync
npx wrangler email sending enable <your domain>   # then set EMAIL_FROM
npx wrangler secret put AUTH_SECRET               # long random string
npx wrangler deploy
```

`VITE_SYNC_SERVER` overrides the server the app uses.

R2 adds $0.015 / GB-month of storage and $4.50 / M uploads; downloads are
free of egress fees.

## Automatic deploys

Merges to `main` deploy the server through Cloudflare's own Git integration
(Workers Builds), with no GitHub workflow and no API token stored in GitHub.
It is set up once in the dashboard: Workers & Pages > `memnoter-sync` >
Settings > Build > Connect.

| Setting | Value |
| --- | --- |
| Repository / production branch | `princhman/memnoter`, `main` |
| Root directory | `sync-server` |
| Build command | `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` |
| Deploy command | `npx wrangler deploy` |

A failing typecheck or test stops the build, so nothing broken is deployed.
The server imports `src/lib/sync/` from outside its root directory, which works
because Cloudflare clones the whole repository. Builds also run for changes
that do not touch the server; they deploy the same code again, which is
harmless. The Worker's secrets (`AUTH_SECRET`) stay on Cloudflare and are not
touched by deploys.

## Later

- **Billing**: `hasSyncAccess` in `sync-server/src/index.ts` is the hook.
- Images removed from every note stay in R2 until the cloud data is deleted;
  a periodic cleanup would need devices to report unused images.
- Restoring a backup while sync is on merges newer changes from the cloud back
  in, rather than rolling every device back.
- Chapter numbering (on `feat/editor-improvements`) needs a
  "<id>.numbering" vault field once both branches are merged.

## Licensing

The app and shared sync client code in `src/lib/sync/` are MIT. The server in
`sync-server/` is AGPL-3.0-only: self-hosting is free, and anyone who runs a
modified copy as a network service must publish their changes. See
`sync-server/LICENSE`.

## Shared core and native iPad

The portable local half lives in `crates/memnoter-core/src/sync.rs`:
SQLite migrations, transactional outbox hooks, vault/review Yjs documents,
remote update application, snapshots, and managed image storage/deletion.
All thirteen sync commands are available through `dispatch` with the same names
and camelCase argument JSON as desktop. Opening any core database applies the
idempotent migrations, including upgrading existing desktop review logs.

`sync::crypto` provides native PBKDF2-SHA256 (NFKC passphrases), random salts,
AES-256-GCM blobs with document-id authentication, and key checks compatible
with the browser wire format. Native callers encode salts, keys and key checks
as base64 at the network boundary. The existing WebCrypto implementation stays
in the shared frontend for the browser sync engine; it has no Tauri dependency.

`src-tauri/src/sync.rs` only adapts commands and emits desktop outbox wakeups.
The TypeScript engine owns account HTTP requests, WebSockets, retries and
WebCrypto, and accesses commands/events through `src/lib/backend.ts`.
The debug-only desktop data-directory override also scopes images and backups
to that directory, as required by `scripts/sync-dev.sh`.

The native iPad app uses the dispatch bridge for sync storage and typed
UniFFI crypto helpers. SwiftUI owns account settings and URLSession owns
network lifecycle, with Keychain credentials and desktop receipt delivery
into the web editor as described below. No Tauri runtime is required by core.

### Native iPad adapter

`apps/ios/Sources/SyncClient.swift` uses URLSession HTTP/WebSockets with the
same v1 subprotocol, encrypted blobs, acknowledgement rules and durable cursor.
Desktop networking is TypeScript, so there is no portable Rust transport to
reuse. UniFFI exposes the existing core crypto, including off-main-thread
PBKDF2. Large updates use R2 blob references; images use `file:<id>` AAD.

The token and raw AES key live together in one atomic generic-password Keychain
item (`AfterFirstUnlockThisDeviceOnly`). The core account field contains only
the user ID, which enables transactional outbox hooks. Sign-out deletes the
Keychain item and disables sync while retaining notes. Switching accounts
resets the cursor/outbox before seeding the new account.

Launch/foreground reconnect, writes debounce for 400 ms, and a 15-second active
sweep retries images/outbox work. Network failures reconnect with capped
exponential backoff; decryption/protocol failures stop for explicit retry.
Backgrounding first flushes the web editor, permits a short sync under a UIKit
background task, then disconnects. iOS may suspend before completion; unacked
rows remain durable and resend on foreground. This is not background fetch.

Native tests include a URLProtocol auth server, real Keychain persistence, and
a two-database URLSession/Worker test. Start the local Worker on port 8787 with `DEV_RETURN_CODE=1` and a
throwaway `AUTH_SECRET` in its `.dev.vars` before `xcodebuild test`
(use normal simulator signing so Keychain is available); the native E2E test skips when no local
Worker is reachable. It uses unique disposable accounts and data directories,
and verifies concurrent independent Yjs edits against a Node-generated merged
snapshot, plus outbox drain and note retention after sign-out.
