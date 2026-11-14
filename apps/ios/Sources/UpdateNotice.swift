import SwiftUI

/// The installed native version is authoritative, including TestFlight builds.
@MainActor @Observable final class ReleaseNotice {
    var available: String?
    func check() async {
        let defaults = UserDefaults.standard
        let now = Date().timeIntervalSince1970
        let cached = defaults.string(forKey: "releaseTag")
        if now - defaults.double(forKey: "releaseChecked") < 86_400 {
            show(cached); return
        }
        defaults.set(now, forKey: "releaseChecked")
        // A failed refresh must not revive a stale notice.
        defaults.removeObject(forKey: "releaseTag")
        do {
            var request = URLRequest(url: URL(string: "https://api.github.com/repos/princhman/memnoter/releases/latest")!)
            request.timeoutInterval = 10
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let release = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  release["draft"] as? Bool != true, release["prerelease"] as? Bool != true,
                  let tag = release["tag_name"] as? String else { return }
            defaults.set(tag, forKey: "releaseTag"); show(tag)
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
    @State private var showing = false
    @State private var requiredShown = false
    @State private var optionalShown = false
    @State private var replacingOptional = false

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .alert(required ? "Memnoter needs an update to keep syncing" : "Update available", isPresented: $showing) {
                Button("Open TestFlight") {
                    if !required { release.dismiss() }
                    UIApplication.shared.open(URL(string: "itms-beta://")!)
                }
                Button("Later", role: .cancel) {
                    if !required { release.dismiss() }
                }
            } message: {
                Text(required
                     ? "Your notes are still available on this device. Update Memnoter in TestFlight to resume syncing."
                     : "A newer version of Memnoter is available in TestFlight.")
            }
            .tint(Color("BrandAccent"))
            .task {
                presentIfNeeded()
                await release.check()
                presentIfNeeded()
            }
            .onChange(of: required) { _, _ in presentIfNeeded() }
            .onChange(of: release.available) { _, _ in presentIfNeeded() }
    }

    private func presentIfNeeded() {
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
