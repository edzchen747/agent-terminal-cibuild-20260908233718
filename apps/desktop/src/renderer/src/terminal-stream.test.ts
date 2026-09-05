import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JournalMerge, type StreamChunk } from "./terminal-stream.ts";

/** Drain the queue the way replayPending does, collecting what gets written. */
function drain(merge: JournalMerge): string[] {
  const written: string[] = [];
  for (let item = merge.nextQueued(); item !== null; item = merge.nextQueued()) written.push(item.data);
  return written;
}

/** Feed a live chunk and report whether the pane would write it. */
function live(merge: JournalMerge, chunk: StreamChunk): boolean {
  return merge.receive(chunk) === "write";
}

describe("JournalMerge", () => {
  it("keeps output that raced the attach reply", () => {
    // The host subscribes the window inside the lock that takes the snapshot,
    // so this chunk is emitted before the reply reaches the pane. The queue
    // has to survive openSnapshot or the pane renders nothing.
    const merge = new JournalMerge();
    merge.restart();
    assert.equal(merge.receive({ data: "PS C:\\> ", offset: 0 }), "queued");

    merge.openSnapshot(0);
    assert.deepEqual(drain(merge), ["PS C:\\> "]);
    assert.equal(merge.appliedUpTo, 8);
  });

  it("renders a fresh session whose snapshot is empty", () => {
    // A tab opened seconds ago: endOffset 0, no segments, and the banner plus
    // first prompt all arrive while the attach is in flight. This is the
    // blank-terminal case.
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "PowerShell 7.5.4\r\n", offset: 0 });
    merge.receive({ data: "PS C:\\Users\\edzch> ", offset: 18 });

    merge.openSnapshot(0);
    assert.deepEqual(drain(merge), ["PowerShell 7.5.4\r\n", "PS C:\\Users\\edzch> "]);
    assert.equal(merge.attached, true);
  });

  it("drops queued output the snapshot already replayed", () => {
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "banner\r\n", offset: 0 });

    merge.openSnapshot(8);
    assert.deepEqual(drain(merge), []);
    assert.equal(merge.appliedUpTo, 8);
  });

  it("splits a queue that straddles the snapshot end", () => {
    // Chunks from before the snapshot and chunks that raced the reply sit in
    // the same queue; only the covered ones are dropped, and order is kept.
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "before\r\n", offset: 0 });
    merge.receive({ data: "raced\r\n", offset: 8 });
    merge.receive({ data: "also raced\r\n", offset: 15 });

    merge.openSnapshot(8);
    assert.deepEqual(drain(merge), ["raced\r\n", "also raced\r\n"]);
    assert.equal(merge.appliedUpTo, 27);
  });

  it("writes a chunk that starts exactly at the snapshot end", () => {
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "next", offset: 12 });

    merge.openSnapshot(12);
    assert.deepEqual(drain(merge), ["next"]);
  });

  it("picks up output that arrives while the queue is draining", () => {
    // terminal.write is async, so the host keeps delivering between replay
    // steps. The drain reads the queue by cursor, so late arrivals are merged
    // by the same pass - there is no gap between the last replayed chunk and
    // the first live one.
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "first\r\n", offset: 0 });
    merge.openSnapshot(0);

    const written: string[] = [];
    let item = merge.nextQueued();
    while (item !== null) {
      written.push(item.data);
      if (item.data === "first\r\n") merge.receive({ data: "late\r\n", offset: 7 });
      item = merge.nextQueued();
    }

    assert.deepEqual(written, ["first\r\n", "late\r\n"]);
    assert.equal(merge.attached, true);
  });

  it("goes live only once the queue is drained", () => {
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "queued", offset: 0 });
    merge.openSnapshot(0);

    assert.equal(merge.attached, false);
    assert.equal(merge.queuedCount, 1);
    merge.nextQueued();
    assert.equal(merge.attached, false, "still draining until nextQueued reports the end");
    assert.equal(merge.nextQueued(), null);
    assert.equal(merge.attached, true);
    assert.equal(merge.queuedCount, 0);
  });

  it("writes live output in order and skips what it already applied", () => {
    const merge = new JournalMerge();
    merge.restart();
    merge.openSnapshot(0);
    drain(merge);

    assert.equal(live(merge, { data: "one\r\n", offset: 0 }), true);
    assert.equal(live(merge, { data: "two\r\n", offset: 5 }), true);
    assert.equal(merge.appliedUpTo, 10);
    // A redelivery of a chunk already applied must not be written twice.
    assert.equal(live(merge, { data: "two\r\n", offset: 5 }), false);
    assert.equal(merge.appliedUpTo, 10);
  });

  it("reports covered chunks so the sync log can record the drop", () => {
    const covered: number[] = [];
    const merge = new JournalMerge((chunk) => covered.push(chunk.offset));
    merge.restart();
    merge.receive({ data: "replayed", offset: 0 });
    merge.openSnapshot(8);
    drain(merge);
    live(merge, { data: "replayed", offset: 0 });

    assert.deepEqual(covered, [0, 0], "once from the queue drain, once from the live path");
  });

  it("advances by stream bytes, not UTF-16 code units", () => {
    // Journal offsets count the bytes the host wrote. Measuring "コピー" as
    // its .length would leave appliedUpTo short and re-write the next chunk.
    const merge = new JournalMerge();
    merge.restart();
    merge.openSnapshot(0);
    drain(merge);

    assert.equal(live(merge, { data: "コピー", offset: 0 }), true);
    assert.equal(merge.appliedUpTo, 9);
    assert.equal(live(merge, { data: "next", offset: 9 }), true);
  });

  it("counts astral characters by their byte length too", () => {
    const merge = new JournalMerge();
    merge.restart();
    merge.openSnapshot(0);
    drain(merge);

    assert.equal(live(merge, { data: "🚀", offset: 0 }), true);
    assert.equal(merge.appliedUpTo, 4, "one 4-byte character, not two code units");
  });

  it("rewinds for a re-attach and forgets the old queue", () => {
    const merge = new JournalMerge();
    merge.restart();
    merge.openSnapshot(400);
    drain(merge);
    assert.equal(merge.appliedUpTo, 400);

    merge.receive({ data: "stale", offset: 400 });
    merge.restart();
    assert.equal(merge.appliedUpTo, 0);
    assert.equal(merge.queuedCount, 0);
    assert.equal(merge.attached, false);

    // The replacement snapshot is the full history again, so the emulator
    // must not treat the old high-water mark as already applied.
    merge.openSnapshot(0);
    assert.deepEqual(drain(merge), []);
    assert.equal(live(merge, { data: "fresh", offset: 0 }), true);
  });

  it("never rewinds appliedUpTo behind what it has written", () => {
    // A snapshot that ends behind what the merge already applied must not
    // un-apply those bytes; only restart() rewinds.
    const merge = new JournalMerge();
    merge.restart();
    merge.openSnapshot(0);
    drain(merge);
    assert.equal(live(merge, { data: "0123456789", offset: 0 }), true);
    assert.equal(merge.appliedUpTo, 10);

    merge.openSnapshot(4);
    assert.equal(merge.appliedUpTo, 10);
  });

  it("drops a covered chunk whole rather than writing its tail", () => {
    // Pins the host contract this rests on: the snapshot is taken under the
    // same lock that numbers each append, so endOffset always lands on a
    // chunk boundary and no chunk ever straddles it. A chunk that starts
    // below appliedUpTo is therefore a duplicate in full, never a partial.
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "0123456789", offset: 0 });
    merge.openSnapshot(4);

    assert.deepEqual(drain(merge), []);
    assert.equal(merge.appliedUpTo, 4);
  });
});

