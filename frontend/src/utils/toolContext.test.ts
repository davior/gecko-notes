import { describe, expect, it } from "vitest";
import { buildToolContext, canPlanWithTools } from "@/utils/toolContext";

const png = {
  type: "image" as const,
  mimeType: "image/png",
  data: "aGk=",
  name: "a.png",
};
const pdf = {
  type: "document" as const,
  mimeType: "application/pdf",
  data: "aGk=",
  name: "a.pdf",
};

describe("buildToolContext", () => {
  it("carries the neutral parts of the turn, in the shape the server reads", () => {
    expect(
      buildToolContext({
        referenceBlock: "ref",
        currentNoteText: "",
        userRequest: "go",
        history: [{ role: "user", content: "hi" }],
        attachments: [png],
      }),
    ).toEqual({
      reference_block: "ref",
      current_note_text: null,
      user_request: "go",
      history: [{ role: "user", content: "hi" }],
      attachments: [{ media_type: "image/png", data: "aGk=", name: "a.png" }],
    });
  });
});

describe("canPlanWithTools", () => {
  it("needs the switch on", () => {
    expect(canPlanWithTools(false, [])).toBe(false);
    expect(canPlanWithTools(true, undefined)).toBe(true);
  });
  it("leaves a PDF to the text plan", () => {
    expect(canPlanWithTools(true, [png])).toBe(true);
    expect(canPlanWithTools(true, [png, pdf])).toBe(false);
  });
});
