import { streamByteLength } from "@agentterminal/protocol";

/** One chunk of a session's stream, numbered with its absolute journal offset. */
export interface StreamChunk { data: string; offset: number }

/** What the pane should do with a chunk the host just delivered. */
export type ChunkDisposition = "queued" | "write" | "covered";

/**
 * Offset bookkeeping for one emulator's view of a session's stream.
 *
 * The host registers a window as a subscriber inside the same lock that takes
 * the snapshot, then answers the attach over IPC - so chunks past the
 * snapshot's end reach the pane before the reply does. They have to be queued
 * across that window and merged after the replay: for a session that was just
 * created the snapshot is empty and those chunks are the shell's banner and
 * first prompt, so dropping them leaves a permanently blank pane.
 *
 * Everything at or below `appliedUpTo` is already contained in what the
 * emulator has written, so a chunk starting below it is a duplicate of
 * replayed history and is dropped rather than written twice.
 */
export class JournalMerge {
  #appliedUpTo = 0;
  #queue: StreamChunk[] = [];
  #cursor = 0;
  #attached = false;
  readonly #onCovered: (chunk: StreamChunk) => void;

  /** `onCovered` reports chunks dropped as already-replayed, for the sync log. */
  constructor(onCovered: (chunk: StreamChunk) => void = () => undefined) {
    this.#onCovered = onCovered;
  }

  /** Absolute stream position this emulator's buffer is applied up to. */
  get appliedUpTo(): number { return this.#appliedUpTo; }

  /** Chunks still waiting for the replay to drain them. */
  get queuedCount(): number { return this.#queue.length - this.#cursor; }

  /** True once the queue has drained and chunks render as they arrive. */
  get attached(): boolean { return this.#attached; }

  /**
   * Begin an attach. Called before the request goes out, never after the
   * reply lands: the queue has to be empty going in and stay untouched while
   * the request is in flight.
   */
  restart(): void {
    this.#appliedUpTo = 0;
    this.#queue = [];
    this.#cursor = 0;
    this.#attached = false;
  }

  /** A chunk arrived from the host. */
  receive(chunk: StreamChunk): ChunkDisposition {
    if (!this.#attached) {
      this.#queue.push(chunk);
      return "queued";
    }
    if (this.covers(chunk)) {
      this.#onCovered(chunk);
      return "covered";
    }
    this.#advance(chunk);
    return "write";
  }

  /**
   * The snapshot reply landed; its segments cover the stream up to
   * `endOffset`. The queue is deliberately kept - what it holds arrived
   * while the reply was in flight and is not in those segments.
   */
  openSnapshot(endOffset: number): void {
    this.#appliedUpTo = Math.max(this.#appliedUpTo, endOffset);
  }

  /**
   * The next queued chunk to write, skipping any the snapshot already
   * covered. Returns null when the queue is drained, which is also when the
   * merge goes live - chunks queued while this drains are picked up by it,
   * so there is no gap between the last replayed chunk and the first live one.
   */
  nextQueued(): StreamChunk | null {
    while (this.#cursor < this.#queue.length) {
      const chunk = this.#queue[this.#cursor]!;
      this.#cursor += 1;
      if (this.covers(chunk)) {
        this.#onCovered(chunk);
        continue;
      }
      this.#advance(chunk);
      return chunk;
    }
    this.#queue = [];
    this.#cursor = 0;
    this.#attached = true;
    return null;
  }

  /** True when the chunk starts inside what has already been applied. */
  covers(chunk: StreamChunk): boolean {
    return chunk.offset < this.#appliedUpTo;
  }

  #advance(chunk: StreamChunk): void {
    // Byte length, not UTF-16 length: journal offsets count the bytes the
    // host wrote, so a chunk with multibyte characters advances by more than
    // its `.length`.
    this.#appliedUpTo = Math.max(this.#appliedUpTo, chunk.offset + streamByteLength(chunk.data));
  }
}

/** One emulator operation in a replay plan: resize to a recorded grid, or write a segment's bytes. */
export type ReplayOp =
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "write"; data: string };

/**
 * The ordered operations a segment snapshot needs on an emulator currently
 * at `initial`: a resize when a segment's recorded grid differs from the
 * running one, then its bytes. Pure, so the replay's edge cases (back-to-
 * back grid swaps, zero-length segments, same-grid runs) are testable
 * without a terminal; the pane executes the plan op by op.
 *
 * A resize is emitted only on a REAL grid change, so two consecutive
 * same-grid segments never re-flow the buffer. A zero-length segment still
 * produces its resize: the host keeps zero-length segments for back-to-back
 * swaps (see core.rs's journal split), and the swap itself is the content.
 */
export function planSegmentReplay(
  segments: ReadonlyArray<Readonly<{ cols: number; rows: number; data: string }>>,
  initial: Readonly<{ cols: number; rows: number }>
): ReplayOp[] {
  const ops: ReplayOp[] = [];
  let cols = initial.cols;
  let rows = initial.rows;
  for (const segment of segments) {
    if (segment.cols !== cols || segment.rows !== rows) {
      cols = segment.cols;
      rows = segment.rows;
      ops.push({ kind: "resize", cols, rows });
    }
    if (segment.data.length > 0) ops.push({ kind: "write", data: segment.data });
  }
  return ops;
}
