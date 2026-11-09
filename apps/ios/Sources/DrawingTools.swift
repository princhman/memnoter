import SwiftUI
import PencilKit

enum DrawingStyle {
    static let accent = Color(red: 67 / 255, green: 47 / 255, blue: 200 / 255)
}

enum DrawingTool: String, CaseIterable, Identifiable {
    case pen, pencil, marker, eraser, lasso
    var id: Self { self }
    var title: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .pen: "pencil.tip"
        case .pencil: "pencil"
        case .marker: "highlighter"
        case .eraser: "eraser"
        case .lasso: "lasso"
        }
    }
    var usesInk: Bool { self != .eraser && self != .lasso }
}

enum DrawingInk: String, CaseIterable, Identifiable {
    case black, blue, red, green, purple, orange
    var id: Self { self }
    var title: String { rawValue.capitalized }
    var color: UIColor {
        let rgb: UInt32 = switch self {
        case .black: 0x171717
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

    var body: some View {
        ViewThatFits(in: .horizontal) {
            tools.fixedSize()
            ScrollView(.horizontal, showsIndicators: false) { tools }
        }
        .padding(10)
        .background(.white, in: Capsule())
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
                    Circle().fill(Color(uiColor: ink.color)).frame(width: 21, height: 21)
                        .overlay { if model.ink == ink { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white) } }
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
                        Text("Stroke width").font(.headline)
                        Slider(value: $model.inkWidth, in: 1...10, step: 0.5).accessibilityLabel("Stroke width")
                        HStack {
                            ForEach([CGFloat(1.5), 3, 6], id: \.self) { width in
                                Button { model.inkWidth = width } label: {
                                    Capsule().fill(Color(uiColor: model.ink.color)).frame(width: 50, height: width)
                                        .frame(width: 64, height: 44).contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityLabel("\(width.formatted()) point stroke")
                            }
                        }
                    }.padding(24).frame(width: 280).preferredColorScheme(.light)
                }
        }
    }
    private var divider: some View { Rectangle().fill(.black.opacity(0.08)).frame(width: 1, height: 24).padding(.horizontal, 4) }
    private func icon(_ title: String, _ symbol: String, selected: Bool = false, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 18, weight: .medium))
                .foregroundStyle(selected ? DrawingStyle.accent : .black.opacity(enabled ? 0.75 : 0.2))
                .frame(width: 40, height: 40)
                .background(selected ? DrawingStyle.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!enabled).accessibilityLabel(title)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
