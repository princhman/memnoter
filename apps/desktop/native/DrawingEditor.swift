import SwiftUI
import AppKit
import PencilKit

struct DrawingScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject var model: DrawingSession
    @State private var widths = false
    @State private var confirmingDiscard = false
    private let purple = Color(red: 67 / 255, green: 47 / 255, blue: 200 / 255)
    var body: some View {
        ZStack {
            Color(nsColor: .textBackgroundColor)
            Canvas(model: model)
            VStack {
                HStack {
                    Button { model.close() } label: { Image(systemName: "xmark").frame(width: 40, height: 40) }.accessibilityLabel("Close drawing")
                    Spacer()
                    if model.requiresCopy {
                        Text("This drawing changed elsewhere.").font(.caption)
                        Button("Discard local changes", role: .destructive) { confirmingDiscard = true }
                    }
                    Picker("Paper style", selection: $model.paperStyle) {
                        ForEach(DrawingPaperStyle.allCases, id: \.self) { style in
                            Text(style.rawValue.capitalized).tag(style)
                        }
                    }.frame(width: 160).disabled(!model.loaded || model.saving)
                    Menu {
                        Button("Save a copy") { model.done(copy: true) }
                        if model.hasChanges {
                            Divider()
                            Button("Discard local changes", role: .destructive) { confirmingDiscard = true }
                        }
                    } label: { Image(systemName: "ellipsis").frame(width: 40, height: 40) }
                    Button { model.done(copy: model.requiresCopy) } label: {
                        Group { if model.saving { ProgressView().controlSize(.small) } else { Text(model.requiresCopy ? "Save a copy" : "Done").fontWeight(.semibold) } }
                            .foregroundStyle(.white).frame(width: model.requiresCopy ? 110 : 76, height: 40).background(purple, in: Capsule())
                    }.accessibilityLabel("Done").disabled(!model.loaded || model.saving)
                }.buttonStyle(.plain).padding(14)
                    .allowsHitTesting(!model.usingTool)
                Spacer()
                HStack(spacing: 5) {
                    icon("Undo", "arrow.uturn.backward", enabled: !model.undoStack.isEmpty) { model.undo() }
                    icon("Redo", "arrow.uturn.forward", enabled: !model.redoStack.isEmpty) { model.redo() }
                    Divider().frame(height: 25)
                    ForEach(InkTool.allCases, id: \.self) { tool in icon(tool.rawValue.capitalized, tool.symbol, selected: model.tool == tool) { model.tool = tool } }
                    Divider().frame(height: 25)
                    ForEach(InkColor.allCases, id: \.self) { color in
                        Button { model.color = color; if model.tool == .eraser { model.tool = .pen } } label: {
                            Circle().fill(swatch(color)).frame(width: 21, height: 21)
                                .overlay { if model.color == color { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(color == .black && colorScheme == .dark ? .black : .white) } }
                                .frame(width: 34, height: 40)
                        }.accessibilityLabel("\(color.rawValue.capitalized) ink")
                    }
                    Divider().frame(height: 25)
                    Button { widths = true } label: {
                        Circle().fill(swatch(model.color)).frame(width: max(3, model.width * 1.5), height: max(3, model.width * 1.5)).frame(width: 40, height: 40)
                    }.accessibilityLabel("Stroke width").popover(isPresented: $widths) {
                        VStack(alignment: .leading, spacing: 18) {
                            Text("Stroke width").font(.headline)
                            Slider(value: $model.width, in: 1...10, step: 0.5).accessibilityLabel("Stroke width")
                            HStack { ForEach([1.5, 3.0, 6.0], id: \.self) { width in
                                Button { model.width = width } label: { Capsule().fill(swatch(model.color)).frame(width: 50, height: width).frame(width: 64, height: 40) }
                                    .accessibilityLabel("\(width.formatted()) point stroke")
                            } }
                        }.padding(24).frame(width: 250)
                    }
                }.buttonStyle(.plain).padding(10).background(Color(nsColor: .controlBackgroundColor), in: Capsule()).shadow(color: .black.opacity(0.12), radius: 16, y: 4)
                    .padding(.bottom, 18).disabled(!model.loaded || model.saving)
                    .allowsHitTesting(!model.usingTool)
            }
            if !model.loaded { VStack { ProgressView(); Text("Opening drawing…") }.padding(20).background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12)) }
        }.background(Color(nsColor: .textBackgroundColor)).foregroundStyle(.primary).tint(purple)
            .frame(minWidth: 720, minHeight: 520)
            .task { await model.load() }
            .confirmationDialog("Discard local changes?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
                Button("Discard local changes", role: .destructive) { model.discardLocalChanges() }
                Button("Cancel", role: .cancel) { }
            } message: { Text("This removes the local draft and returns to the note. The drawing saved in the note is kept.") }
            .alert("Drawing", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
                Button("OK") { model.error = nil }
            } message: { Text(model.error ?? "") }
    }
    private func swatch(_ color: InkColor) -> Color {
        color == .black && colorScheme == .dark ? .white : Color(nsColor: color.value)
    }
    private func icon(_ title: String, _ symbol: String, selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(selected ? purple : .primary.opacity(0.7))
                .frame(width: 40, height: 40).background(selected ? purple.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 10))
        }.accessibilityLabel(title).disabled(!enabled)
    }
}
