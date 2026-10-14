import type { GuardedSink, SignedPost } from "@duet/adapters";
import type { ReviewSession } from "@duet/session";

/**
 * Posting the decision log: the reviewer sees and may edit the exact text, approves it, and only the
 * approved text is sent. Any edit after approval withdraws the approval.
 */
// @spec EXT-POST-001, EXT-POST-002, EXT-POST-003
export class PostFlow {
  private text: string;
  private signed: SignedPost | null = null;

  constructor(
    private session: ReviewSession,
    private target: string,
    private sink: GuardedSink,
  ) {
    this.text = session.decisionLog();
  }

  get draft(): string {
    return this.text;
  }

  get approved(): boolean {
    return this.signed !== null && this.signed.text === this.text;
  }

  edit(text: string): void {
    if (text !== this.text) {
      this.text = text;
      this.signed = null;
    }
  }

  approve(): void {
    this.signed = this.session.signPost(this.target, this.text);
  }

  async post(): Promise<{ ok: boolean; error?: string }> {
    if (!this.signed || this.signed.text !== this.text) return { ok: false, error: "Approve the exact text before posting." };
    const result = await this.sink.post(this.signed, this.text);
    this.session.recordPost(this.signed, result);
    return result;
  }
}
