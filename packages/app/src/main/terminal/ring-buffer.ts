/**
 * 终端输出的**有界** ring buffer（coding.terminal / PTY-101）——纯逻辑，不
 * import electron、不 import node-pty，因此可以被单测直接对拍。
 *
 * ## 为什么必须有界
 *
 * PTY 输出是无上界的字节流：一次 `npm install`、一个 `yes`、一段 `cat 大文件`
 * 都能在几秒里吐几 MB。主进程若把它全存下来等渲染进程 reload 后回放，那份
 * 缓存就是一条无声增长的内存泄漏。因此这里按**字符数**封顶：超了就从**头部**
 * 丢最旧的块，只保留最近的一段——终端的 scrollback 本来就是有限的，丢掉屏幕
 * 外面很久以前滚走的字节没有任何用户可见的损失。
 *
 * ## sequence 的语义
 *
 * 每 append 一块就 `++seq`，这个序号被装进 `terminal:event` 推送信封的
 * `sequence` 位。渲染进程 reload 之后由 `terminal:snapshot` 取回当前 `text` +
 * 最后一个 `sequence`，再从推送流里只接受 `sequence` 更大的块（复用
 * `shouldAcceptEnvelope`）。`clear()` **不重置** seq：清屏只清可见内容，不该让
 * 已经在途的旧序号突然变得「更大」而被误当成新块。代际（restart）切换才重置
 * ——那时会整个换一份新的 ring buffer。
 */

/** ring buffer 的默认容量（字符数）。约 200K 字符 ≈ 一屏几千行，够回放，远小于泄漏所需。 */
export const TERMINAL_RING_MAX_CHARS = 200_000;

export class TerminalRingBuffer {
  private chunks: string[] = [];
  private chars = 0;
  /** 已 append/advance 出去的最后一个序号；0 表示尚未产生任何块。 */
  private seq = 0;

  constructor(private readonly maxChars: number = TERMINAL_RING_MAX_CHARS) {}

  /**
   * 追加一段输出，返回分配给它的 sequence。
   *
   * 追加后若总字符数越界，从头部逐块丢弃最旧的内容直到回到容量内；单块本身
   * 就超容量时，只保留它的尾部（最近的 maxChars 个字符）。
   */
  append(data: string): number {
    this.seq += 1;
    if (data.length === 0) return this.seq;

    // 单块自身超容量：直接截成尾部，前面的块全部作废（它们注定要被挤掉）。
    if (data.length >= this.maxChars) {
      this.chunks = [data.slice(data.length - this.maxChars)];
      this.chars = this.chunks[0].length;
      return this.seq;
    }

    this.chunks.push(data);
    this.chars += data.length;
    while (this.chars > this.maxChars && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      if (dropped !== undefined) this.chars -= dropped.length;
    }
    return this.seq;
  }

  /**
   * 推进序号但不写入内容，返回新序号。
   *
   * 供 exit 这类**控制事件**用：它要一个比最后一段数据更大的序号（好让渲染
   * 进程在回放完数据后才处理退出），但它本身不该出现在 snapshot 的 text 里。
   */
  advance(): number {
    this.seq += 1;
    return this.seq;
  }

  /** ring buffer 的当前全部内容（有界）。 */
  text(): string {
    return this.chunks.join("");
  }

  /** 已产生的最后一个序号。 */
  get sequence(): number {
    return this.seq;
  }

  /** 当前占用的字符数（供单测断言有界）。 */
  get size(): number {
    return this.chars;
  }

  /** 清空可见内容，**不重置序号**（理由见文件头）。 */
  clear(): void {
    this.chunks = [];
    this.chars = 0;
  }
}
