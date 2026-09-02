import { describe, expect, it } from "vitest";
import type { StoryBundle } from "@benjidirector/calliope-client";
import { CUSTOM, GENRES, coverPath, filterProjects, parseStamp, pick, projectStats, relativeTime, resolve, statusLabel, statusTone, validateTitle, type Project } from "./project-menu.js";

const project = (over: Partial<Project> = {}): Project => ({
  id: 1,
  title: "The Approach",
  idea: null,
  genre: "thriller",
  tone: "quiet, tense",
  target_duration: "2 min",
  status: "draft",
  created_at: "2026-09-01 10:00:00",
  updated_at: "2026-09-01 10:00:00",
  ...over,
});

describe("status", () => {
  it("names Calliope's three statuses the way its cards do", () => {
    expect(statusLabel("draft")).toBe("Draft");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("completed")).toBe("Ready");
    expect(statusLabel("some_thing")).toBe("some thing");
    expect(statusLabel(null)).toBe("Draft");
    expect(statusTone("completed")).toBe("ok");
    expect(statusTone("in_progress")).toBe("info");
    expect(statusTone("draft")).toBe("");
  });
});

describe("pick / resolve", () => {
  it("shows a preset as itself, anything else as Custom plus the text", () => {
    expect(pick("Drama", GENRES, "Adventure / Mystery")).toEqual({ sel: "Drama", custom: "" });
    expect(pick("noir western", GENRES, "Adventure / Mystery")).toEqual({ sel: CUSTOM, custom: "noir western" });
    expect(pick(null, GENRES, "Adventure / Mystery")).toEqual({ sel: "Adventure / Mystery", custom: "" });
    expect(pick("  ", GENRES, "Adventure / Mystery")).toEqual({ sel: "Adventure / Mystery", custom: "" });
  });
  it("submits the custom text only when Custom is selected", () => {
    expect(resolve("Drama", "ignored")).toBe("Drama");
    expect(resolve(CUSTOM, "  noir western ")).toBe("noir western");
  });
});

describe("validateTitle", () => {
  it("requires 1–200 characters after trimming", () => {
    expect(validateTitle("Moonlit Harbor")).toBeNull();
    expect(validateTitle("   ")).toMatch(/title/);
    expect(validateTitle("x".repeat(200))).toBeNull();
    expect(validateTitle("x".repeat(201))).toMatch(/200/);
  });
});

describe("filterProjects", () => {
  const list = [project(), project({ id: 2, title: "Lantern Road", genre: "Fantasy", tone: "warm", idea: "a lighthouse keeper" })];
  it("matches title, genre, tone and idea, case-insensitively", () => {
    expect(filterProjects(list, "lantern").map((p) => p.id)).toEqual([2]);
    expect(filterProjects(list, "THRILL").map((p) => p.id)).toEqual([1]);
    expect(filterProjects(list, "lighthouse").map((p) => p.id)).toEqual([2]);
    expect(filterProjects(list, "tense").map((p) => p.id)).toEqual([1]);
    expect(filterProjects(list, "").map((p) => p.id)).toEqual([1, 2]);
    expect(filterProjects(list, "zzz")).toEqual([]);
  });
});

describe("projectStats", () => {
  it("pluralizes and tolerates a missing stats block", () => {
    expect(projectStats(project({ stats: { scene_count: 3, character_count: 2, asset_ready_count: 0, asset_total_count: 0 } }))).toBe("3 scenes · 2 characters");
    expect(projectStats(project({ stats: { scene_count: 1, character_count: 1, asset_ready_count: 0, asset_total_count: 0 } }))).toBe("1 scene · 1 character");
    expect(projectStats(project())).toBe("0 scenes · 0 characters");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  it("reads SQLite's bare UTC stamps as UTC, not local time", () => {
    expect(parseStamp("2026-09-01 11:59:30")).toBe(Date.parse("2026-09-01T11:59:30Z"));
    expect(relativeTime("2026-09-01 11:59:30", now)).toBe("just now");
  });
  it("buckets minutes, hours, days, then falls back to a date", () => {
    expect(relativeTime("2026-09-01T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-09-01T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-08-30T12:00:00Z", now)).toBe("2 d ago");
    expect(relativeTime("2026-07-01T12:00:00Z", now)).toMatch(/2026/);
  });
  it("is empty for nothing or garbage", () => {
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("coverPath", () => {
  const story: StoryBundle = {
    project: { id: 1, title: "The Approach", idea: null, genre: null, tone: null, target_duration: null, status: "draft" },
    beats: [],
    characters: [
      { id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: null },
      { id: 2, name: "Omar", role: null, age: null, appearance: null, personality: null, portrait_path: "p/omar.png", sheet_path: "s/omar.png", consistency_prompt: null },
    ],
    locations: [],
    items: [],
  };
  it("prefers the cover, then the first character sheet, then nothing", () => {
    expect(coverPath(project({ cover_path: "c.png" }), story)).toBe("c.png");
    expect(coverPath(project(), story)).toBe("s/omar.png");
    expect(coverPath(project({ id: 9 }), story)).toBeNull();
    expect(coverPath(project(), null)).toBeNull();
  });
});
