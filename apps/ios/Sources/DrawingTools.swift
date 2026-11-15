import SwiftUI
import PencilKit

enum DrawingStyle {
    static let accent = Color(red: 67 / 255, green: 47 / 255, blue: 200 / 255)
}

enum DrawingTool: String, CaseIterable, Identifiable {
    case pen, pencil, marker, lasso, eraser, objectEraser
    var id: Self { self }
    var title: String { self == .objectEraser ? "Object eraser" : rawValue.capitalized }
    var symbol: String {
        switch self {
        case .pen: "pencil.tip"
        case .pencil: "pencil"
        case .marker: "highlighter"
        case .eraser: "eraser"
        case .objectEraser: "eraser.line.dashed"
        case .lasso: "lasso"
        }
    }
    var usesInk: Bool { self != .eraser && self != .objectEraser && self != .lasso }
}

enum DrawingInk: String, CaseIterable, Identifiable {
    case black, blue, red, green, purple, orange
    var id: Self { self }
    var title: String { rawValue.capitalized }
    var color: UIColor {
        let rgb: UInt32 = switch self {
        case .black: 0x000000
        case .blue: 0x2455DA
        case .red: 0xD32F40
        case .green: 0x14804A
        case .purple: 0x713AC7
        case .orange: 0xDA7817
        }
        // Document colors are fixed sRGB values, never semantic system colors.
        return UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                       green: CGFloat((rgb >> 8) & 255) / 255,
                       blue: CGFloat(rgb & 255) / 255, alpha: 1)
    }
}

struct DrawingToolBar: View {
    @Bindable var model: DrawingModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ViewThatFits(in: .horizontal) {
            tools.fixedSize()
            ScrollView(.horizontal, showsIndicators: false) { tools }
        }
        .padding(10)
        .modifier(DrawingGlass())
        .shadow(color: .black.opacity(0.1), radius: 18, y: 4)
        .disabled(!model.loaded || model.saving)
        .allowsHitTesting(!model.usingTool)
    }

    private var tools: some View {
        HStack(spacing: 5) {
            icon("Undo", "arrow.uturn.backward", enabled: model.canUndo) { model.undo() }
            icon("Redo", "arrow.uturn.forward", enabled: model.canRedo) { model.redo() }
            divider
            ForEach(DrawingTool.allCases) { tool in
                icon(tool.title, tool.symbol, selected: model.tool == tool) { model.tool = tool }
            }
            divider
            ForEach(DrawingInk.allCases) { ink in
                Button {
                    model.ink = ink
                    if !model.tool.usesInk { model.tool = .pen }
                } label: {
                    Circle().fill(ink == .black && colorScheme == .dark ? Color.white : Color(uiColor: ink.color)).frame(width: 21, height: 21)
                        .overlay { if model.ink == ink { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(ink == .black && colorScheme == .dark ? .black : .white) } }
                        .frame(width: 34, height: 40).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel("\(ink.title) ink")
                .accessibilityAddTraits(model.ink == ink ? .isSelected : [])
            }
            divider
            Button { model.showInkOptions = true } label: {
                Circle().fill(Color(uiColor: model.ink.color))
                    .frame(width: max(3, model.inkWidth * 1.5), height: max(3, model.inkWidth * 1.5))
                    .frame(width: 40, height: 40).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Stroke width")
                .popover(isPresented: $model.showInkOptions, arrowEdge: .bottom) {
                    VStack(alignment: .leading, spacing: 20) {
                        Text(model.tool == .eraser ? "Eraser size" : "Stroke width").font(.headline)
                        Slider(value: $model.activeWidth, in: model.activeWidthRange, step: 0.5).accessibilityLabel("Stroke width")
                        HStack {
                            ForEach([CGFloat(1.5), 3, 6], id: \.self) { width in
                                Button { model.inkWidth = width } label: {
                                    Capsule().fill(Color(uiColor: model.ink.color)).frame(width: 50, height: width)
                                        .frame(width: 64, height: 44).contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityLabel("\(width.formatted()) point stroke")
                            }
                        }
                    }.padding(24).frame(width: 280)
                }
        }
    }
    private var divider: some View { Rectangle().fill(.primary.opacity(0.08)).frame(width: 1, height: 24).padding(.horizontal, 4) }
    private func icon(_ title: String, _ symbol: String, selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 18, weight: .medium))
                .foregroundStyle(selected ? DrawingStyle.accent : .primary.opacity(enabled ? 0.75 : 0.2))
                .frame(width: 40, height: 40)
                .background(selected ? DrawingStyle.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!enabled).accessibilityLabel(title)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct DrawingGlass: ViewModifier {
    var prominent = false
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.tint(prominent ? Color("BrandAccent") : nil).interactive(), in: Capsule())
        } else {
            content.background(.regularMaterial, in: Capsule())
        }
    }
}

