# Releasing

`package.json` is the app version source of truth. Set its `version` (for this
release, `0.1.2`), then run `pnpm sync-version`. Commit the resulting desktop
config, workspace crate manifests, Cargo.lock, and retained Tauri iOS metadata.
Alternatively, `npm version 0.1.2 --no-git-tag-version` invokes the same sync
script through the version lifecycle. Do not bump the unrelated website or sync
server packages.

The native iPad app reads the same version: `xcodegen generate` in `apps/ios`
runs the sync script with `--ios-only` and generates the ignored
`Version.xcconfig`. Both configurations use its `MARKETING_VERSION`; Xcode's
generated Info.plist supplies `CFBundleShortVersionString` from that setting.
The default local build number is 1; override `CURRENT_PROJECT_VERSION` for
uploads. No iPad marketing version needs editing by hand.

Merge the release changes into main, then tag that merged commit:

```sh
git checkout main
git pull --ff-only origin main
git tag v0.1.2
git push origin v0.1.2
```

The tag starts two independent release paths in `.github/workflows/release.yml`:

- The desktop matrix builds macOS arm64/x64, Linux, and Windows, publishing the
  GitHub release, signed updater bundles, and updater manifest.
- `ios-testflight` builds the Rust XCFramework and web bundle, generates the
  native Xcode project, archives the iPad app, and exports directly to App Store
  Connect for TestFlight processing. Archive dSYMs are retained as a workflow
  artifact, including when the upload fails. It does not submit an App Store
  release or automatically distribute to external testers.

The iOS job checks that the `v*` tag matches `package.json`. It uses automatic
signing for team `BVQCX5TLX3`, with an App Store Connect API key for provisioning
and cloud-managed distribution signing. The team must have an active Apple
Developer membership, accepted agreements, an App Store Connect app record for
`com.vladyslavnalyvaiko.memnoter.ipad`, and permission to use cloud-managed
certificates. No exported signing certificate is stored in GitHub.

CI pins Xcode 26.2 with `maxim-lobanov/setup-xcode`, which supports Swift 6 and the
iOS 17 deployment target, instead of relying on the changing runner default.
The core build script needs both `aarch64-apple-ios` and
`aarch64-apple-ios-sim` to produce its XCFramework. Local archive verification
may use a newer installed Xcode.

Build numbers use `date -u +%Y%m%d%H%M` at job start. The workflow refuses numbers
at or below the last local upload, `202611031741`, and serializes TestFlight
jobs so uploads and reruns get increasing minute timestamps. App Store Connect's
automatic build-number rewriting is disabled. Coordinate future local uploads
with CI so their build numbers remain increasing too.

## App Store Connect secrets

In App Store Connect → Users and Access → Integrations → Team Keys, generate a
team API key with the **App Manager** role. An Account Holder or Admin may need
to enable API access or grant access to cloud-managed certificates. Download the
`.p8` once and keep it securely. Record the Key ID and Issuer ID, then configure
these repository Actions secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ASC_KEY_ID` | The key's Key ID |
| `ASC_ISSUER_ID` | The team's Issuer ID |
| `ASC_API_KEY_P8_BASE64` | Base64-encoded contents of the downloaded `.p8` |

On macOS, copy the encoded key with:

```sh
base64 -i AuthKey_XXXX.p8 | pbcopy
```

Missing secrets fail the iOS job with their names. CI decodes the key into a
restricted file under `$RUNNER_TEMP` and removes it in an `always()` cleanup
step. Existing desktop signing/updater secrets remain required for desktop
releases.

## Rerun TestFlight only

Once this workflow is on the default branch, choose **Actions → Release → Run
workflow**, select the release tag (for example `v0.1.2`), and check
`testflight_only`. The tag must contain this workflow. With GitHub CLI:

```sh
gh workflow run release.yml --ref v0.1.2 -f testflight_only=true
```

The boolean defaults to false; when true, the entire desktop matrix is skipped.
A branch dispatch fails the iOS tag check. Prefer rerunning a failed job or
using the tag dispatch over moving a published release tag.

## Local archive check (no upload)

With Node/pnpm, Rust's two iOS targets, XcodeGen, and a signed-in Xcode account
for the team installed:

```sh
pnpm install --frozen-lockfile
./scripts/build-ios-core.sh
./scripts/build-ios-web.sh
(cd apps/ios && xcodegen generate)
xcodebuild archive \
  -project apps/ios/Memnoter.xcodeproj \
  -scheme Memnoter -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$PWD/apps/ios/build/Memnoter.xcarchive" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=BVQCX5TLX3 CODE_SIGN_STYLE=Automatic \
  MARKETING_VERSION="$(node -p "require('./package.json').version")" \
  CURRENT_PROJECT_VERSION="$(date -u +%Y%m%d%H%M)"
```

This only archives. Do not run `-exportArchive` with destination `upload` during
local verification. CI adds the three API-key authentication flags to both its
archive and export commands.

## v0.1.2 local validation

Validated on 2026-11-03: `actionlint .github/workflows/release.yml` (1.7.12),
`pnpm install --frozen-lockfile`, `npx tsc --noEmit -p .`, `pnpm lint`,
`cargo check --workspace`, both iOS build scripts, and XcodeGen all passed.
A signed Release archive for generic iOS succeeded with local Xcode 27.2 and
Xcode-account signing (no export/upload). Its Info.plist reports version
`0.1.2`, build `202611031802`; `Memnoter.app.dSYM` is present and
`codesign --verify --deep --strict` passed. CI's API-key provisioning and
TestFlight upload still require a real workflow run with the configured secrets.
