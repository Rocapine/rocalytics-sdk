// Text the ingest rejects for good (`string_encoding`): a U+0000 or a lone
// surrogate, e.g. an emoji cut in half by a text field's maxLength. Snapshots
// are cumulative, so one such answer would get every later seq of the run
// rejected, completion included. The tracker repairs the text instead of
// dropping the answer, and refuses only a key it cannot repair.
import { describe, expect, it } from "vitest";
import { toOnboardingRunBody } from "../src/client";
import { wellFormedText } from "../src/core/text";
import { badText } from "./contract";
import { ManualTime } from "./fakes";
import { harness, IDENTITY, MANIFEST, type Harness } from "./harness";

describe("wellFormedText", () => {
  it("the ingest's check, used below, does catch bad text", () => {
    expect(badText("Zoé \uD83D")).toBe(true);
    expect(badText({ "k\u0000": 1 })).toBe(true);
    expect(badText("😀")).toBe(false);
  });

  it("replaces a lone surrogate with U+FFFD and strips U+0000", () => {
    expect(wellFormedText("Zoé \uD83D")).toBe("Zoé �");
    expect(wellFormedText("\uDE00a")).toBe("�a");
    expect(wellFormedText("a\uD83D\uD83Db")).toBe("a��b");
    expect(wellFormedText("a\u0000b\u0000")).toBe("ab");
  });

  it("leaves valid text, emoji included, untouched", () => {
    for (const s of ["", "abc", "Zoé", "😀", "a😀é日👍🏽", "�"]) expect(wellFormedText(s)).toBe(s);
  });

  it("is idempotent", () => {
    for (const s of ["Zoé \uD83D", "\u0000\uDC00\uD800", "a😀\uD83D"]) {
      const once = wellFormedText(s);
      expect(badText(once)).toBe(false);
      expect(wellFormedText(once)).toBe(once);
    }
  });
});

describe("text the ingest would reject", () => {
  it("a text answer with a lone surrogate is repaired, reported, and the run still sends", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("goal");
    run.exitStep("goal", { answers: [{ questionKey: "name", kind: "text", value: "Zoé \uD83D" }] });
    run.complete();
    await h.tick();
    const snap = h.sink.last!;
    expect(snap.status).toBe("completed");
    expect(snap.steps[0].answers).toEqual([{ question_key: "name", kind: "text", value: "Zoé �" }]);
    expect(badText(snap)).toBe(false);
    expect(badText(toOnboardingRunBody(snap))).toBe(false);
    expect(h.diagnostics.filter((d) => d.code === "text-repaired")).toHaveLength(1);
  });

  it("a text answer with a NUL is repaired", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("goal");
    run.exitStep("goal", { answers: [{ questionKey: "name", kind: "text", value: "a\u0000b" }] });
    await h.tick();
    const snap = h.sink.last!;
    expect(snap.steps[0].answers).toEqual([{ question_key: "name", kind: "text", value: "ab" }]);
    expect(badText(toOnboardingRunBody(snap))).toBe(false);
    expect(h.diagnostics.map((d) => d.code)).toContain("text-repaired");
  });

  it("valid emoji are sent as they are, with no diagnostic", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, properties: { mood: "😀" } });
    run.enterStep("goal");
    run.exitStep("goal", { answers: [{ questionKey: "name", kind: "text", value: "Zoé 👍🏽" }] });
    await h.tick();
    expect(h.sink.last!.steps[0].answers[0]).toEqual({ question_key: "name", kind: "text", value: "Zoé 👍🏽" });
    expect(h.sink.last!.properties).toEqual({ mood: "😀" });
    expect(h.diagnostics.map((d) => d.code)).not.toContain("text-repaired");
  });

  it("property string values are repaired, at start and in setProperties", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, properties: { source: "ad\uD800" } });
    run.setProperties({ channel: "x\u0000y" });
    run.enterStep("goal");
    await h.tick();
    const snap = h.sink.last!;
    expect(snap.properties).toEqual({ source: "ad�", channel: "xy" });
    expect(badText(toOnboardingRunBody(snap))).toBe(false);
    expect(h.diagnostics.filter((d) => d.code === "text-repaired")).toHaveLength(2);
  });

  it("Studio link strings are repaired", async () => {
    const h = harness();
    const run = h.tracker.start({
      onboarding: IDENTITY,
      manifest: MANIFEST,
      studio: { onboardingId: "ob\uDC00", deploymentId: "d\u0000", audienceId: "aud" },
    });
    run.enterStep("goal");
    await h.tick();
    const snap = h.sink.last!;
    expect(snap.studio).toEqual({ onboarding_id: "ob�", deployment_id: "d", audience_id: "aud" });
    expect(badText(toOnboardingRunBody(snap))).toBe(false);
    expect(h.diagnostics.filter((d) => d.code === "text-repaired")).toHaveLength(2);
  });

  it("a Studio link that is only NULs becomes U+FFFD, not an empty link or a refused start", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, studio: { audienceId: "\u0000" } });
    run.enterStep("goal");
    await h.tick();
    expect(h.sink.last!.studio).toEqual({ audience_id: "\uFFFD" });
    expect(h.diagnostics.map((d) => d.code)).not.toContain("invalid-start");
  });


  it("a key with bad text is refused with a diagnostic, never repaired", async () => {
    const h = harness();
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("goal");
    run.exitStep("goal", { answers: [{ questionKey: "q\uD800", kind: "text", value: "fine" }] });
    await h.tick();
    expect(h.sink.last!.steps[0].answers).toEqual([]);
    expect(h.diagnostics.map((d) => d.code)).toContain("invalid-answer");
  });

  it("context strings with bad text are repaired, never refused", async () => {
    const h = harness({ context: { appVersion: "2.4\u0000", build: "\uD800", platform: "ios", osVersion: "\u0000", locale: "en", timezone: "UTC" } });
    const run = h.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("goal");
    await h.tick();
    const snap = h.sink.last!;
    expect(snap.context).toMatchObject({ app_version: "2.4", build: "�", os_version: "�" });
    expect(badText(toOnboardingRunBody(snap))).toBe(false);
    expect(h.diagnostics.filter((d) => d.code === "text-repaired")).toHaveLength(3);
    expect(h.diagnostics.map((d) => d.code)).not.toContain("invalid-start");
  });
});

