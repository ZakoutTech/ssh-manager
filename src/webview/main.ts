import './styles.css';
import type { AgentStatus, Environment, FromWebviewMessage, ToWebviewMessage } from '../shared/protocol';
import { createAgentPanel } from './agentPanel';
import { createApp, type App } from './app';
import { readInitialMessages } from './initialState';

declare function acquireVsCodeApi(): { postMessage(message: FromWebviewMessage): void };

/** The SSH Agent view in the activity bar: just the agent panel. */
function createAgentView(root: HTMLElement, post: (message: FromWebviewMessage) => void): App {
  const panel = createAgentPanel(post);
  root.append(panel.element);
  let status: AgentStatus | undefined;
  let environment: Environment | undefined;
  panel.update(status, environment);
  post({ type: 'ready' });
  return {
    receive(message: ToWebviewMessage): void {
      if (message.type === 'agent') {
        status = message.status;
      } else if (message.type === 'environment') {
        environment = message.environment;
      } else {
        return;
      }
      panel.update(status, environment);
    },
  };
}

const vscode = acquireVsCodeApi();
const root = document.getElementById('app') as HTMLElement;
const post = (message: FromWebviewMessage): void => vscode.postMessage(message);
const app = document.body.dataset.view === 'agent' ? createAgentView(root, post) : createApp(root, post);
// Render the embedded state right away instead of waiting for the 'ready' round trip.
for (const message of readInitialMessages(document)) {
  app.receive(message);
}
window.addEventListener('message', (event: MessageEvent<ToWebviewMessage>) => app.receive(event.data));