describe("JournalMerge edge cases", () => {
  it("writes a chunk that starts exactly at the applied boundary", () => {
    // The whole merge rests on this off-by-one: at or after appliedUpTo is
    // new output, one byte before it is a duplicate. A chunk that merely
    // overlaps the applied region is dropped, never written twice.
    const merge = new JournalMerge();
    merge.restart();
    merge.openSnapshot(0);
    drain(merge);
    assert.equal(live(merge, { data: "0123456789", offset: 0 }), true);
    assert.equal(merge.appliedUpTo, 10);

    assert.equal(live(merge, { data: "next", offset: 10 }), true, "starts exactly at the boundary");
    assert.equal(merge.appliedUpTo, 14);
    assert.equal(live(merge, { data: "overlap", offset: 9 }), false, "overlaps the applied region");
    assert.equal(merge.appliedUpTo, 14, "a dropped chunk must not move the high-water mark");
  });

  it("does not stall on an empty chunk", () => {
    // A zero-length chunk advances nothing, so it must neither block the
    // queue drain nor shadow a later chunk that starts at the same offset.
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "", offset: 0 });
    merge.openSnapshot(0);
    assert.deepEqual(drain(merge), [""]);
    assert.equal(merge.appliedUpTo, 0);

    assert.equal(live(merge, { data: "x", offset: 0 }), true, "same offset, not shadowed");
    assert.equal(merge.appliedUpTo, 1);
  });

  it("reports a duplicate that arrives while the queue is draining", () => {
    // The host can redeliver a chunk whose bytes the replay already covered
    // (an in-flight retry landing mid-drain). The drain drops it, reports it
    // exactly once, and finishes - it is never written a second time.
    const covered: number[] = [];
    const merge = new JournalMerge((chunk) => covered.push(chunk.offset));
    merge.restart();
    merge.receive({ data: "first\r\n", offset: 0 });
    merge.openSnapshot(0);

    const written: string[] = [];
    let item = merge.nextQueued();
    while (item !== null) {
      written.push(item.data);
      if (item.data === "first\r\n") merge.receive({ data: "first\r\n", offset: 0 });
      item = merge.nextQueued();
    }

    assert.deepEqual(written, ["first\r\n"], "the duplicate is not written");
    assert.deepEqual(covered, [0], "reported exactly once, from the drain path");
    assert.equal(merge.attached, true);
  });

  it("drops redelivered output by offset, not by content", () => {
    // The merge trusts the host's redelivery contract: a re-sent chunk
    // carries the same bytes at the same offset. Dedup is therefore
    // offset-only - comparing the data would race the bytes against the
    // journal and add nothing.
    const merge = new JournalMerge();
    merge.restart();
    merge.openSnapshot(0);
    drain(merge);
    assert.equal(live(merge, { data: "same bytes", offset: 0 }), true);
    assert.equal(live(merge, { data: "same bytes", offset: 0 }), false, "redelivery");
  });

  it("survives a re-attach whose first attempt had in-flight chunks", () => {
    // A failed attach is retried: restart() must forget the first attempt's
    // queue - its chunks are covered by the replacement snapshot - while
    // keeping what races the second reply, so a retry never blanks the pane
    // again.
    const merge = new JournalMerge();
    merge.restart();
    merge.receive({ data: "first-try\r\n", offset: 400 });
    merge.restart();
    assert.equal(merge.queuedCount, 0, "the first attempt's queue is forgotten");

    merge.receive({ data: "raced\r\n", offset: 400 });
    merge.openSnapshot(400);
    assert.deepEqual(drain(merge), ["raced\r\n"]);
    assert.equal(merge.appliedUpTo, 407);
    assert.equal(live(merge, { data: "live", offset: 407 }), true);
  });

  it("drains a mixed queue of duplicates and fresh chunks in order", () => {
    // A queue straddling the snapshot end with a stale duplicate interleaved:
    // the fresh chunks write in arrival order, every duplicate is reported
    // once per pass it is seen, and the high-water mark lands past the last
    // byte written.
    const covered: number[] = [];
    const merge = new JournalMerge((chunk) => covered.push(chunk.offset));
    merge.restart();
    merge.receive({ data: "before\r\n", offset: 0 });
    merge.receive({ data: "raced\r\n", offset: 8 });
    merge.receive({ data: "before\r\n", offset: 0 });
    merge.receive({ data: "later\r\n", offset: 15 });

    merge.openSnapshot(8);
    assert.deepEqual(drain(merge), ["raced\r\n", "later\r\n"]);
    assert.deepEqual(covered, [0, 0], "the duplicate is seen twice in the queue");
    assert.equal(merge.appliedUpTo, 22);
    assert.equal(merge.attached, true);
  });
});
