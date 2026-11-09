import SwiftUI

struct SyncSettingsView: View {
    @Bindable var sync: SyncClient
    private let server = SyncConfiguration.defaultServer
    @State private var email = ""
    @State private var code = ""
    @State private var passphrase = ""
    @State private var confirm = ""
    @State private var token = ""
    @State private var user = ""
    @State private var isNew = false
    @State private var step = 0
    @State private var devCode: String?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Section("Sync") {
            if let account = sync.account {
                Text(account.email)
                Text(sync.status)
                if let date = sync.lastSynced { Text("Up to date as of \(date.formatted(date: .omitted, time: .shortened)).") }
                Text("\(sync.pending) pending changes")
                if let error = sync.error { Text(error).foregroundStyle(.red) }
                Button("Sync now") { sync.syncNow() }
                Button("Sign out", role: .destructive) { run { try await sync.signOut() } }
                Text("Your notes stay on this device. The cloud copy is untouched.").font(.caption)
            } else {
                Text("Keep your notes up to date across devices. Notes are end-to-end encrypted.")
                if step == 0 {
                    TextField("Email", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Send sign-in code") { run {
                        let result = try await sync.api(server, SyncConfiguration.path("authStart"), method: "POST", body: ["email": email])
                        devCode = result["devCode"] as? String; step = 1
                    } }.disabled(email.isEmpty)
                } else if step == 1 {
                    Text("Enter the code sent to \(email).")
                    if let devCode { Text("Development code: \(devCode)") }
                    TextField("6-digit code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                    Button("Continue") { run {
                        (token, user, isNew) = try await sync.signIn(server: server, email: email, code: code)
                        step = 2
                    } }
                } else {
                    Text(isNew ? "Create a sync passphrase" : "Enter your sync passphrase")
                    Text("This encrypts your notes before they leave this device. It is never sent to the server. If you forget it, you can reset sync, but the cloud copy cannot be recovered.").font(.caption)
                    SecureField("Sync passphrase", text: $passphrase)
                    if isNew { SecureField("Confirm passphrase", text: $confirm) }
                    Button("Turn on sync") { run {
                        try await sync.unlock(server: server, email: email, token: token, user: user, passphrase: passphrase)
                        passphrase = ""; confirm = ""; token = ""; step = 0
                    } }.disabled(passphrase.isEmpty || (isNew && (passphrase.utf16.count < SyncConfiguration.integer("PASSPHRASE_MIN_LENGTH") || passphrase != confirm)))
                }
                if step > 0 { Button("Back") { step = 0; token = ""; passphrase = ""; confirm = "" } }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }.disabled(busy)
    }
    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        busy = true; error = nil
        Task { defer { busy = false }; do { try await operation() } catch { self.error = error.localizedDescription } }
    }
}
