import { createRoot } from 'react-dom/client';
import { useCommands, registerCommand } from '../../src/lib/commands';
export { registerCommand };
export function mountCommands(element: HTMLElement) {
  function Commands() { return <ul>{useCommands().map(c => <li key={c.id}>{c.title}</li>)}</ul>; }
  createRoot(element).render(<Commands />);
}
