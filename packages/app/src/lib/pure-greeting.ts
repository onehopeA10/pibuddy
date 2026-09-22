/**
 * Only a standalone greeting may bypass host-side prompt augmentation.
 * Extra words always make the message a normal request.
 */
const PURE_GREETING_RE = /^(?:你好|您好|hi|hello|hey)[\s,.!?;:，。！？；：、…~～]*$/i;

export function isPureGreeting(message: string): boolean {
  return PURE_GREETING_RE.test(message.trim());
}
