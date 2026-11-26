# Memnoter sync server

The Cloudflare Worker behind Memnoter's cloud sync, served at
`https://sync.memnoter.com`.

```sh
pnpm install
pnpm test     # Worker, Durable Objects and R2, run locally
pnpm dev      # local server on :8787 (needs .dev.vars, see wrangler.jsonc)
```

## App Review sign-in

Set both optional Worker secrets from `apps/sync` to enable sign-in with a
fixed code for one dedicated review email address. Use a randomly generated
numeric code of at least 12 digits so reviewers can type it on the iOS keypad.
The Worker ignores the code unless it is at least 12 digits after trimming whitespace.

```sh
pnpm exec wrangler secret put REVIEW_EMAIL
pnpm exec wrangler secret put REVIEW_CODE
```

Include the email and code in the App Store review notes. The reviewer requests
a code in the app and enters the supplied code. The Worker skips email delivery
and applies the regular sign-in limits. If the review vault already has a sync
passphrase, include it in the review notes as well.

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
