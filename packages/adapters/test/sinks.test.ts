import { describe, expect, it } from "vitest";
import { ghSink, guardSink, signPost, type Exec, type Sink } from "../src/index.ts";

function recordingSink() {
  const sent: string[] = [];
  const inner: Sink = { name: "fake", async send(_target, text) { sent.push(text); return { ok: true }; } };
  return { sent, sink: guardSink(inner) };
}

describe("sinks", () => {
  // @spec ADPT-SINK-001
  it("accepts only a signed post", async () => {
    const { sink, sent } = recordingSink();
    const forged = { target: "pr#1", text: "hi", signedOffAt: "t" };
    await expect(sink.post(forged as never, "hi")).rejects.toThrow(/signed post/);
    expect(sent).toEqual([]);
  });

  // @spec ADPT-SINK-002
  it("refuses to send text that is not byte-identical to the signed text", async () => {
    const { sink, sent } = recordingSink();
    const signed = signPost({ target: "pr#1", text: "Decision log\n" });
    await expect(sink.post(signed, "Decision log")).rejects.toThrow(/identical/);
    await expect(sink.post(signed, "Decision log\n")).resolves.toMatchObject({ ok: true });
    expect(sent).toEqual(["Decision log\n"]);
  });

  // @spec ADPT-SINK-003, ADPT-SINK-004
  it("posts a pull request comment with gh and never a review", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push([cmd, ...args, opts?.input ?? ""]);
      return "";
    };
    const sink = guardSink(ghSink({ exec }));
    await sink.post(signPost({ target: "pr#12", text: "log" }), "log");
    expect(calls).toEqual([["gh", "pr", "comment", "12", "--body-file", "-", "log"]]);
    expect(calls.flat().some((a) => a === "review" || a === "--approve" || a === "--request-changes")).toBe(false);
  });

  it("retries a failed gh post", async () => {
    let n = 0;
    const exec: Exec = async () => { if (n++ < 2) throw new Error("HTTP 502"); return ""; };
    const result = await guardSink(ghSink({ exec, delayMs: 1 })).post(signPost({ target: "pr#3", text: "x" }), "x");
    expect(result.ok).toBe(true);
    expect(n).toBe(3);
  });

  // @spec ADPT-SINK-005
  it("reports whether each post succeeded", async () => {
    const failing = guardSink({ name: "f", async send() { throw new Error("network down"); } });
    const result = await failing.post(signPost({ target: "pr#1", text: "x" }), "x");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/network down/) });
    const { sink } = recordingSink();
    const ok = await sink.post(signPost({ target: "pr#1", text: "x" }), "x");
    expect(ok.ok).toBe(true);
    expect(ok.postedAt).toMatch(/^\d{4}-/);
  });
});