struct DrawingPaperPicker: View {
    @Bindable var model: DrawingModel
    var body: some View {
        Picker("Paper style", selection: $model.paperStyle) {
            Text("Blank").tag("blank")
            Text("Lined").tag("lined")
            Text("Grid").tag("grid")
        }
    }
}

/// Touch controls remain separate from the background that moves the palette.
struct WorksheetToolPalette: View {
    @Bindable var model: DrawingModel
    let viewport: CGSize
    @AppStorage("worksheet.palette.edge") private var edge = "bottom"
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var translation = CGSize.zero
    @State private var dragging = false
    @State private var colourOpen = false
    @State private var widthOpen = false

    private var vertical: Bool { edge != "bottom" }
    private var arrow: Edge { edge == "left" ? .leading : edge == "right" ? .trailing : .bottom }
    private func displayed(_ ink: DrawingInk) -> Color {
        ink == .black && colorScheme == .dark ? .white : Color(uiColor: ink.color)
    }
    private func nearest(_ point: CGPoint) -> String {
        [("left", point.x), ("right", viewport.width - point.x), ("bottom", viewport.height - point.y)].min { $0.1 < $1.1 }?.0 ?? "bottom"
    }
    var body: some View {
        // A slim bar that sits flush against its edge (8 pt inset).
        let size = CGSize(width: vertical ? 44 : 262, height: vertical ? 262 : 44)
        let inset: CGFloat = 8
        let origin = CGPoint(x: edge == "left" ? inset + size.width / 2 : edge == "right" ? viewport.width - inset - size.width / 2 : viewport.width / 2,
                             y: vertical ? max(68 + size.height / 2, viewport.height / 2) : viewport.height - inset - size.height / 2)
        let position = CGPoint(x: origin.x + translation.width, y: origin.y + translation.height)
        let layout = vertical ? AnyLayout(VStackLayout(spacing: 0)) : AnyLayout(HStackLayout(spacing: 0))
        ZStack {
            if dragging {
                PaletteEdgeHighlight(edge: nearest(position)).allowsHitTesting(false)
            }
            layout {
                Button {} label: {
                    Capsule().fill(.secondary).frame(width: vertical ? 22 : 5, height: vertical ? 5 : 22)
                        .frame(width: vertical ? 36 : 28, height: vertical ? 28 : 36).contentShape(Rectangle())
                }.highPriorityGesture(move(from: origin))
                    .accessibilityLabel("Move drawing tools")
                Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward").frame(width: 36, height: 36) }
                    .disabled(!model.canUndo).accessibilityLabel("Undo")
                Button { model.redo() } label: { Image(systemName: "arrow.uturn.forward").frame(width: 36, height: 36) }
                    .disabled(!model.canRedo).accessibilityLabel("Redo")
                Menu {
                    ForEach(DrawingTool.allCases) { tool in
                        Button(tool.title, systemImage: tool.symbol) { model.tool = tool }
                    }
                } label: { Image(systemName: model.tool.symbol).frame(width: 36, height: 36) }
                    .accessibilityLabel("Drawing tool")
                Button { colourOpen.toggle() } label: {
                    Circle().fill(displayed(model.ink)).frame(width: 20, height: 20)
                        .overlay(Circle().stroke(.primary.opacity(0.2), lineWidth: 1))
                        .frame(width: 36, height: 36).contentShape(Rectangle())
                }.accessibilityLabel("Ink colour")
                    .popover(isPresented: $colourOpen, arrowEdge: arrow) {
                        WorksheetInkChoices(model: model) { colourOpen = false }
                            .presentationCompactAdaptation(.popover)
                    }
                Button { widthOpen.toggle() } label: {
                    Group {
                        if model.tool == .objectEraser || model.tool == .lasso {
                            Image(systemName: model.tool.symbol).font(.system(size: 16, weight: .medium))
                        } else if model.tool == .eraser {
                            Circle().stroke(.primary, lineWidth: 1.5).frame(width: min(26, max(8, model.eraserWidth / 3)), height: min(26, max(8, model.eraserWidth / 3)))
                        } else {
                            Circle().fill(displayed(model.ink)).frame(width: max(5, model.inkWidth * 1.4), height: max(5, model.inkWidth * 1.4))
                        }
                    }
                        .frame(width: 36, height: 36).contentShape(Rectangle())
                }.accessibilityLabel(model.tool == .eraser ? "Eraser size" : "Stroke width")
                    .popover(isPresented: $widthOpen, arrowEdge: arrow) {
                        VStack(alignment: .leading) {
                            Text(model.tool == .eraser ? "Eraser size" : "Stroke width").font(.headline)
                            Slider(value: $model.activeWidth, in: model.activeWidthRange, step: 0.5).accessibilityLabel("Stroke width")
                        }.padding(20).frame(width: 230).presentationCompactAdaptation(.popover)
                    }
            }
            .buttonStyle(.plain).font(.system(size: 16, weight: .medium))
            .padding(vertical ? EdgeInsets(top: 6, leading: 4, bottom: 6, trailing: 4) : EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6))
            .background {
                Capsule().fill(Color(uiColor: .secondarySystemBackground).opacity(0.96))
                    .contentShape(Capsule()).gesture(move(from: origin))
            }
            .modifier(DrawingGlass())
            .simultaneousGesture(move(from: origin))
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("WorksheetDrawingCanvas")) } action: { model.canvas.toolOverlayFrameInViewport = $0 }
            .position(position)
            .disabled(!model.loaded || model.saving)
        }
        .onDisappear { model.canvas.toolOverlayFrameInViewport = .null }
    }
    private func move(from origin: CGPoint) -> some Gesture {
        // A tap wobbles a few points; only a real drag moves the palette, so taps reach its buttons.
        // Measured against the screen, not the bar: the bar moves under the finger while dragging.
        DragGesture(minimumDistance: 12, coordinateSpace: .global).onChanged { value in
            dragging = true
            translation = value.translation
        }.onEnded { value in
            let target = nearest(CGPoint(x: origin.x + value.translation.width, y: origin.y + value.translation.height))
            withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.86)) {
                edge = target; translation = .zero; dragging = false
            }
        }
    }
}

