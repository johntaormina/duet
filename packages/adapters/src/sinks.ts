import { defaultExec, type Exec } from "./exec.ts";

export interface SignedPost {
  readonly target: string;
  readonly text: string;
  readonly signedOffAt: string;
}

export interface PostResult {
  ok: boolean;
  postedAt?: string;
  error?: string;
}

/** An adapter that delivers text to a target. Wrap it with guardSink before use. */
export interface Sink {
  name: string;
  send(target: string, text: string): Promise<unknown>;
}

export interface GuardedSink {
  name: string;
  post(signed: SignedPost, text: string): Promise<PostResult>;
}

const SIGNED = new WeakSet<object>();

/** Creates a signed post: the reviewer's approval of this exact text for this target. */
export function signPost(p: { target: string; text: string; signedOffAt?: string }): SignedPost {
  const post = Object.freeze({ target: p.target, text: p.text, signedOffAt: p.signedOffAt ?? new Date().toISOString() });
  SIGNED.add(post);
  return post;
}

/** Enforces sign-off for any sink, including sinks an overlay adds. */
// @spec ADPT-SINK-001, ADPT-SINK-002, ADPT-SINK-005
export function guardSink(inner: Sink): GuardedSink {
  return {
    name: inner.name,
    async post(signed, text) {
      if (!SIGNED.has(signed)) throw new Error(`${inner.name} accepts only a signed post`);
      if (text !== signed.text) throw new Error(`refusing to post: the text is not byte-identical to the signed text`);
      try {
        await inner.send(signed.target, text);
        return { ok: true, postedAt: new Date().toISOString() };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}

/** Posts a comment on a GitHub pull request. Targets look like `pr#123`. Never submits a review. */
// @spec ADPT-SINK-003, ADPT-SINK-004
export function ghSink(opts: { exec?: Exec; cwd?: string } = {}): Sink {
  const exec = opts.exec ?? defaultExec;
  return {
    name: "gh",
    async send(target, text) {
      const m = /^pr#(\d+)$/.exec(target);
      if (!m) throw new Error(`the gh sink cannot post to ${target}`);
      await exec("gh", ["pr", "comment", m[1], "--body-file", "-"], { cwd: opts.cwd, input: text });
    },
  };
}
