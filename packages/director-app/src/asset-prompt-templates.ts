// Image prompt templates for the asset cards — a port of Calliope's `lib/promptTemplates.ts`,
// which is itself kept in sync with `calliope.agent.prompts` (character_sheet_prompt /
// location_reference_prompt / item_reference_prompt).
//
// These are the prompts the user SEES and EDITS. Generation must never invent a hidden string:
// what the card shows is exactly what is saved to `consistency_prompt` and sent on generate.

export interface CharacterPromptFields {
  name?: string | null;
  role?: string | null;
  age?: string | null;
  appearance?: string | null;
  personality?: string | null;
}

export interface LocationPromptFields {
  name?: string | null;
  description?: string | null;
}

export interface ItemPromptFields {
  name?: string | null;
  description?: string | null;
}

export function characterSheetTemplate(c: CharacterPromptFields): string {
  const name = (c.name || "Unnamed").trim();
  const role = (c.role || "character").trim();
  const age = (c.age || "unspecified age").trim();
  const appearance = (c.appearance || "no appearance notes yet").trim();
  const personality = (c.personality || "").trim();
  const personalityLine = personality ? `Personality cues (visual only): ${personality}\n` : "";
  return (
    `CHARACTER SHEET — ${name}\n` +
    `Role: ${role}. Age: ${age}.\n` +
    `Appearance: ${appearance}\n` +
    personalityLine +
    `\n` +
    `Layout: single cinematic character reference sheet on a clean neutral backdrop, ` +
    `multiple panels — front full body, side full body, back full body, three-quarter, ` +
    `and a head close-up. Same face, hair, body proportions, and outfit in every panel. ` +
    `Neutral standing pose, even studio lighting, high detail, no text watermarks, ` +
    `no extra characters.`
  );
}

export function characterPortraitTemplate(c: CharacterPromptFields): string {
  const name = (c.name || "Unnamed").trim();
  const role = (c.role || "character").trim();
  const age = (c.age || "unspecified age").trim();
  const appearance = (c.appearance || "no appearance notes yet").trim();
  return (
    `CHARACTER PORTRAIT — ${name}\n` +
    `Role: ${role}. Age: ${age}.\n` +
    `Appearance: ${appearance}\n` +
    `\n` +
    `Shot: cinematic head-and-shoulders portrait, eye-level, soft key light, ` +
    `shallow depth of field, sharp facial features, consistent wardrobe collar/shoulders, ` +
    `plain muted background, photoreal or high-end concept art, no text.`
  );
}

export function locationReferenceTemplate(loc: LocationPromptFields): string {
  const name = (loc.name || "Unnamed place").trim();
  const description = (loc.description || "no description yet").trim();
  return (
    `ENVIRONMENT REFERENCE — ${name}\n` +
    `Description: ${description}\n` +
    `\n` +
    `Shot: wide establishing concept art, cinematic atmosphere, clear readable space ` +
    `for characters to stand in, consistent lighting and materials, no people, no text.`
  );
}

export function itemReferenceTemplate(item: ItemPromptFields): string {
  const name = (item.name || "Unnamed item").trim();
  const description = (item.description || "no description yet").trim();
  return (
    `ITEM REFERENCE — ${name}\n` +
    `Description: ${description}\n` +
    `\n` +
    `Shot: single object on a clean neutral backdrop, centered, full object in ` +
    `frame, consistent lighting and materials, high detail, no people, no text.`
  );
}
