/**
 * The four campaign objectives, in one place.
 *
 * Both panels offer them now: the generator writes copy to one, and the scorer
 * judges against one when the uploader knows what the creative was for. Two
 * copies of this list would drift, and the drift would be silent, because each
 * side would keep working with its own idea of what "retargeting" is called.
 *
 * The values match the enum in src/app/api/generate/route.ts and the keys of
 * OBJECTIVE_GUIDANCE in config/brand.ts.
 */
export const OBJECTIVES = [
  { value: "awareness", label: "Awareness", hint: "introduce the active" },
  { value: "consideration", label: "Consideration", hint: "why this formula" },
  { value: "conversion", label: "Conversion", hint: "outcome and offer" },
  { value: "retargeting", label: "Retargeting", hint: "assumes awareness" },
];
