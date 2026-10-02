import { describe, expect, it } from "vitest";

/**
 * Voice dictation error policy (Objective 2). The submit page's
 * SpeechRecognition lifecycle maps every recognition error into three
 * branches; these tests pin that classification so a browser-API change can
 * never silently flip a fatal error into an infinite restart loop (or vice
 * versa). The pure classifier is exported from the client page module —
 * importing it executes no browser code.
 */
const { classifyVoiceError } = await import("@/app/citizen/submit/page");

describe("classifyVoiceError (voice lifecycle branch policy)", () => {
  it("maps fatal errors — retrying cannot recover these", () => {
    expect(classifyVoiceError("not-allowed")).toBe("fatal");
    expect(classifyVoiceError("service-not-allowed")).toBe("fatal");
    expect(classifyVoiceError("audio-capture")).toBe("fatal");
    expect(classifyVoiceError("language-not-supported")).toBe("fatal");
  });

  it("maps network/service failures as transient (bounded retry)", () => {
    expect(classifyVoiceError("network")).toBe("transient");
  });

  it("maps benign session endings that the onend handler may restart", () => {
    expect(classifyVoiceError("no-speech")).toBe("benign");
    expect(classifyVoiceError("aborted")).toBe("benign");
  });

  it("treats unknown error codes as benign (restartable, bounded by the silent-session cap)", () => {
    expect(classifyVoiceError("some-new-browser-error")).toBe("benign");
    expect(classifyVoiceError(undefined)).toBe("benign");
    expect(classifyVoiceError("")).toBe("benign");
  });
});