describe("stored state an earlier build wrote with bad text", () => {
  const T0 = Date.parse("2026-01-10T08:00:00.000Z");
  /** Replaces the marker in everything stored with a lone surrogate, as an earlier build would have written it. */
  function plantBadText(h: Harness) {
    for (const [k, v] of Object.entries(h.storage.dump())) h.storage.setItem(k, v.split("MARK").join("\\ud83d"));
  }

  it("a resumed run is repaired before it is sent", async () => {
    const a = harness();
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("goal");
    run.exitStep("goal", { answers: [{ questionKey: "name", kind: "text", value: "ZoéMARK" }] });
    run.enterStep("experience");
    await a.tick();
    await a.tracker.idle();
    a.kill();
    plantBadText(a);

    const b = harness({ storage: a.storage, time: new ManualTime(T0 + 600_000) });
    const resumed = await b.tracker.resume();
    expect(resumed).not.toBeNull();
    resumed!.complete();
    await b.tick(0);
    expect(b.sink.received.length).toBeGreaterThan(0);
    for (const body of b.sink.received) expect(badText(toOnboardingRunBody(body))).toBe(false);
    expect(b.sink.last!.steps[0].answers).toEqual([{ question_key: "name", kind: "text", value: "Zoé�" }]);
    expect(b.sink.last!.status).toBe("completed");
    expect(b.diagnostics.map((d) => d.code)).toContain("text-repaired");
  });

  it("a stored string that is only NULs becomes U+FFFD, never empty", async () => {
    const a = harness({ context: { appVersion: "2.4.0", build: "1", platform: "ios", osVersion: "MARK", locale: "en", timezone: "UTC" } });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST, studio: { audienceId: "MARK" } });
    run.enterStep("goal");
    await a.tick();
    await a.tracker.idle();
    a.kill();
    for (const [k, v] of Object.entries(a.storage.dump())) a.storage.setItem(k, v.split("MARK").join("\\u0000"));

    const b = harness({ storage: a.storage, time: new ManualTime(T0 + 600_000) });
    const resumed = await b.tracker.resume();
    expect(resumed).not.toBeNull();
    resumed!.complete();
    await b.tick(0);
    const last = b.sink.last!;
    expect(last.context.os_version).toBe("\uFFFD");
    expect(last.studio).toEqual({ audience_id: "\uFFFD" });
    expect(badText(toOnboardingRunBody(last))).toBe(false);
  });

  it("an unsent stored snapshot is repaired before it is sent", async () => {
    const a = harness();
    a.sink.respond = () => ({ outcome: "transient" });
    const run = a.tracker.start({ onboarding: IDENTITY, manifest: MANIFEST });
    run.enterStep("goal");
    run.exitStep("goal", { answers: [{ questionKey: "name", kind: "text", value: "ZoéMARK" }] });
    run.complete();
    await a.tick(1000);
    await a.tracker.idle();
    a.kill();
    plantBadText(a);

    const b = harness({ storage: a.storage, time: new ManualTime(T0 + 600_000) });
    await b.tick(0);
    expect(b.sink.received.length).toBeGreaterThan(0);
    for (const body of b.sink.received) expect(badText(toOnboardingRunBody(body))).toBe(false);
    expect(b.sink.received[0].status).toBe("completed");
    expect(b.sink.received[0].steps[0].answers[0]).toEqual({ question_key: "name", kind: "text", value: "Zoé�" });
    expect(b.diagnostics.map((d) => d.code)).toContain("text-repaired");
  });
});