private struct WorksheetInkChoices: View {
    @Bindable var model: DrawingModel
    let selected: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Ink colour").font(.headline)
            HStack(spacing: 4) {
                ForEach(DrawingInk.allCases) { ink in
                    Button {
                        model.ink = ink
                        if !model.tool.usesInk { model.tool = .pen }
                        selected()
                    } label: {
                        Circle().fill(ink == .black && colorScheme == .dark ? Color.white : Color(uiColor: ink.color))
                            .frame(width: 28, height: 28)
                            .overlay { if model.ink == ink { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(ink == .black && colorScheme == .dark ? Color.black : Color.white) } }
                            .overlay(Circle().stroke(.primary.opacity(0.2), lineWidth: 1))
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("\(ink.title) ink")
                        .accessibilityAddTraits(model.ink == ink ? .isSelected : [])
                }
            }
        }.padding(16)
    }
}

private struct PaletteEdgeHighlight: View {
    let edge: String
    var body: some View {
        RoundedRectangle(cornerRadius: 4).fill(Color("BrandAccent").opacity(0.25))
            .frame(width: edge == "bottom" ? 100 : 4, height: edge == "bottom" ? 4 : 100)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: edge == "left" ? .leading : edge == "right" ? .trailing : .bottom)
            .padding(4)
    }
}
