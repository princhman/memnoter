import SwiftUI
import StoreKit

private enum UpdateChannel {
    case appStore, testFlight

    private static let appStoreAppID = 6830285669

    static func installed() async -> Self {
        #if DEBUG || targetEnvironment(simulator)
        return .appStore
        #else
        if case .verified(let transaction)? = try? await AppTransaction.shared {
            return transaction.environment == .sandbox ? .testFlight : .appStore
        }
        // A beta receipt also identifies an offline TestFlight install.
        return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" ? .testFlight : .appStore
        #endif
    }

    var name: String { self == .testFlight ? "TestFlight" : "the App Store" }
    var buttonTitle: String { self == .testFlight ? "Open TestFlight" : "Open App Store" }
    var updateURL: URL {
        switch self {
        case .testFlight: URL(string: "itms-beta://")!
        case .appStore: URL(string: "itms-apps://apps.apple.com/app/id\(Self.appStoreAppID)")!
        }
    }

    var releaseURL: URL {
        switch self {
        case .testFlight: URL(string: "https://api.github.com/repos/princhman/memnoter/releases/latest")!
        case .appStore: URL(string: "https://itunes.apple.com/lookup?id=\(Self.appStoreAppID)")!
        }
    }

    func version(from data: Data) throws -> String? {
        switch self {
        case .testFlight:
            guard let release = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  release["draft"] as? Bool != true, release["prerelease"] as? Bool != true else { return nil }
            return release["tag_name"] as? String
        case .appStore:
            struct Lookup: Decodable {
                struct Listing: Decodable { let bundleId: String; let version: String }
                let results: [Listing]
            }
            return try JSONDecoder().decode(Lookup.self, from: data).results
                .first { $0.bundleId == Bundle.main.bundleIdentifier }?.version
        }
    }
}

@MainActor @Observable final class ReleaseNotice {
    var available: String?
    fileprivate func check(channel: UpdateChannel) async {
        let defaults = UserDefaults.standard
        let now = Date().timeIntervalSince1970
        // A promoted build can have a newer TestFlight release cached locally.
        let tagKey = channel == .testFlight ? "releaseTag" : "appStoreReleaseVersion"
        let checkedKey = channel == .testFlight ? "releaseChecked" : "appStoreReleaseChecked"
        let cached = defaults.string(forKey: tagKey)
        if now - defaults.double(forKey: checkedKey) < 86_400 {
            show(cached); return
        }
        defaults.set(now, forKey: checkedKey)
        // A failed refresh must not revive a stale notice.
        defaults.removeObject(forKey: tagKey)
        do {
            var request = URLRequest(url: channel.releaseURL)
            request.timeoutInterval = 10
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let tag = try channel.version(from: data) else { return }
            defaults.set(tag, forKey: tagKey); show(tag)
        } catch { /* Offline and rate limits need no user action. */ }
    }
    private func show(_ tag: String?) {
        guard let tag, tag != UserDefaults.standard.string(forKey: "dismissedRelease"),
              let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              Self.isNewer(current: current, latest: tag) else { return }
        available = tag
    }
    static func isNewer(current: String, latest: String) -> Bool {
        func parts(_ value: String) -> [Int]? {
            let value = value.hasPrefix("v") ? String(value.dropFirst()) : value
            let core = String(value.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)[0])
            let parts = core.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) && ($0 == "0" || !$0.hasPrefix("0")) }) else { return nil }
            let numbers = parts.compactMap { Int($0) }
            return numbers.count == 3 ? numbers : nil
        }
        guard let a = parts(current), let b = parts(latest) else { return false }
        return a.lexicographicallyPrecedes(b)
    }
    func dismiss() {
        UserDefaults.standard.set(available, forKey: "dismissedRelease")
        available = nil
    }
}

struct UpdateNoticeView: View {
    let required: Bool
    @State private var release = ReleaseNotice()
    @State private var channel: UpdateChannel?
    @State private var showing = false
    @State private var requiredShown = false
    @State private var optionalShown = false
    @State private var replacingOptional = false

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .alert(required ? "Memnoter needs an update to keep syncing" : "Update available", isPresented: $showing) {
                if let channel {
                    Button(channel.buttonTitle) {
                        if !required { release.dismiss() }
                        UIApplication.shared.open(channel.updateURL)
                    }
                }
                Button("Later", role: .cancel) {
                    if !required { release.dismiss() }
                }
            } message: {
                Text(required
                     ? "Your notes are still available on this device. Update Memnoter in \(channel?.name ?? "the App Store") to resume syncing."
                     : "A newer version of Memnoter is available in \(channel?.name ?? "the App Store").")
            }
            .tint(Color("BrandAccent"))
            .task {
                let installed = await UpdateChannel.installed()
                guard !Task.isCancelled else { return }
                channel = installed
                presentIfNeeded()
                await release.check(channel: installed)
                presentIfNeeded()
            }
            .onChange(of: required) { _, _ in presentIfNeeded() }
            .onChange(of: release.available) { _, _ in presentIfNeeded() }
    }

    private func presentIfNeeded() {
        guard channel != nil else { return }
        if required {
            guard !requiredShown else { return }
            requiredShown = true
            if showing {
                // Replace the optional alert after its native dismissal finishes.
                showing = false
                replacingOptional = true
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(400))
                    replacingOptional = false
                    showing = true
                }
            } else { showing = true }
        } else if !requiredShown && !optionalShown && !replacingOptional && release.available != nil {
            let now = Date().timeIntervalSince1970
            let defaults = UserDefaults.standard
            guard now - defaults.double(forKey: "releasePopupShown") >= 86_400 else { return }
            defaults.set(now, forKey: "releasePopupShown")
            optionalShown = true
            showing = true
        }
    }
}
