// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseStrictMinimalDreamModelOutput } from "../../services/memory/dream/public.js";

describe("permissive Dream model output", () => {
  it("accepts reordered fields, prose, fences, and additional fields while retaining raw output", () => {
    const value = { dreamDescription: "dream", reason: "context", longTermMemoryAdditions: ["fact"], workingMemoryCompression: "memory" };
    const text = "Here is the result:\n" + "\x60\x60\x60json\n" + JSON.stringify(value) + "\n\x60\x60\x60";
    expect(parseStrictMinimalDreamModelOutput(text)).toEqual({
      workingMemoryCompression: "memory", longTermMemoryAdditions: ["fact"], dreamDescription: "dream", rawOutput: text
    });
  });
  it("preserves content beyond former model limits and accepts host-like identity text", () => {
    const value = { workingMemoryCompression: "记".repeat(5000), longTermMemoryAdditions: Array.from({length:70},(_,i)=>"fact "+i), dreamDescription: "人物-1234567890 " + "梦".repeat(65000) };
    expect(parseStrictMinimalDreamModelOutput(JSON.stringify(value))).toMatchObject(value);
  });
  it("distinguishes missing compression from an explicitly empty replacement", () => {
    expect(parseStrictMinimalDreamModelOutput('{"dreamDescription":"dream"}')).toMatchObject({ workingMemoryCompression:null, longTermMemoryAdditions:[] });
    expect(parseStrictMinimalDreamModelOutput('{"workingMemoryCompression":""}')).toMatchObject({ workingMemoryCompression:"", dreamDescription:"" });
  });
  it("retains the actual response when a model supplies its own rawOutput field", () => {
    const text = JSON.stringify({ dreamDescription: "dream", rawOutput: "other content" });
    expect(parseStrictMinimalDreamModelOutput(text).rawOutput).toBe(text);
  });
  it("keeps plain text without inventing a memory replacement", () => {
    expect(parseStrictMinimalDreamModelOutput("a dream in prose")).toEqual({workingMemoryCompression:null,longTermMemoryAdditions:[],dreamDescription:"a dream in prose",rawOutput:"a dream in prose"});
    expect(parseStrictMinimalDreamModelOutput('"a JSON string"').dreamDescription).toBe("a JSON string");
  });
  it("accepts alternative value shapes as text and does not reject the whole result", () => {
    expect(parseStrictMinimalDreamModelOutput(JSON.stringify({working_memory_compression:{text:"memory"},long_term_memory_additions:{fact:"new fact"}}))).toMatchObject({workingMemoryCompression:'{"text":"memory"}',longTermMemoryAdditions:['{"fact":"new fact"}'],dreamDescription:""});
  });
});
