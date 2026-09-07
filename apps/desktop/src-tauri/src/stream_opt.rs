//! Stream-level optimizations applied to a session's raw PTY output before it
//! is journaled and broadcast.
//!
//! Everything in here is required to be byte-for-byte invisible on screen: the
//! journal is replayed into a real emulator on every attach, so any transform
//! that changes what the emulator draws (or where the cursor lands) desyncs
//! every other client. Only two transforms clear that bar:
//!
//! - **Merging** consecutive small PTY writes that land within a couple of
//!   milliseconds into one chunk. The bytes are unchanged and their order is
//!   unchanged; only the number of `session.output` frames drops, which is
//!   pure protocol overhead (a JSON envelope plus a WebSocket frame per
//!   chunk). ConPTY in particular hands out one write per escape sequence
//!   while a TUI repaints, so a single frame can arrive as dozens of chunks.
//! - **Stripping no-ops**: a terminal title set to the value it already has,
//!   and a DEC private mode set to the state it is already in with nothing
//!   but other such sets in between. Neither reaches the screen.
//!
//! Deliberately NOT done here: dropping repaints, rewriting cursor motion, or
//! collapsing a mode set across intervening output. The last one matters -
//! `\x1b[?1002h` after a program has left and re-entered its TUI is a real
//! signal (see `crate::tui`), so a duplicate only counts while nothing else
//! was emitted between the two.

use std::{collections::HashMap, time::Duration};

/// How long a merged chunk waits for the next write before it is emitted.
/// Long enough to absorb a TUI's burst of per-sequence writes, short enough
/// that it stays under one frame of added latency for an echoed keystroke.
pub(crate) const OUTPUT_MERGE_WINDOW: Duration = Duration::from_micros(1_500);
/// Hard cap on how long a chunk may be held while writes keep trickling in.
/// Bounded deliberately: output held here is output the journal has not been
/// given an offset for yet, and a resize that lands in that gap would record
/// its grid epoch ahead of bytes the program actually drew at the old size.
pub(crate) const OUTPUT_MERGE_MAX_SPAN: Duration = Duration::from_millis(4);
/// Stop merging once this much is buffered. Bulk output already arrives in
/// large reads and gains nothing from batching; the small writes are the ones
/// worth merging.
pub(crate) const MAX_MERGED_OUTPUT_BYTES: usize = 8 * 1024;
/// An unterminated escape sequence at the end of a chunk is held back so the
/// scanner never has to guess at a half-sequence - but only this far, so a
/// stray `ESC` (or an OSC longer than any title) can never stall the stream.
const MAX_HELD_SEQUENCE_BYTES: usize = 64;

/// DEC private modes whose "set" is pure state with no side effect beyond the
/// state itself, so re-setting one to the value it already holds does nothing
/// at all. Mouse and focus tracking, and bracketed paste. Deliberately
/// excluded: the alternate screen (1047/1048/1049 also save/restore the
/// cursor and swap buffers) and cursor visibility (25), which the TUI
/// classifier reads as paint evidence.
const IDEMPOTENT_MODES: &[u32] = &[
    9, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004,
];

/// Per-session compactor. Owned by the session's output thread, so it sees the
/// stream in order and can carry state (the current title, the modes set in
/// the current run of no-ops, a half-received sequence) across chunks.
pub(crate) struct StreamCompactor {
    /// A trailing incomplete escape sequence, prepended to the next chunk.
    pending: String,
    /// Current window title / icon name, as last actually emitted.
    title: Option<String>,
    icon: Option<String>,
    /// Modes set since the last byte that was NOT a stripped-or-strippable
    /// no-op. Cleared by any other output, which is what makes "duplicate"
    /// mean "consecutive" rather than "ever seen".
    run_modes: HashMap<u32, bool>,
}

impl StreamCompactor {
    pub(crate) fn new() -> Self {
        Self {
            pending: String::new(),
            title: None,
            icon: None,
            run_modes: HashMap::new(),
        }
    }

