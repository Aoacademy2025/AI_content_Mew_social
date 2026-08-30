import {
  assessSubtitleSpeechCoverage,
  parseSubtitleSpeechCoverage,
  subtitleTimingRequiresSpeechCoverage,
} from "@/lib/subtitle-speech-coverage";

export type SubtitleReleaseAuditSeverity = "p0" | "p1";

export type SubtitleReleaseAuditIssue = {
  jobId: string;
  code:
    | "missing_output"
    | "missing_subtitle_qa"
    | "failed_subtitle_qa"
    | "subtitle_qa_warning"
    | "unverified_alignment"
    | "missing_replay_evidence"
    | "missing_word_timing"
    | "missing_speech_coverage"
    | "invalid_speech_coverage"
    | "speech_coverage_incomplete"
    | "timeline_aligned_offset_mismatch";
  severity: SubtitleReleaseAuditSeverity;
  segmentIndex?: number;
};

export type SubtitleReleaseAuditRecord = {
  id: string;
  status: string;
  type: string | null;
  inputJson: string;
  outputJson: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function json(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return object(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Read-only, customer-content-free release audit used by the operations scanner. */
export function auditSubtitleReleaseRecord(record: SubtitleReleaseAuditRecord): SubtitleReleaseAuditIssue[] {
  if (record.status !== "done") return [];
  const issues: SubtitleReleaseAuditIssue[] = [];
  const output = json(record.outputJson);
  if (!output) return [{ jobId: record.id, code: "missing_output", severity: "p0" }];

  const qa = object(output.subtitleQa);
  if (!qa) {
    issues.push({ jobId: record.id, code: "missing_subtitle_qa", severity: "p1" });
  } else if (qa.status === "warning") {
    // ADR 0056: a warning shipped a clip. It is worth reading, never an incident.
    issues.push({ jobId: record.id, code: "subtitle_qa_warning", severity: "p1" });
  } else if (qa.status !== "passed") {
    // Only a Blocking Subtitle Code reaches `failed` now. Records persisted before
    // ADR 0056 can still carry a presentation-only code here.
    const presentationOnly = qa.code === "spacing_mismatch"
      || qa.code === "punctuation_only_card"
      || qa.code === "card_too_short";
    issues.push({ jobId: record.id, code: "failed_subtitle_qa", severity: presentationOnly ? "p1" : "p0" });
  }
  if (qa?.timingSource === "tts_segment_timing" || qa?.timingSource === "avatar_script_clock") {
    // A degraded (not word-accurate) clock is a releasable timing source, not a release blocker.
    issues.push({ jobId: record.id, code: "unverified_alignment", severity: "p1" });
  }

  const preview = object(output.preview);
  const evidence = preview ?? object(output.subtitleEvidence);
  if (!evidence) {
    issues.push({ jobId: record.id, code: "missing_replay_evidence", severity: "p1" });
    return issues;
  }
  const timingSource = typeof qa?.timingSource === "string"
    ? qa.timingSource
    : typeof evidence.timingSource === "string"
      ? evidence.timingSource
      : "";
  const wordsRequired = timingSource !== "upload_transcription";
  if (
    typeof evidence.fullText !== "string"
    || !evidence.fullText.trim()
    || (wordsRequired && (!Array.isArray(evidence.words) || evidence.words.length === 0))
  ) {
    issues.push({ jobId: record.id, code: "missing_word_timing", severity: "p1" });
  }

  if (subtitleTimingRequiresSpeechCoverage(timingSource)) {
    const rawSpeechCoverage = evidence.speechCoverage ?? qa?.speechCoverage;
    const speechCoverage = parseSubtitleSpeechCoverage(rawSpeechCoverage);
    if (rawSpeechCoverage !== undefined && !speechCoverage) {
      // Unreadable evidence is an evidence bug, not a broken clip.
      issues.push({ jobId: record.id, code: "invalid_speech_coverage", severity: "p1" });
    } else {
      const rawCaptions = Array.isArray(evidence.captions) ? evidence.captions : [];
      const captions = rawCaptions.flatMap((candidate) => {
        const caption = object(candidate);
        const endMs = Number(caption?.endMs);
        return Number.isFinite(endMs) ? [{ endMs }] : [];
      });
      const audioDurationMs = Number(evidence.audioDurationMs ?? qa?.audioDurationMs);
      const coverage = assessSubtitleSpeechCoverage({
        captions,
        audioDurationMs,
        speechCoverage,
      });
      // ADR 0056: coverage findings ship a clip as a warning, so they are worth reading,
      // never an ops incident. Only "nothing to show" blocks a render.
      if (coverage.status === "missing") {
        issues.push({ jobId: record.id, code: "missing_speech_coverage", severity: "p1" });
      } else if (coverage.status === "invalid") {
        issues.push({ jobId: record.id, code: "invalid_speech_coverage", severity: "p1" });
      } else if (coverage.status === "incomplete") {
        issues.push({ jobId: record.id, code: "speech_coverage_incomplete", severity: "p1" });
      }
    }
  }

  const input = json(record.inputJson);
  const isUploadCutaway = input?.mode === "upload" || evidence.avatarModel === "upload-cutaway";
  const presenterSrc = typeof evidence.avatarVideoUrl === "string" ? evidence.avatarVideoUrl : null;
  const config = object(evidence.config);
  const bgVideos = Array.isArray(config?.bgVideos) ? config.bgVideos : [];
  bgVideos.forEach((candidate, segmentIndex) => {
    const segment = object(candidate);
    if (!segment) return;
    const timelineAligned = segment.timelineAligned === true
      || (isUploadCutaway && presenterSrc !== null && segment.src === presenterSrc);
    if (!timelineAligned) return;
    const start = Number(segment.start);
    const clipOffset = Number(segment.clipOffset);
    if (!Number.isFinite(start) || !Number.isFinite(clipOffset) || Math.abs(start - clipOffset) > 1 / 30) {
      issues.push({
        jobId: record.id,
        code: "timeline_aligned_offset_mismatch",
        severity: "p0",
        segmentIndex,
      });
    }
  });

  return issues;
}
