# Hero Script narration target handoff

This delivery separates target metadata and the pre-TTS advisory from draft PR449.
It does not change writing prompts, provider selection, token limits, generation
correction policy, TTS, subtitle timing, export, or playback speed.

The selected 30/60/90-second target travels from Script through the server handoff,
Editor hydration, synchronous autosave staging, save/reopen and project reset.
Older drafts have no inferred target. Predominantly Thai Kore/Aoede text gets an
empirical estimate; other voices/languages and avatar paths remain unknown.
The small five-script envelopes are advisory, not confidence intervals or a
promise that future speech will meet ±10%.

Verification on the derivative patch: 531 Hero Script assertions and access checks;
actual Editor hook runtime including target edit/save/reopen/reset; TypeScript.
Full application browser QA and final build/CI results are recorded in the PR.

Reliable audio-duration acceptance remains open in PR449: latest first-take
±10% score is 3/5, word band 4/5. Original branch and 23 local audio files are
preserved. Post-generation comparison is a separate follow-on delivery.
