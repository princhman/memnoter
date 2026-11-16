# Memnoter sync server

The Cloudflare Worker behind Memnoter's cloud sync, served at
`https://sync.memnoter.com`.

```sh
pnpm install
pnpm test     # Worker, Durable Objects and R2, run locally
pnpm dev      # local server on :8787 (needs .dev.vars, see wrangler.jsonc)
```

## License

Copyright (c) 2026 Vladyslav Nalyvaiko

The sync server (everything in this `apps/sync/` directory) is licensed under
the GNU Affero General Public License, version 3 only (AGPL-3.0-only); see
[LICENSE](LICENSE). You may run and self-host it freely. If you modify it and
let others use it over a network, you must offer them the source of your
modified version.

The Memnoter app, including the shared sync protocol and client code in
`src/lib/sync/` that this server imports, is MIT-licensed; see the
[root LICENSE](../LICENSE).

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
details.

### Storage plans

Free accounts have 500 MB (500,000,000 encrypted R2 bytes). `founder` (lifetime)
and `pro` have unlimited file storage. `GET /v1/usage` returns the authenticated
user's `{ plan, usedBytes, limitBytes }`; `null` is unlimited. The limit can be
lowered locally with `wrangler dev --var FREE_STORAGE_LIMIT_BYTES:1000000`.

Usage counts `files/` and `blobs/`, excluding permanent deletion markers.
`blobs/` holds large **note updates**, so these uploads remain allowed even over
the cap; otherwise large notes would stop syncing. File uploads return HTTP 413
with `{ error: "quota_exceeded", used, limit }` before writing when they exceed
the cap. Retried uploads of an existing immutable object are free. Removing R2
objects releases their space. Existing accounts are counted lazily on first use;
interrupted mutations trigger a recount on the next operation.

Plan administration is disabled unless a separate `ADMIN_SECRET` is configured
with `pnpm exec wrangler secret put ADMIN_SECRET` from `apps/sync`. Use a random
secret distinct from `AUTH_SECRET`, held only by the administrator. Session tokens
cannot call these routes. There is no payment integration or client plan setter.

```sh
# USER_ID is the account's UUID, not their email. ADMIN_SECRET is the admin secret.
curl -X POST "https://sync.memnoter.com/v1/admin/users/$USER_ID/plan" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' -d '{"plan":"founder"}'
# One-off repair/import reconciliation: paginates both R2 prefixes.
curl -X POST "https://sync.memnoter.com/v1/admin/users/$USER_ID/recompute" \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

Plan changes and recounts serialize with file mutations. A cloud-data wipe
retains the paid entitlement, deletes the user's objects, and resets usage.
Device limits and payment-driven entitlement updates are separate follow-ups.
