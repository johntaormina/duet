import type { ReviewSession } from "@duet/session";
import type { Anchor } from "@duet/store";

export type PanelMessage =
  | { type: "check"; cardId: string; option?: number; rationale: string }
  | { type: "commit"; cardId: string; option?: number; rationale: string }
  | { type: "reveal"; cardId: string }
  | { type: "change"; cardId: string; option?: number; reason?: string }
  | { type: "ask"; cardId: string; question: string }
  | { type: "terminal"; cardId: string }
  | { type: "openAnchor"; anchor: Anchor }
  | { type: "showLog" }
  | { type: "post" }
  | { type: "ready" };

export interface ControllerHooks {
  post(message: unknown): void;
  refresh(): void;
  /** Asks the reviewer for a reason to change an answer; resolves undefined when they cancel. */
  askReason(cardId: string): Promise<string | undefined>;
  openAnchor(anchor: Anchor): void;
  openTerminal(cardId: string): void;
  showLog(): void;
  /** Starts the Post review comment flow. */
  postComment(): void;
  /** The panel's script has loaded and can receive messages. */
  ready(): void;
}

/** Routes every reviewer action from the panel through the review session. */
// @spec EXT-DECK-003, EXT-DECK-004, EXT-DECK-005, EXT-ASK-001
export async function handleMessage(session: ReviewSession, hooks: ControllerHooks, m: PanelMessage): Promise<void> {
  try {
    switch (m.type) {
      case "check": {
        const r = session.canCommit(m.cardId, m.option, m.rationale ?? "");
        hooks.post({ type: "checkResult", cardId: m.cardId, ok: r.ok, reason: r.ok ? "" : r.reason });
        return;
      }
      case "commit":
        session.commit(m.cardId, m.option as number, m.rationale ?? "");
        session.reveal(m.cardId);
        break;
      case "reveal":
        session.reveal(m.cardId);
        break;
      case "change": {
        const reason = m.reason ?? (await hooks.askReason(m.cardId));
        if (!reason?.trim()) {
          hooks.post({ type: "error", message: "Changing an answer needs a reason." });
          break;
        }
        session.changeOption(m.cardId, m.option as number, reason);
        break;
      }
      case "ask":
        await session.ask(m.cardId, m.question);
        break;
      case "terminal":
        hooks.openTerminal(m.cardId);
        return;
      case "openAnchor":
        hooks.openAnchor(m.anchor);
        return;
      // @spec EXT-VIEW-013
      case "showLog":
        hooks.showLog();
        return;
      // @spec EXT-POST-004
      case "post":
        hooks.postComment();
        return;
      // @spec EXT-POST-007
      case "ready":
        hooks.ready();
        return;
    }
  } catch (e) {
    hooks.post({ type: "error", message: (e as Error).message });
  }
  hooks.refresh();
}
