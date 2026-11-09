import Image from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { validMasks } from "../occlusion";
import { imageTextPlugin } from "./image-plugins";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// Layout-only attributes do not belong to the inline image schema.
export function copyImageAttrs(node: Node) {
  const { alignment: _alignment, wrap: _wrap, ...attrs } = node.attrs;
  return attrs;
}

export const SavedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fileId: { default: null, parseHTML: el => el.getAttribute("data-file-id"), renderHTML: attrs => attrs.fileId ? { "data-file-id": attrs.fileId } : {} },
      imageId: { default: null, parseHTML: el => el.getAttribute("data-image-id"), renderHTML: attrs => attrs.imageId ? { "data-image-id": attrs.imageId } : {} },
      drawing: { default: null, parseHTML: el => { try { return JSON.parse(el.getAttribute("data-drawing") || "null"); } catch { return null; } }, renderHTML: attrs => attrs.drawing ? { "data-drawing": JSON.stringify(attrs.drawing) } : {} },
      masks: { default: [], parseHTML: el => { try { return validMasks(JSON.parse(el.getAttribute("data-occlusion-masks") || "[]")); } catch { return []; } }, renderHTML: attrs => ({ "data-occlusion-masks": JSON.stringify(validMasks(attrs.masks)) }) },
      // Blends the image into the theme; see image-adapt.ts.
      adaptive: {
        default: false,
        parseHTML: (element) => element.hasAttribute("data-adaptive"),
        renderHTML: (attributes) => (attributes.adaptive ? { "data-adaptive": "" } : {}),
      },
      alignment: {
        default: "left",
        parseHTML: (element) => element.getAttribute("data-align") || "left",
        renderHTML: (attributes) => ({
          "data-align": attributes.alignment,
          style: `display: block; margin-left: ${attributes.alignment === "left" ? "0" : "auto"}; margin-right: ${attributes.alignment === "right" ? "0" : "auto"}`,
        }),
      },
      // Floats the image so the following text flows around it.
      wrap: {
        default: false,
        parseHTML: (element) => element.hasAttribute("data-wrap"),
        renderHTML: (attributes) =>
          attributes.wrap
            ? { "data-wrap": "", style: `float: ${attributes.alignment === "right" ? "right" : "left"}` }
            : {},
      },
    };
  },
  parseHTML() { return [{ tag: "img[data-file-id]", priority: 60 }, { tag: "img[src]" }]; },
  addProseMirrorPlugins() {
    return [imageTextPlugin(this.type)];
  },
});

// The same image, placed within a line of text instead of on its own line.
export const InlineImage = SavedImage.extend({
  name: "inlineImage",
  inline: true,
  group: "inline",
  addAttributes() {
    const { alignment: _alignment, wrap: _wrap, ...attributes } = (this.parent?.() ?? {}) as Record<string, unknown>;
    return attributes;
  },
  parseHTML() {
    return [{ tag: "img[data-inline-image]", priority: 70 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { "data-inline-image": "" })];
  },
  // The block image already owns the markdown input rule and setImage.
  addInputRules() {
    return [];
  },
  addCommands() {
    return {};
  },
  // SavedImage's plugin covers both node types; plugin keys must be unique.
  addProseMirrorPlugins() {
    return [];
  },
});