    /// Strip the no-ops from one chunk. The returned string is what gets
    /// journaled and broadcast; anything held back for the next chunk stays in
    /// `pending`.
    pub(crate) fn compact(&mut self, chunk: &str) -> String {
        let input = if self.pending.is_empty() {
            chunk.to_string()
        } else {
            let mut joined = std::mem::take(&mut self.pending);
            joined.push_str(chunk);
            joined
        };
        let bytes = input.as_bytes();
        let mut output = String::with_capacity(input.len());
        // Start of the run of bytes that will be copied out verbatim.
        let mut copy_from = 0_usize;
        let mut index = 0_usize;
        while index < bytes.len() {
            if bytes[index] != 0x1b {
                // Any ordinary output ends the current run of no-ops.
                self.run_modes.clear();
                index += 1;
                continue;
            }
            match parse_sequence(bytes, index) {
                Sequence::Incomplete => {
                    // Hold a half-received sequence back so the next chunk can
                    // classify it whole - unless it has grown past anything
                    // that could plausibly be one.
                    if bytes.len() - index <= MAX_HELD_SEQUENCE_BYTES {
                        output.push_str(&input[copy_from..index]);
                        self.pending.push_str(&input[index..]);
                        return output;
                    }
                    self.run_modes.clear();
                    index = bytes.len();
                }
                Sequence::Complete { end, kind } => {
                    if self.is_no_op(&kind) {
                        output.push_str(&input[copy_from..index]);
                        copy_from = end;
                    } else if !matches!(kind, SequenceKind::PrivateMode { .. }) {
                        // A mode set that was kept has already recorded itself
                        // in the run; every other sequence ends the run.
                        self.run_modes.clear();
                    }
                    index = end;
                }
            }
        }
        output.push_str(&input[copy_from..]);
        output
    }

    /// Emit whatever was held back, at end of stream.
    pub(crate) fn flush(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }

