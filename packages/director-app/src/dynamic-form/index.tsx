// Dynamic workflow inputs — the form Calliope derives from a workflow's `(Input:role)` nodes.
//
// This module is the one import path: the Assets, Render and Playground panels take
// `DynamicInputs` and the value helpers from here and never reach into the files behind it.
// The interface is the one the foundation placeholder declared — `DynamicInputsProps`,
// `DynamicInput`, `AssetOption`, `InputValues`, `compactInputValues`, `seedDefaults`,
// `missingRequired` — now backed by the real composer: zones (composer / media / control /
// advanced), the tabbed asset picker, resolution presets, duration and seed steppers, and
// required-field validation.

export { DynamicInputs } from "./DynamicInputs.jsx";
export type { DynamicInputsProps } from "./DynamicInputs.jsx";
export { AssetPicker, acceptForKind, tabsForMediaKind } from "./AssetPicker.jsx";
export type { AssetPickerProps, AssetTab } from "./AssetPicker.jsx";
export { baseName, compactInputValues, isBlank, mediaKindOfOption, mediaKindOfPath, missingRequired, seedDefaults } from "./types.js";
export type { AssetOption, DynamicInput, InputKind, InputValues, MediaKind } from "./types.js";
export { classifyAll, classifyInput, mediaKindOfInput, parseResolution, RESOLUTION_PRESETS, resolutionLabel } from "./classify.js";
export type { Classified, ClassifiedInput, InputWidget, InputZone } from "./classify.js";
export { hasRole, inputWithRole, isPromptLike, normalizeInputRole, roleLabel, roleOf, videoInputOf, CANONICAL_ROLES, INPUT_ROLE_ALIASES, MEDIA_ROLES } from "./roles.js";
