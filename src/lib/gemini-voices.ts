export const GEMINI_VOICES = [
  { id: "Puck",          label: "Puck",          gender: "Male",   style: "Upbeat" },
  { id: "Charon",        label: "Charon",        gender: "Male",   style: "Informative" },
  { id: "Kore",          label: "Kore",          gender: "Female", style: "Firm" },
  { id: "Fenrir",        label: "Fenrir",        gender: "Male",   style: "Excitable" },
  { id: "Aoede",         label: "Aoede",         gender: "Female", style: "Breezy" },
  { id: "Leda",          label: "Leda",          gender: "Female", style: "Youthful" },
  { id: "Orus",          label: "Orus",          gender: "Male",   style: "Firm" },
  { id: "Zephyr",        label: "Zephyr",        gender: "Female", style: "Bright" },
  { id: "Schedar",       label: "Schedar",       gender: "Male",   style: "Even" },
  { id: "Gacrux",        label: "Gacrux",        gender: "Female", style: "Mature" },
  { id: "Pulcherrima",   label: "Pulcherrima",   gender: "Female", style: "Forward" },
  { id: "Achird",        label: "Achird",        gender: "Male",   style: "Friendly" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi", gender: "Male",   style: "Casual" },
  { id: "Vindemiatrix",  label: "Vindemiatrix",  gender: "Female", style: "Gentle" },
  { id: "Sadachbia",     label: "Sadachbia",     gender: "Male",   style: "Lively" },
] as const;

export type GeminiVoiceId = typeof GEMINI_VOICES[number]["id"];
