// Enhanced prompt template for content generation

export interface ContentGenerationParams {
  instructionPrompt?: string;
  language: string;
  imageModel: string;
  videoDuration: number;
  aspectRatio?: string;
  selectedStyle?: string;
  inputText: string;
}

export function buildContentGenerationPrompt(params: ContentGenerationParams): string {
  const {
    instructionPrompt = "Write in an engaging, professional, and conversational tone suitable for social media.",
    language,
    imageModel,
    videoDuration,
    aspectRatio = "9:16",
    selectedStyle = "Not specified",
    inputText,
  } = params;

  // AI Model specifications
  const modelSpecs: Record<string, string> = {
    nanobanana: "Optimized for anime/illustration style, vivid colors, artistic rendering. Use keywords: anime, illustration, vibrant, artistic, stylized, detailed art.",
    seedream: "Best for photorealistic outputs, natural lighting, high detail. Use keywords: photorealistic, natural, detailed, cinematic, professional photography, lifelike.",
    imagen: "Excels at complex compositions, accurate text rendering, precise following of prompts. Use keywords: detailed composition, architectural, precise, sophisticated, well-composed.",
    grok: "Specialized in creative interpretations, abstract concepts, unique perspectives. Use keywords: creative, abstract, artistic interpretation, unique angle, conceptual.",
  };

  // Video pacing and word count guidelines based on TTS speaking pace (~4 words per second for Thai/English TTS)
  const videoPacing: Record<number, { description: string; wordCount: string; structure: string }> = {
    60: {
      description: "Medium-length video with clear message",
      wordCount: "230-250 words",
      structure: "Hook (1 sentence) → Main point with 2-3 key details → Call-to-action",
    },
    90: {
      description: "Extended video with story development",
      wordCount: "350-380 words",
      structure: "Hook (1-2 sentences) → Context/Background → 3-4 key points with explanations → Strong CTA",
    },
    120: {
      description: "Full narrative video with comprehensive coverage",
      wordCount: "460-500 words",
      structure: "Strong hook → Background/Context (2-3 sentences) → 4-5 detailed points with examples → Recap → Compelling CTA",
    },
  };

  // Find closest duration key
  const durationKey = videoDuration <= 60 ? 60 : videoDuration <= 90 ? 90 : 120;
  const pacing = videoPacing[durationKey];

  const prompt = `You are an expert social media content creator specializing in visual storytelling with AI-generated imagery.

====================
CONFIGURATION
====================
Writing Style: ${instructionPrompt}
Language: ${language === "TH" ? "Thai (ไทย)" : "English"}
AI Image Model: ${imageModel}
Video Duration: ${videoDuration} seconds (${pacing.wordCount})
Video Aspect Ratio: ${aspectRatio}
Content Structure: ${pacing.structure}
Pacing: ${pacing.description}

====================
AI MODEL SPECIFICATIONS
====================
Selected Model: ${imageModel}

${modelSpecs[imageModel] || modelSpecs.nanobanana}

Apply these technical parameters in the image prompt generation to achieve optimal results with this specific model.

====================
INPUT DATA
====================
Style Reference: ${selectedStyle}
Content Knowledge Base:
"""
${inputText}
"""

====================
CONTENT CREATION PROCESS
====================

STEP 1: ANALYZE INPUT
- Carefully read and understand the knowledge base content
- Identify key themes, emotions, and visual storytelling opportunities
- Consider how ${imageModel} model strengths align with the content
- Note the style reference and plan to incorporate its aesthetic

STEP 2: OPTIMIZE FOR VIDEO FORMAT
- Account for ${videoDuration} seconds viewing time
- Target word count: ${pacing.wordCount} (TTS speaking pace: ~4 words per second)
- Content structure: ${pacing.structure}
- ${pacing.description}
- Plan visual flow and transitions
- Ensure message can be consumed comfortably within time constraint

STEP 3: CREATE STRUCTURED CONTENT

Generate the following components with meticulous attention to detail:

1. **Headline** (Hook)
   - 6-10 words maximum
   - Create emotional impact with powerful, concrete words
   - Use active voice and present tense
   - Promise specific value or spark curiosity
   - ${language === "TH" ? "ใช้ภาษาไทยที่ดึงดูดใจ กระชับ และสื่อสารตรงประเด็น" : "Use punchy, direct English that stops the scroll"}
   - Must work standalone and make sense without context
   - Avoid generic phrases - be specific and unique

2. **Sub Headline** (Amplification)
   - 12-20 words
   - Elaborate on the headline with compelling details
   - Include surprising fact, benefit, or unique angle
   - Build anticipation for the main content
   - Answer "Why should I care?" or "What's in it for me?"
   - ${language === "TH" ? "ขยายความด้วยรายละเอียดที่น่าสนใจ ใช้ภาษาที่ดึงดูดความสนใจ" : "Expand with intriguing specifics that hook attention"}

3. **Content** (Main Message) - THIS IS THE VIDEO SCRIPT
   - CRITICAL: Write EXACTLY ${pacing.wordCount} for ${videoDuration} seconds video
   - Strictly follow the provided writing style from start to finish
   - Structure: ${pacing.structure}
   - Write in PLAIN TEXT ONLY - NO markdown formatting, NO asterisks, NO special characters
   - Use line breaks (\\n) for natural pauses and rhythm
   - Use simple dashes or numbers for lists if needed (not bullet points)
   - Keep sentences short and conversational (10-15 words per sentence)
   - ${language === "TH" ? "เขียนภาษาไทยที่เป็นธรรมชาติ ใช้ particles (ครับ/ค่ะ/นะ/เลย) อย่างเหมาะสม ให้อ่านง่ายและฟังสบาย" : "Write natural, conversational English that sounds great when read aloud"}
   - Match the tone and personality from the writing style instructions
   - End with clear, specific call-to-action
   - Count your words - must be within ${pacing.wordCount} range

4. **Hashtags** (Discovery & Reach)
   - Generate exactly 6-8 hashtags
   - Strategic distribution:
     * 2 trending/high-volume hashtags (broad reach)
     * 3-4 niche/category-specific hashtags (target audience)
     * 1-2 unique/branded hashtags (brand identity)
   - ${language === "TH" ? "ใช้ผสมระหว่างไทยและอังกฤษ เน้นแฮชแท็กที่มีคนค้นหาจริง" : "Use relevant English hashtags with proven search volume"}
   - Research-backed: use hashtags people actually search for
   - Mix of general and specific terms
   - Format: Space-separated with # prefix (e.g., "#example #hashtag #content")

5. **Image Prompt** (Visual Generation)
   - Create detailed, comprehensive prompt optimized specifically for ${imageModel}
   - Structure:
     * Main subject/scene (clear and specific)
     * Style keywords matching ${selectedStyle} aesthetic
     * Lighting description (time of day, mood, quality)
     * Mood and atmosphere
     * Composition details (framing, perspective, focal point)
     * Technical parameters (${aspectRatio}, quality modifiers)
     * Model-specific keywords for ${imageModel}
   - Length: 100-200 words
   - Use English for prompt regardless of content language
   - Include negative prompts if needed (things to avoid)
   - Example structure: "A [subject], [style], [lighting], [mood], [composition details], [technical quality], ${(modelSpecs[imageModel] || "").split("Use keywords: ")[1] || ""}"

6. **Visual Notes** (Implementation Guidance)
   - Brief director's notes for ${videoDuration}s video production
   - Suggest 2-4 key visual transitions or scene changes
   - Recommend text overlay timing (which lines to emphasize visually)
   - Suggest background music mood/genre/tempo
   - Note any special visual effects or transitions
   - Keep concise: 3-5 sentences maximum

====================
QUALITY GUIDELINES
====================
✓ CRITICAL: Content must be PLAIN TEXT - NO asterisks, NO markdown, NO special formatting
✓ CRITICAL: Content word count must match ${pacing.wordCount} for ${videoDuration}s video
✓ Use ONLY information from the knowledge base - no fabrication
✓ Strictly follow the provided writing style throughout all content
✓ Optimize for mobile viewing (90% of viewers)
✓ Ensure cultural appropriateness for ${language === "TH" ? "Thai" : "English"} audience
✓ Make every word count - be concise and impactful
✓ Write content that sounds natural when read aloud
✓ Headlines must grab attention in first 2 seconds
✓ Hashtags must be searchable and relevant
✓ Verify image prompt leverages ${imageModel} strengths

====================
OUTPUT FORMAT
====================
Return ONLY valid JSON with this EXACT structure. Do not include markdown code blocks, explanatory text, or any other formatting:

{
  "headline": "string (6-10 words, powerful attention-grabbing hook)",
  "subHeadline": "string (12-20 words, compelling amplification of headline)",
  "content": "string (PLAIN TEXT ONLY, ${pacing.wordCount}, use \\n for line breaks, NO asterisks or markdown)",
  "hashtags": "string (6-8 hashtags, space-separated with # prefix)",
  "imagePrompt": "string (detailed 100-200 word prompt optimized for ${imageModel})",
  "visualNotes": "string (brief director notes for ${videoDuration}s video production)"
}

CRITICAL REQUIREMENTS:
- Pure JSON output only - no markdown, no code blocks, no extra text
- No trailing commas in JSON
- All strings must be properly escaped (use \\n for line breaks, \\" for quotes)
- Ensure all fields are present and properly filled
- Return immediately with the JSON - no preamble or explanation

Generate the content now based on the knowledge base provided above.`;

  return prompt;
}
