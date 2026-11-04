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
