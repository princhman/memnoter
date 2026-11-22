import SwiftUI
import AppKit
import PencilKit

struct DrawingScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject var model: DrawingSession
    @State private var eraserMenuOpen = false
    @State private var penMenuOpen = false
    @State private var inkOptionsOpen = false
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
                    Menu {
                        Picker("Paper style", selection: $model.paperStyle) {
                            ForEach(DrawingPaperStyle.allCases, id: \.self) { style in
                                Text(style.rawValue.capitalized).tag(style)
                            }
                        }.disabled(!model.loaded || model.saving)
                        Divider()
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
                toolPalette
                    .padding(.bottom, 8)
                    .disabled(!model.loaded || model.saving)
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
    private var toolPalette: some View {
        let isErasing = model.tool == .eraser
        let pen = model.lastPen
        return HStack(spacing: 0) {
            icon("Undo", "arrow.uturn.backward", enabled: !model.undoStack.isEmpty) { model.undo() }
            icon("Redo", "arrow.uturn.forward", enabled: !model.redoStack.isEmpty) { model.redo() }
            icon(pen.rawValue.capitalized, pen.symbol, selected: model.tool.usesInk) {
                if model.tool.usesInk { penMenuOpen = true } else { model.tool = pen }
            }
            .popover(isPresented: $penMenuOpen, arrowEdge: .top) {
                variants([InkTool.pen, .pencil, .marker], title: { $0.rawValue.capitalized },
                         symbol: { $0.symbol }, selected: model.tool) {
                    model.tool = $0
                    penMenuOpen = false
                }
            }
            icon("Eraser", InkTool.eraser.symbol, selected: isErasing) {
                if isErasing { eraserMenuOpen = true } else { model.tool = .eraser }
            }
            .popover(isPresented: $eraserMenuOpen, arrowEdge: .top) {
                variants(EraserMode.allCases, title: { $0.title }, symbol: { _ in InkTool.eraser.symbol },
                         selected: model.eraserMode) {
                    model.eraserMode = $0
                    eraserMenuOpen = false
                }
            }
            icon("Lasso", InkTool.lasso.symbol, selected: model.tool == .lasso) { model.tool = .lasso }
            Button { inkOptionsOpen = true } label: {
                let diameter = max(5, model.width * 1.4)
                Circle().fill(swatch(model.color))
                    .frame(width: diameter, height: diameter)
                    .overlay(Circle().strokeBorder(.primary.opacity(0.2), lineWidth: 1))
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Colour and thickness")
            .popover(isPresented: $inkOptionsOpen, arrowEdge: .top) { inkOptions }
        }
        .buttonStyle(DrawingPaletteButtonStyle())
        .font(.system(size: 16, weight: .medium))
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .background {
            if #available(macOS 26, *) {
                Capsule().fill(.clear).glassEffect(.regular, in: Capsule())
            } else {
                Capsule().fill(.regularMaterial)
            }
        }
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }

    private func variants<Option: Hashable>(_ options: [Option], title: @escaping (Option) -> String,
                                               symbol: @escaping (Option) -> String, selected: Option,
                                               choose: @escaping (Option) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(options, id: \.self) { option in
                Button { choose(option) } label: {
                    HStack {
                        Label(title(option), systemImage: symbol(option))
                        Spacer()
                        if selected == option { Image(systemName: "checkmark") }
                    }
                    .frame(height: 32)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected == option ? .isSelected : [])
            }
        }
        .padding(12)
        .frame(width: 170)
    }

    private var inkOptions: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ink colour").font(.headline)
            HStack(spacing: 4) {
                ForEach(InkColor.allCases, id: \.self) { color in
                    Button {
                        model.color = color
                        if !model.tool.usesInk { model.tool = model.lastPen }
                        inkOptionsOpen = false
                    } label: {
                        Circle().fill(swatch(color)).frame(width: 21, height: 21)
                            .overlay {
                                if model.color == color {
                                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
                                        .foregroundStyle(color == .black && colorScheme == .dark ? .black : .white)
                                }
                            }
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("\(color.rawValue.capitalized) ink")
                    .accessibilityAddTraits(model.color == color ? .isSelected : [])
                }
            }
            if model.tool == .eraser && model.eraserMode == .pixel {
                Text("Eraser size").font(.headline)
                Slider(value: $model.eraserSize, in: 4...80, step: 1)
                    .accessibilityLabel("Eraser size")
            }
            Text("Stroke width").font(.headline)
            Slider(value: $model.width, in: 1...10, step: 0.5)
                .accessibilityLabel("Stroke width")
        }
        .buttonStyle(.plain)
        .padding(16)
    }

    private func icon(_ title: String, _ symbol: String, selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .foregroundStyle(Color.primary)
                .frame(width: 36, height: 36)
                .background(selected ? purple.opacity(0.22) : .clear, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
                .transaction { $0.animation = nil }
        }
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .disabled(!enabled)
    }
}

private struct DrawingPaletteButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(isEnabled ? 1 : 0.3)
            .background(
                Color.primary.opacity(isEnabled && configuration.isPressed ? 0.2 : 0),
                in: RoundedRectangle(cornerRadius: 10)
            )
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}
