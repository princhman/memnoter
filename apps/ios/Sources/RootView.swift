import SwiftUI
struct RootView: View {
    @Bindable var store: AppStore
    var body: some View {
        NavigationSplitView {
            List(store.modules) { module in Text(module.name) }.navigationTitle("Memnoter")
        } detail: { ContentUnavailableView("Memnoter", systemImage: "note.text") }
    }
}
