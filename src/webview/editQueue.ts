import type { EditIntent, FromWebviewMessage } from '../shared/protocol';

/**
 * Sends edit intents one at a time, each tagged with the document version it was
 * made against. The next intent goes out only after the extension answers the
 * previous one (with an update or an error), so quick successive actions are not
 * rejected as stale.
 */
export class EditQueue {
  private version: number | undefined;
  private inFlight = false;
  private readonly queue: EditIntent[] = [];

  constructor(private readonly post: (message: FromWebviewMessage) => void) {}

  submit(intent: EditIntent): void {
    this.queue.push(intent);
    this.flush();
  }

  /** A document update arrived. */
  setVersion(version: number): void {
    this.version = version;
    this.inFlight = false;
    this.flush();
  }

  /** The extension rejected the in-flight edit. */
  failed(): void {
    this.inFlight = false;
    this.flush();
  }

  private flush(): void {
    if (this.inFlight || this.version === undefined) {
      return;
    }
    const intent = this.queue.shift();
    if (intent) {
      this.inFlight = true;
      this.post({ type: 'edit', version: this.version, intent });
    }
  }
}
