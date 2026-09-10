import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";

import type { ToolError } from "@pca/contracts";

import { EXAMPLE_SENTENCES, ChangeInput } from "./change-input";
import { ChangeSubmissionService } from "./change-submission.service";

type FakeSubmission = {
  state: ReturnType<typeof signal<"idle" | "submitting" | "error">>;
  error: ReturnType<typeof signal<ToolError | null>>;
  submit: (productionId: string, text: string) => Promise<void>;
};

const render = (fake: FakeSubmission) => {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ChangeSubmissionService, useValue: fake },
    ],
  });
  const fixture = TestBed.createComponent(ChangeInput);
  fixture.componentRef.setInput("productionId", "PROD-DEMO");
  fixture.detectChanges();
  return fixture;
};

const textareaOf = (element: HTMLElement) =>
  element.querySelector("textarea") as HTMLTextAreaElement;
const buttonOf = (element: HTMLElement) =>
  element.querySelector("button.primary") as HTMLButtonElement;

describe("ChangeInput", () => {
  it("shows the golden-scenario examples as helper text", () => {
    const fixture = render({
      state: signal("idle"),
      error: signal(null),
      submit: () => Promise.resolve(),
    });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    for (const example of EXAMPLE_SENTENCES) expect(text).toContain(example);
  });

  it("disables submit until text is entered, and enables once it is", () => {
    const fixture = render({
      state: signal("idle"),
      error: signal(null),
      submit: () => Promise.resolve(),
    });
    const root = fixture.nativeElement as HTMLElement;
    expect(buttonOf(root).disabled).toBe(true);

    textareaOf(root).value = "Sarah cannot shoot Friday.";
    textareaOf(root).dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(buttonOf(root).disabled).toBe(false);
  });

  it("clicking an example fills the box without submitting", () => {
    const calls: string[] = [];
    const fixture = render({
      state: signal("idle"),
      error: signal(null),
      submit: (_id, text) => {
        calls.push(text);
        return Promise.resolve();
      },
    });
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector(".example") as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(textareaOf(root).value).toBe(EXAMPLE_SENTENCES[0]);
    expect(calls).toEqual([]);
  });

  it("submits the trimmed text and clears the box once it succeeds", async () => {
    const calls: [string, string][] = [];
    const fixture = render({
      state: signal("idle"),
      error: signal(null),
      submit: (productionId, text) => {
        calls.push([productionId, text]);
        return Promise.resolve();
      },
    });
    const root = fixture.nativeElement as HTMLElement;
    textareaOf(root).value = "  Sarah cannot shoot Friday.  ";
    textareaOf(root).dispatchEvent(new Event("input"));
    fixture.detectChanges();
    buttonOf(root).click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(calls).toEqual([["PROD-DEMO", "Sarah cannot shoot Friday."]]);
    expect(textareaOf(root).value).toBe("");
  });

  it("shows the server's error and keeps the text so the user can fix it", async () => {
    const state = signal<"idle" | "submitting" | "error">("idle");
    const error = signal<ToolError | null>(null);
    const fixture = render({
      state,
      error,
      submit: (_id, _text) => {
        state.set("error");
        error.set({ code: "UNSUPPORTED_CHANGE", message: "This sentence is not supported." });
        return Promise.resolve();
      },
    });
    const root = fixture.nativeElement as HTMLElement;
    textareaOf(root).value = "Make it better.";
    textareaOf(root).dispatchEvent(new Event("input"));
    fixture.detectChanges();
    buttonOf(root).click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(root.textContent).toContain("UNSUPPORTED_CHANGE");
    expect(root.textContent).toContain("This sentence is not supported.");
    expect(textareaOf(root).value).toBe("Make it better.");
  });

  it("disables submit and shows submitting while a request is in flight", () => {
    const fixture = render({
      state: signal("submitting"),
      error: signal(null),
      submit: () => Promise.resolve(),
    });
    const root = fixture.nativeElement as HTMLElement;
    textareaOf(root).value = "Sarah cannot shoot Friday.";
    textareaOf(root).dispatchEvent(new Event("input"));
    fixture.detectChanges();
    expect(buttonOf(root).disabled).toBe(true);
    expect(buttonOf(root).textContent).toContain("Submitting");
  });
});
