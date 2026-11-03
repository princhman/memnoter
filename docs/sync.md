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

## Later

- **iOS/iPadOS build**: its own phase.
- **Billing**: `hasSyncAccess` in `sync-server/src/index.ts` is the hook.
- Images removed from every note stay in R2 until the cloud data is deleted;
  a periodic cleanup would need devices to report unused images.
- Restoring a backup while sync is on merges newer changes from the cloud back
  in, rather than rolling every device back.
- Chapter numbering (on `feat/editor-improvements`) needs a
  "<id>.numbering" vault field once both branches are merged.
