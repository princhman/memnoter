// Node test reporter that writes one line per test file with a failure.
export default async function* failedFiles(source) {
  const files = new Set();
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data.file) files.add(event.data.file);
  }
  for (const file of files) yield `${file}\n`;
}
