import { Extension, textInputRule } from "@tiptap/core";

export const Arrows = Extension.create({
  name: "arrows",
  addInputRules() {
    return [
      textInputRule({ find: /->$/, replace: "→" }),
      textInputRule({ find: /<-$/, replace: "←" }),
      textInputRule({ find: /=>$/, replace: "⇒" }),
    ];
  },
});
