/**
 * Cleaning up text that comes from someone else's agent.
 *
 * Ponte puts a peer's words in front of your agent. Those words must never be
 * able to pass for your agent's own harness: a tag that looks like a system
 * notice, a fake tool result, a "Human:" turn, or a copy of the banner Ponte
 * draws around peer messages. `sanitize` runs on the receiving side, after a
 * message has been decrypted, and does four things:
 *
 *   1. folds Unicode compatibility forms (NFKC), so a fullwidth "<" or a
 *      non-breaking space is judged as what it looks like;
 *   2. turns every line-ending variant into "\n";
 *   3. deletes characters a reader cannot see (format characters such as
 *      zero-width spaces and direction overrides, stray surrogates) and
 *      control characters other than newline and tab;
 *   4. finds framing look-alikes and swaps their punctuation for similar
 *      looking characters, so a human still reads the same words but no parser
 *      or model can take them for real markup.
 *
 * It returns the cleaned text and the list of steps that changed something, so
 * the receiving agent can be warned about a sender who tried.
 *
 * The real guarantee comes from the banner in wrap.ts, whose closing line
 * carries a random tag the sender cannot predict; this filter is the second
 * layer.
 */

export const MAX_MESSAGE_BYTES = 8192;
export const MAX_NAME_LEN = 64;

/** Display names: short, plain, single-line. */
export const NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;
/** Room names on the relay. */
export const ROOM_RE = /^[A-Za-z0-9_.-]{3,64}$/;

export const FLAG_INVISIBLE = "invisible-characters-removed";
export const FLAG_CONTROL = "control-characters-removed";
export const FLAG_FRAMING = "harness-framing-neutralized";

// Replacement characters. Each one is stable under NFKC and is not itself
// matched by any rule below, so running sanitize twice gives the same text.
const LOOKALIKE: Record<string, string> = {
  "<": "\u2039", // single left-pointing angle quotation mark
  ">": "\u203a", // single right-pointing angle quotation mark
  "[": "\u2045", // left square bracket with quill
  "]": "\u2046", // right square bracket with quill
  "=": "\ua78a", // modifier letter short equals sign
  ":": "\u2236", // ratio
  "-": "\u2010", // hyphen
};

function defuse(span: string): string {
  return span.replace(/[<>[\]=:-]/g, (c) => LOOKALIKE[c] ?? c);
}

// Element names that agent harnesses use for their own messages.
const HARNESS_ELEMENTS = [
  "system(?:-[\\p{L}\\p{N}_-]+)?",
  "human",
  "assistant",
  "thinking",
  "antml:[^\\s>]*",
  "function_calls",
  "function_results",
  "tool_use",
  "tool_result",
  "cross-session-message",
  "task-notification",
  "ci-monitor-event",
  "user-prompt-submit-hook",
  "local-command-[a-z]+",
  "command-(?:name|message|args)",
  "bash-(?:input|stdout|stderr)",
];

const RULES: RegExp[] = [
  // An opening or closing harness element. With no ">" it runs to the end of
  // the text, so leaving the tag unclosed does not help.
  new RegExp(`<\\s*/?\\s*(?:${HARNESS_ELEMENTS.join("|")})(?![\\p{L}\\p{N}_-])[^>]*(?:>|$)`, "giu"),
  // Transcript turns at the start of a line.
  /^[ \t]*(?:human|assistant)[ \t]*:/gimu,
  // Bracketed notices that imitate the harness.
  /\[[ \t]*(?:system[ \t]+(?:notification|notice|message)|artifact[ \t]+comment[ \t]+sent[ \t]+to[ \t]+claude)[^\]\n]*\]/giu,
  // Anything drawn like a message banner: a rule of =, -, < or > followed by
  // "ponte message" or "peer message", with or without "end (of)".
  /[=<>-]{3,}[ \t]*(?:end[ \t]+(?:of[ \t]+)?)?(?:the[ \t]+)?(?:ponte|peer)[ \t]+message[^\n]*/giu,
];

const INVISIBLE = /[\p{Cf}\p{Cs}]/gu;
const CONTROL = /(?![\n\t])\p{Cc}/gu;

export function sanitize(input: string): [string, string[]] {
  const flags: string[] = [];
  let text = input.normalize("NFKC").replace(/\r\n?|[\u2028\u2029]/g, "\n");

  const visible = text.replace(INVISIBLE, "");
  if (visible !== text) {
    flags.push(FLAG_INVISIBLE);
    text = visible.normalize("NFKC");
  }

  const noControl = text.replace(CONTROL, "");
  if (noControl !== text) {
    flags.push(FLAG_CONTROL);
    text = noControl;
  }

  let framed = false;
  for (const rule of RULES) {
    text = text.replace(rule, (span) => {
      framed = true;
      return defuse(span);
    });
  }
  if (framed) flags.push(FLAG_FRAMING);
  return [text, flags];
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function tooLarge(text: string): boolean {
  return utf8Length(text) > MAX_MESSAGE_BYTES;
}

export function safeName(name: unknown): string | null {
  return typeof name === "string" && NAME_RE.test(name) ? name : null;
}
