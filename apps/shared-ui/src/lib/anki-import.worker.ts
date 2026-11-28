import { prepareAnkiImport, type AnkiPackage, type AnkiSelection } from "./anki-import";

self.onmessage = ({ data }: MessageEvent<{ package: AnkiPackage; selection: AnkiSelection }>) => {
  try {
    self.postMessage({ plan: prepareAnkiImport(data.package, data.selection) });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
