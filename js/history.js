// Undo / redo over document snapshots. One gesture (a slider drag, a framing session, a burst of
// key presses) becomes one labelled step: callers `begin()` before and `commit(label)` after, or
// just `commit(label)` for discrete changes; commits within `mergeMs` with the same label merge.

export class History {
  constructor({ limit = 100, mergeMs = 600, onChange } = {}) {
    this.limit = limit;
    this.mergeMs = mergeMs;
    this.onChange = onChange;
    this.stack = [];      // snapshots (JSON strings)
    this.labels = [];     // label that produced stack[i] from stack[i-1]
    this.index = -1;
    this.lastLabel = null;
    this.lastTime = 0;
  }

  /** Set the baseline (e.g. a new photo was loaded). Clears redo/undo. */
  reset(snapshot) {
    this.stack = [JSON.stringify(snapshot)];
    this.labels = [null];
    this.index = 0;
    this.lastLabel = null;
    this.onChange?.(this);
  }

  /** Record the current document after a change. */
  commit(snapshot, label = 'Change') {
    const json = JSON.stringify(snapshot);
    if (this.index >= 0 && this.stack[this.index] === json) return false;
    const now = performance.now();
    const merge = this.index > 0 && label === this.lastLabel && now - this.lastTime < this.mergeMs
      && this.index === this.stack.length - 1;
    if (merge) {
      this.stack[this.index] = json;
    } else {
      this.stack.splice(this.index + 1);
      this.labels.splice(this.index + 1);
      this.stack.push(json);
      this.labels.push(label);
      if (this.stack.length > this.limit) { this.stack.shift(); this.labels.shift(); }
      this.index = this.stack.length - 1;
    }
    this.lastLabel = label;
    this.lastTime = now;
    this.onChange?.(this);
    return true;
  }

  /** Force the next commit to start a new step even with the same label. */
  seal() { this.lastLabel = null; }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  get undoLabel() { return this.canUndo ? this.labels[this.index] : null; }
  get redoLabel() { return this.canRedo ? this.labels[this.index + 1] : null; }

  undo() {
    if (!this.canUndo) return null;
    this.index--;
    this.lastLabel = null;
    this.onChange?.(this);
    return JSON.parse(this.stack[this.index]);
  }

  redo() {
    if (!this.canRedo) return null;
    this.index++;
    this.lastLabel = null;
    this.onChange?.(this);
    return JSON.parse(this.stack[this.index]);
  }
}