    /// Decide whether `kind` changes anything, recording the new state when it
    /// does. Returns true when the sequence can be dropped.
    fn is_no_op(&mut self, kind: &SequenceKind) -> bool {
        match kind {
            SequenceKind::Title { ps, value } => {
                let (icon, title) = (*ps == 0 || *ps == 1, *ps == 0 || *ps == 2);
                let unchanged = (!icon || self.icon.as_deref() == Some(value.as_str()))
                    && (!title || self.title.as_deref() == Some(value.as_str()));
                if unchanged {
                    return true;
                }
                if icon {
                    self.icon = Some(value.clone());
                }
                if title {
                    self.title = Some(value.clone());
                }
                false
            }
            SequenceKind::PrivateMode { params, enable } => {
                if params.is_empty() || !params.iter().all(|p| IDEMPOTENT_MODES.contains(p)) {
                    // Not something we are allowed to touch: it also ends the
                    // current run, because a kept sequence is real output.
                    self.run_modes.clear();
                    return false;
                }
                if params.iter().all(|p| self.run_modes.get(p) == Some(enable)) {
                    return true;
                }
                for param in params {
                    self.run_modes.insert(*param, *enable);
                }
                false
            }
            SequenceKind::Other => false,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SequenceKind {
    /// `OSC 0/1/2 ; text` - icon name and/or window title.
    Title {
        ps: u32,
        value: String,
    },
    /// `CSI ? params h|l`.
    PrivateMode {
        params: Vec<u32>,
        enable: bool,
    },
    Other,
}

#[derive(Debug, PartialEq, Eq)]
enum Sequence {
    /// Ends (exclusive) at `end`.
    Complete { end: usize, kind: SequenceKind },
    /// Runs off the end of the chunk.
    Incomplete,
}

/// Parse one escape sequence starting at `start` (which must be an ESC).
/// Escape sequences are pure ASCII, so every index this returns is also a
/// character boundary of the enclosing `str`.
fn parse_sequence(bytes: &[u8], start: usize) -> Sequence {
    let Some(&introducer) = bytes.get(start + 1) else {
        return Sequence::Incomplete;
    };
    match introducer {
        b'[' => parse_csi(bytes, start),
        b']' => parse_osc(bytes, start),
        // Other string sequences (DCS / SOS / PM / APC): skipped whole so a
        // payload that happens to contain `h` or a title-like body is never
        // mistaken for one of ours.
        b'P' | b'X' | b'^' | b'_' => match find_string_terminator(bytes, start + 2) {
            Some((end, _)) => Sequence::Complete {
                end,
                kind: SequenceKind::Other,
            },
            None => Sequence::Incomplete,
        },
        // `ESC` + intermediates + final (charset selection and friends).
        0x20..=0x2f => {
            let mut index = start + 1;
            while index < bytes.len() && (0x20..=0x2f).contains(&bytes[index]) {
                index += 1;
            }
            match bytes.get(index) {
                Some(_) => Sequence::Complete {
                    end: index + 1,
                    kind: SequenceKind::Other,
                },
                None => Sequence::Incomplete,
            }
        }
        _ => Sequence::Complete {
            end: start + 2,
            kind: SequenceKind::Other,
        },
    }
}

fn parse_csi(bytes: &[u8], start: usize) -> Sequence {
    let mut index = start + 2;
    let mut private = false;
    let mut params = Vec::new();
    let mut current: Option<u32> = None;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'?' if index == start + 2 => private = true,
            b'0'..=b'9' => {
                current = Some(
                    current
                        .unwrap_or(0)
                        .saturating_mul(10)
                        .saturating_add(u32::from(byte - b'0')),
                );
            }
            b';' | b':' => params.push(current.take().unwrap_or(0)),
            // Any other parameter or intermediate byte (`<`, `=`, `>`, a
            // misplaced `?`): still part of the sequence, but it is not the
            // plain DEC private form, so it stays opaque. Kitty keyboard
            // flags (`CSI > n u`) land here.
            0x20..=0x3f => private = false,
            0x40..=0x7e => {
                if let Some(value) = current.take() {
                    params.push(value);
                }
                let kind = if private && (byte == b'h' || byte == b'l') {
                    SequenceKind::PrivateMode {
                        params,
                        enable: byte == b'h',
                    }
                } else {
                    SequenceKind::Other
                };
                return Sequence::Complete {
                    end: index + 1,
                    kind,
                };
            }
            _ => {
                // A control byte inside a CSI aborts it; treat what we have as
                // opaque so the bytes still pass through untouched.
                return Sequence::Complete {
                    end: index,
                    kind: SequenceKind::Other,
                };
            }
        }
        index += 1;
    }
    Sequence::Incomplete
}

fn parse_osc(bytes: &[u8], start: usize) -> Sequence {
    let Some((end, body)) = find_string_terminator(bytes, start + 2) else {
        return Sequence::Incomplete;
    };
    let text = String::from_utf8_lossy(&bytes[body.0..body.1]);
    let kind = match text.split_once(';') {
        Some((ps, value)) if matches!(ps, "0" | "1" | "2") => SequenceKind::Title {
            ps: ps.parse().unwrap_or(0),
            value: value.to_string(),
        },
        _ => SequenceKind::Other,
    };
    Sequence::Complete { end, kind }
}

/// Find the BEL or ST that ends a string sequence whose body starts at
/// `from`. Returns the index just past the terminator plus the body range.
fn find_string_terminator(bytes: &[u8], from: usize) -> Option<(usize, (usize, usize))> {
    let mut index = from;
    while index < bytes.len() {
        match bytes[index] {
            0x07 => return Some((index + 1, (from, index))),
            0x1b if bytes.get(index + 1) == Some(&b'\\') => {
                return Some((index + 2, (from, index)));
            }
            // A bare ESC that is not the start of an ST begins a new sequence:
            // the string one was abandoned mid-flight.
            0x1b if index + 1 < bytes.len() => return Some((index, (from, index))),
            _ => index += 1,
        }
    }
    None
}

/// Take everything from `buffer` that decodes as complete UTF-8, leaving an
/// incomplete trailing character behind for the next read. A PTY read can land
/// mid-character, and decoding each read on its own turns those into
/// replacement characters that then differ between the live stream and a
/// replay.
pub(crate) fn take_decodable(buffer: &mut Vec<u8>) -> String {
    let valid_up_to = match std::str::from_utf8(buffer) {
        Ok(_) => buffer.len(),
        // Truncated at the end: keep the tail for the next read.
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        // Genuinely invalid bytes: decode lossily, exactly as before.
        Err(_) => buffer.len(),
    };
    let text = String::from_utf8_lossy(&buffer[..valid_up_to]).into_owned();
    buffer.drain(..valid_up_to);
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compact(compactor: &mut StreamCompactor, chunk: &str) -> String {
        compactor.compact(chunk)
    }

    #[test]
    fn ordinary_output_passes_through_byte_for_byte() {
        let mut compactor = StreamCompactor::new();
        let stream = "PS C:\\repo> ls\r\n\x1b[31mfile.txt\x1b[0m\r\n";
        assert_eq!(compact(&mut compactor, stream), stream);
    }

    #[test]
    fn repeated_mouse_mode_block_is_stripped_within_one_run() {
        let mut compactor = StreamCompactor::new();
        let block = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
        assert_eq!(
            compact(&mut compactor, &format!("{block}{block}")),
            block.to_string()
        );
    }

    #[test]
    fn a_mode_set_again_after_real_output_is_kept() {
        // The classifier reads a mouse-tracking enable as evidence that a TUI
        // took the grid; a program that left and came back must not have its
        // re-entry silently dropped.
        let mut compactor = StreamCompactor::new();
        assert_eq!(compact(&mut compactor, "\x1b[?1002h"), "\x1b[?1002h");
        assert_eq!(compact(&mut compactor, "text"), "text");
        assert_eq!(compact(&mut compactor, "\x1b[?1002h"), "\x1b[?1002h");
    }

    #[test]
    fn a_mode_toggled_off_and_on_again_is_kept() {
        let mut compactor = StreamCompactor::new();
        let stream = "\x1b[?1002h\x1b[?1002l\x1b[?1002h";
        assert_eq!(compact(&mut compactor, stream), stream);
    }

    #[test]
    fn modes_with_side_effects_are_never_stripped() {
        let mut compactor = StreamCompactor::new();
        // Alt screen and cursor visibility both do more than hold a flag.
        let stream = "\x1b[?1049h\x1b[?1049h\x1b[?25l\x1b[?25l";
        assert_eq!(compact(&mut compactor, stream), stream);
    }

    #[test]
    fn a_multi_parameter_mode_set_is_stripped_only_when_every_mode_repeats() {
        let mut compactor = StreamCompactor::new();
        assert_eq!(
            compact(&mut compactor, "\x1b[?1002;1006h"),
            "\x1b[?1002;1006h"
        );
        assert_eq!(compact(&mut compactor, "\x1b[?1002;1006h"), "");
        // 1003 is new, so the whole sequence has to survive.
        assert_eq!(
            compact(&mut compactor, "\x1b[?1002;1003h"),
            "\x1b[?1002;1003h"
        );
    }

    #[test]
    fn a_title_set_to_the_value_it_already_has_is_stripped() {
        let mut compactor = StreamCompactor::new();
        assert_eq!(
            compact(&mut compactor, "\x1b]0;agent\x07ls\r\n"),
            "\x1b]0;agent\x07ls\r\n"
        );
        // Still a no-op across intervening output: a title has no side effect
        // beyond the title itself.
        assert_eq!(
            compact(&mut compactor, "\x1b]0;agent\x07done\r\n"),
            "done\r\n"
        );
        assert_eq!(compact(&mut compactor, "\x1b]2;agent\x1b\\"), "");
        assert_eq!(
            compact(&mut compactor, "\x1b]0;other\x07"),
            "\x1b]0;other\x07"
        );
    }

    #[test]
    fn an_icon_only_title_does_not_mask_a_window_title_change() {
        let mut compactor = StreamCompactor::new();
        assert_eq!(
            compact(&mut compactor, "\x1b]1;name\x07"),
            "\x1b]1;name\x07"
        );
        // OSC 2 sets the window title, which is still unset.
        assert_eq!(
            compact(&mut compactor, "\x1b]2;name\x07"),
            "\x1b]2;name\x07"
        );
        // OSC 0 now matches both.
        assert_eq!(compact(&mut compactor, "\x1b]0;name\x07"), "");
    }

    #[test]
    fn shell_integration_sequences_are_left_alone() {
        // OSC 7 / OSC 9;9 carry the working directory the host parses.
        let mut compactor = StreamCompactor::new();
        let stream = "\x1b]9;9;C:\\repo\x07\x1b]9;9;C:\\repo\x07";
        assert_eq!(compact(&mut compactor, stream), stream);
    }

    #[test]
    fn a_sequence_split_across_chunks_is_classified_whole() {
        let mut compactor = StreamCompactor::new();
        assert_eq!(
            compact(&mut compactor, "\x1b[?1002h\x1b[?10"),
            "\x1b[?1002h"
        );
        assert_eq!(compact(&mut compactor, "02h"), "");
        let mut split_title = StreamCompactor::new();
        assert_eq!(compact(&mut split_title, "\x1b]0;ag"), "");
        assert_eq!(compact(&mut split_title, "ent\x07"), "\x1b]0;agent\x07");
        assert_eq!(compact(&mut split_title, "\x1b]0;agent\x07"), "");
    }

    #[test]
    fn an_overlong_unterminated_sequence_is_never_held_back() {
        let mut compactor = StreamCompactor::new();
        let long = format!("\x1b]0;{}", "x".repeat(MAX_HELD_SEQUENCE_BYTES + 8));
        assert_eq!(compact(&mut compactor, &long), long);
        assert!(compactor.flush().is_empty());
    }

    #[test]
    fn flush_returns_a_held_back_fragment() {
        let mut compactor = StreamCompactor::new();
        assert_eq!(compact(&mut compactor, "done\x1b[?10"), "done");
        assert_eq!(compactor.flush(), "\x1b[?10");
        assert!(compactor.flush().is_empty());
    }

    #[test]
    fn stripping_never_reorders_or_drops_surrounding_bytes() {
        let mut compactor = StreamCompactor::new();
        let output = compact(
            &mut compactor,
            "\x1b[?1002h\x1b[?1002hprompt> \x1b]0;t\x07\x1b]0;t\x07tail",
        );
        assert_eq!(output, "\x1b[?1002hprompt> \x1b]0;t\x07tail");
    }

    #[test]
    fn an_empty_chunk_produces_nothing() {
        let mut compactor = StreamCompactor::new();
        assert_eq!(compact(&mut compactor, ""), "");
        assert!(compactor.flush().is_empty());
    }

    #[test]
    fn a_string_sequence_payload_is_never_mistaken_for_a_mode_set() {
        // A DCS/APC body can contain anything, including bytes that read as
        // a mode set or a title if the scanner walked into it.
        let mut compactor = StreamCompactor::new();
        let stream = "\x1b_\x1b[?1002h\x1b\\x1b_\x1b[?1002h\x1b\\";
        assert_eq!(compact(&mut compactor, stream), stream);
    }

    #[test]
    fn a_title_containing_semicolons_is_compared_whole() {
        // OSC splits on the FIRST semicolon only: everything after it is the
        // value, separators included.
        let mut compactor = StreamCompactor::new();
        assert_eq!(
            compact(&mut compactor, "\x1b]0;a;b;c\x07"),
            "\x1b]0;a;b;c\x07"
        );
        assert_eq!(compact(&mut compactor, "\x1b]0;a;b;c\x07"), "");
        assert_eq!(compact(&mut compactor, "\x1b]0;a;b\x07"), "\x1b]0;a;b\x07");
    }

    #[test]
    fn an_empty_title_is_a_value_like_any_other() {
        // Clearing the title, then clearing it again.
        let mut compactor = StreamCompactor::new();
        assert_eq!(compact(&mut compactor, "\x1b]0;\x07"), "\x1b]0;\x07");
        assert_eq!(compact(&mut compactor, "\x1b]0;\x07"), "");
    }

    #[test]
    fn a_mode_set_the_allowlist_does_not_cover_breaks_the_run() {
        // `?25l` is not ours to touch, and it is real output: the identical
        // mouse-tracking set after it is no longer consecutive.
        let mut compactor = StreamCompactor::new();
        let stream = "\x1b[?1002h\x1b[?25l\x1b[?1002h";
        assert_eq!(compact(&mut compactor, stream), stream);
    }

    #[test]
    fn a_mode_sequence_with_no_parameters_is_left_alone() {
        let mut compactor = StreamCompactor::new();
        let stream = "\x1b[?h\x1b[?h";
        assert_eq!(compact(&mut compactor, stream), stream);
    }

    #[test]
    fn an_abandoned_string_sequence_does_not_swallow_what_follows() {
        // An OSC interrupted by a new escape ends there rather than eating
        // the rest of the chunk: every byte still comes out, and the
        // abandoned sequence counts as output, so the mode set behind it is
        // no longer a consecutive duplicate.
        let mut compactor = StreamCompactor::new();
        assert_eq!(compact(&mut compactor, "\x1b[?1002h"), "\x1b[?1002h");
        let interrupted = "\x1b]0;half\x1b[?1002h";
        assert_eq!(compact(&mut compactor, interrupted), interrupted);
    }

    #[test]
    fn decoding_an_empty_buffer_yields_nothing() {
        let mut buffer = Vec::new();
        assert_eq!(take_decodable(&mut buffer), "");
        assert!(buffer.is_empty());
    }

    #[test]
    fn a_lone_continuation_byte_run_is_held_until_it_completes() {
        // A three-byte character split across three reads.
        let mut buffer = Vec::new();
        for byte in "\u{1f600}".as_bytes().iter().take(3) {
            buffer.push(*byte);
            assert_eq!(take_decodable(&mut buffer), "");
        }
        buffer.push("\u{1f600}".as_bytes()[3]);
        assert_eq!(take_decodable(&mut buffer), "\u{1f600}");
    }

    #[test]
    fn multibyte_output_survives_a_read_boundary() {
        let mut buffer = "héllo".as_bytes().to_vec();
        let tail = buffer.split_off(2);
        assert_eq!(take_decodable(&mut buffer), "h");
        assert_eq!(buffer.len(), 1);
        buffer.extend_from_slice(&tail);
        assert_eq!(take_decodable(&mut buffer), "éllo");
        assert!(buffer.is_empty());
    }

    #[test]
    fn invalid_bytes_still_decode_lossily() {
        let mut buffer = vec![b'a', 0xff, b'b'];
        assert_eq!(take_decodable(&mut buffer), "a\u{fffd}b");
        assert!(buffer.is_empty());
    }
}
