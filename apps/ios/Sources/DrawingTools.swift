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
    var interactive = true
    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.tint(prominent ? Color("BrandAccent") : nil).interactive(interactive), in: Capsule())
        } else {
            content.background(.regularMaterial, in: Capsule())
        }
    }
}

private struct WorksheetPaletteButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(isEnabled ? 1 : 0.3)
            .background(
                Color.primary.opacity(isEnabled && configuration.isPressed ? 0.2 : 0),
                in: RoundedRectangle(cornerRadius: 10)
            )
            // Quick fade so the press reads clearly without lingering.
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
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

private struct WorksheetPaletteDockLayout: Layout {
    var center: CGPoint

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(center.x, center.y) }
        set { center = CGPoint(x: newValue.first, y: newValue.second) }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        // Place the buttons at their docked coordinates so popover anchors follow the bar.
        subviews.first?.place(
            at: CGPoint(x: bounds.minX + center.x, y: bounds.minY + center.y),
            anchor: .center,
            proposal: .unspecified
        )
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
    @State private var penMenuOpen = false
    @State private var eraserMenuOpen = false

    private var vertical: Bool { edge == "left" || edge == "right" }
    private var arrow: Edge {
        switch edge {
        case "left": .leading
        case "right": .trailing
        case "top": .top
        default: .bottom
        }
    }
    private let topInset: CGFloat = 68

    private func nearest(_ point: CGPoint) -> String {
        [("left", point.x), ("right", viewport.width - point.x),
         ("top", point.y - topInset), ("bottom", viewport.height - point.y)]
            .min { $0.1 < $1.1 }?.0 ?? "bottom"
    }
    private var pen: DrawingTool { model.tool.usesInk ? model.tool : model.lastPen }
    private var eraser: DrawingTool { isErasing ? model.tool : model.lastEraser }
    private var isErasing: Bool { model.tool == .eraser || model.tool == .objectEraser }

    var body: some View {
        // A slim bar that sits flush against its edge (8 pt inset).
        let size = CGSize(width: vertical ? 44 : 256, height: vertical ? 256 : 44)
        let inset: CGFloat = 8
        let origin = CGPoint(x: edge == "left" ? inset + size.width / 2 : edge == "right" ? viewport.width - inset - size.width / 2 : viewport.width / 2,
                             y: vertical ? max(topInset + size.height / 2, viewport.height / 2)
                                : edge == "top" ? topInset + inset + size.height / 2
                                : viewport.height - inset - size.height / 2)
        let position = CGPoint(x: origin.x + translation.width, y: origin.y + translation.height)
        let layout = vertical ? AnyLayout(VStackLayout(spacing: 0)) : AnyLayout(HStackLayout(spacing: 0))
        ZStack {
            if dragging {
                PaletteEdgeHighlight(edge: nearest(position), topInset: topInset)
                    .frame(width: viewport.width, height: viewport.height)
                    .position(x: viewport.width / 2, y: viewport.height / 2)
                    .allowsHitTesting(false)
            }
            WorksheetPaletteDockLayout(center: position) {
                layout {
                    Button {} label: {
                        Capsule().fill(.secondary).frame(width: vertical ? 22 : 5, height: vertical ? 5 : 22)
                            .frame(width: vertical ? 36 : 28, height: vertical ? 28 : 36).contentShape(Rectangle())
                    }.highPriorityGesture(move(from: origin))
                        .accessibilityLabel("Move drawing tools")
                    historyButton("Undo", symbol: "arrow.uturn.backward", enabled: model.canUndo) { model.undo() }
                    historyButton("Redo", symbol: "arrow.uturn.forward", enabled: model.canRedo) { model.redo() }
                    toolButton(pen, title: "Pen", selected: model.tool.usesInk) {
                        if model.tool.usesInk { penMenuOpen = true } else { model.tool = pen }
                    }
                    .popover(isPresented: $penMenuOpen, arrowEdge: arrow) {
                        variants([.pen, .pencil, .marker], presented: $penMenuOpen)
                    }
                    toolButton(eraser, title: "Eraser", selected: isErasing) {
                        if isErasing { eraserMenuOpen = true } else { model.tool = eraser }
                    }
                    .popover(isPresented: $eraserMenuOpen, arrowEdge: arrow) {
                        variants([.objectEraser, .eraser], presented: $eraserMenuOpen)
                    }
                    toolButton(.lasso, title: "Lasso", selected: model.tool == .lasso) { model.tool = .lasso }
                    Button { model.showInkOptions = true } label: {
                        let diameter = max(5, model.inkWidth * 1.4)
                        Circle().fill(model.ink == .black && colorScheme == .dark ? .white : Color(uiColor: model.ink.color))
                            .frame(width: diameter, height: diameter)
                            .overlay(Circle().stroke(.primary.opacity(0.2), lineWidth: 1))
                            .frame(width: 36, height: 36).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Colour and thickness")
                    .popover(isPresented: $model.showInkOptions, arrowEdge: arrow) {
                        WorksheetInkChoices(model: model, pen: pen)
                            .presentationCompactAdaptation(.popover)
                    }
                }
                .buttonStyle(WorksheetPaletteButtonStyle()).font(.system(size: 16, weight: .medium))
                .padding(vertical ? EdgeInsets(top: 6, leading: 4, bottom: 6, trailing: 4) : EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6))
                .contentShape(Capsule())
                .modifier(DrawingGlass(interactive: false))
                .simultaneousGesture(move(from: origin))
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("WorksheetDrawingCanvas")) } action: { model.canvas.toolOverlayFrameInViewport = $0 }
            }
            .disabled(!model.loaded || model.saving)
        }
        .onDisappear {
            model.canvas.toolOverlayFrameInViewport = .null
            model.showInkOptions = false
        }
    }
    private func historyButton(_ title: String, symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            Image(systemName: symbol)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .disabled(!enabled)
        .accessibilityLabel(title)
    }

    private func toolButton(_ tool: DrawingTool, title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            // The icon keeps its colour; selection is only a tinted backing, switched without animation.
            Image(systemName: tool.symbol)
                .foregroundStyle(Color.primary)
                .frame(width: 36, height: 36)
                .background(selected ? Color("BrandAccent").opacity(0.22) : .clear, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
                .transaction { $0.animation = nil }
        }
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func variants(_ tools: [DrawingTool], presented: Binding<Bool>) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(tools) { tool in
                Button {
                    model.tool = tool
                    presented.wrappedValue = false
                } label: {
                    HStack {
                        Label(tool == .eraser ? "Pixel eraser" : tool.title, systemImage: tool.symbol)
                            .fixedSize()
                        Spacer()
                        if model.tool == tool { Image(systemName: "checkmark") }
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(model.tool == tool ? .isSelected : [])
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(width: 190)
        .presentationCompactAdaptation(.popover)
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
    let pen: DrawingTool
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Ink colour").font(.headline)
            HStack(spacing: 4) {
                ForEach(DrawingInk.allCases) { ink in
                    Button {
                        model.ink = ink
                        if !model.tool.usesInk { model.tool = pen }
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
            if model.tool == .eraser {
                Text("Eraser size").font(.headline)
                Slider(value: $model.activeWidth, in: model.activeWidthRange, step: 0.5)
                    .accessibilityLabel("Eraser size")
            }
            Text("Stroke width").font(.headline)
            Slider(value: $model.inkWidth, in: 1...10, step: 0.5)
                .accessibilityLabel("Stroke width")
        }.padding(16).fixedSize(horizontal: false, vertical: true)
            .frame(width: 320)
    }
}

private struct PaletteEdgeHighlight: View {
    let edge: String
    let topInset: CGFloat
    var body: some View {
        let horizontal = edge == "top" || edge == "bottom"
        RoundedRectangle(cornerRadius: 4).fill(Color("BrandAccent").opacity(0.25))
            .frame(width: horizontal ? 100 : 4, height: horizontal ? 4 : 100)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: edge == "left" ? .leading : edge == "right" ? .trailing : edge == "top" ? .top : .bottom)
            .padding(4)
            .padding(.top, edge == "top" ? topInset : 0)
    }
}
