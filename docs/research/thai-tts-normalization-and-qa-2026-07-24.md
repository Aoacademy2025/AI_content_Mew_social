# Thai TTS normalization and pronunciation QA

Date checked: 2026-07-24 (Asia/Bangkok)

## Decision

There is no single Thai package that can guarantee every future script is pronounced
correctly. The practical solution for HERO AI Voice is a layered, testable speech-text
pipeline:

1. keep the visible script separate from a deterministic `speechText`;
2. normalize known classes (numbers in context, percentages, money, dates, units,
   repetition marks, abbreviations and approved foreign words);
3. reject or flag unresolved high-risk tokens before paying for synthesis;
4. run fast text fixtures on every change; and
5. run a smaller audio regression set through OmniVoice and Thai ASR, followed by
   human listening for accent and prosody.

The repository already contains most of the necessary scaffolding. The highest-value
work is to make the test data comprehensive and connect the existing audio audit to the
actual normalized `speechText`.

## What already exists in this repository

- `src/lib/hero-voice-speech.ts` is the shared display-text to speech-text boundary. It
  already handles Thai cardinal numbers, repetition marks, audited foreign names and
  unknown Latin acronyms.
- `scripts/verify-omnivoice.ts` already tests examples such as `ซอย15`, `เลขที่150`,
  decimals, negatives, `ๆ`, telephone numbers, OTP/PIN and English aliases.
- `scripts/audit-hero-voice-clips.py` already transcribes real generated clips with
  OpenAI Whisper, calculates character error rate (CER), checks the WAV and compares
  speaker identity.
- `scripts/audit-hero-voice-catalog.py` already has a full Thai-ASR gate for the 48
  references and previews.

The important gap is that the production-clip audit compares Whisper output with the
original display script. For `30%`, the semantic expected speech is
`สามสิบเปอร์เซ็นต์`, not the literal string `30%`. The audit should receive the exact
normalized `speechText` as its reference, then add required-token assertions for
important expansions such as `เปอร์เซ็นต์`.

## Primary-source findings

### PyThaiNLP is useful, but is not a complete Thai TTS normalizer

PyThaiNLP provides several relevant primitives:

- `normalize()` removes zero-width/duplicate spaces, reorders Thai vowels and tone
  marks, and removes malformed repeats; this is orthographic cleanup, not semantic
  speech normalization. [PyThaiNLP `normalize()` documentation](https://pythainlp.org/docs/5.3/api/util.html#pythainlp.util.normalize)
- its Maiyamok helper expands `ๆ` into the repeated word.
  [PyThaiNLP Maiyamok documentation](https://pythainlp.org/docs/5.3/api/util.html#pythainlp.util.maiyamok)
- `num_to_thaiword()` converts an integer to Thai cardinal words, while
  `digit_to_text()` spells individual Arabic or Thai digits and `bahttext()` handles
  Thai currency. These are separate operations because the correct reading depends on
  context. [integer conversion](https://pythainlp.org/docs/5.3/api/util.html#pythainlp.util.num_to_thaiword),
  [digit spelling](https://pythainlp.org/docs/5.3/api/util.html#pythainlp.util.digit_to_text),
  [Baht conversion](https://pythainlp.org/docs/5.3/api/util.html#pythainlp.util.bahttext)
- it can convert Thai digits to Arabic digits, which is useful for applying one rule
  set to both `30%` and `๓๐%`.
  [Thai-digit conversion](https://pythainlp.org/docs/5.3/api/util.html#pythainlp.util.thai_digit_to_arabic_digit)
- its pronunciation tools can produce Thai respelling or IPA/G2P output. Those are
  useful for reviewing lexicon candidates, but should not be fed directly to
  OmniVoice without an audited Thai phoneme interface.
  [PyThaiNLP transliteration and pronunciation APIs](https://pythainlp.org/docs/5.3/api/transliterate.html)

Practical fit: HERO AI is a Node/TypeScript application and already has a deterministic
Thai number implementation. Adding PyThaiNLP to the request path would introduce a
second runtime without resolving contextual choices such as telephone digits versus
cardinal numbers. Use PyThaiNLP as an offline reference/differential-test tool and for
human-reviewed lexicon suggestions, not as an automatic replacement for the current
speech layer.

### Unicode CLDR is a good numeric reference, not an end-to-end speech policy

Unicode CLDR's Thai RBNF data defines official-style spellout rules for negative
numbers, decimals and Thai cardinals (`ศูนย์`, `สิบ`, `ยี่สิบ`, `ร้อย`, `ล้าน`, and
the trailing `เอ็ด` rule).
[CLDR Thai RBNF source](https://github.com/unicode-org/cldr/blob/main/common/rbnf/th.xml)

CLDR also explains that RBNF transforms numeric values into words used in speech, but
that language context is still needed. It explicitly says units do not scale well
inside number rules and should be handled separately. A percent sign is defined as a
localized number-formatting symbol; that definition does not prescribe saying the Thai
word `เปอร์เซ็นต์`.
[Unicode LDML number and RBNF specification](https://www.unicode.org/reports/tr35/tr35-numbers.html)

Practical fit: use Thai CLDR RBNF as a reference corpus for cardinal and decimal
expected values. Keep contextual suffixes such as `%`/`เปอร์เซ็นต์`, units, addresses,
telephone numbers and years in HERO AI's own ordered rules and fixtures.

### OmniVoice now has optional normalization upstream, but production does not

The production image pins OmniVoice source commit
`346bb75330980a236540d61a0808d00767c0973b`. At that commit, the project's own guidance
is to normalize Arabic numerals to words with an external text-normalization tool.
That commit has no `normalize_text` generation option.
[Pinned OmniVoice README](https://github.com/k2-fsa/OmniVoice/blob/346bb75330980a236540d61a0808d00767c0973b/README.md)

Current upstream OmniVoice has since added opt-in `normalize_text=True`. Chinese and
English use WeTextProcessing, while other languages use `num2words` only on digit
sequences (`re.sub(r"\d+", ...)`). Therefore its Thai fallback is best-effort integer
conversion; it does not supply contextual Thai rules for `%`, addresses, OTP, dates or
mixed-language brand pronunciation.
[Current OmniVoice normalization source](https://github.com/k2-fsa/OmniVoice/blob/master/omnivoice/utils/text.py),
[current OmniVoice README](https://github.com/k2-fsa/OmniVoice)

WeTextProcessing itself exposes Chinese and English normalizers in its public API, not
a Thai rule set.
[WeTextProcessing source and usage](https://github.com/wenet-e2e/WeTextProcessing)

OmniVoice's documented pronunciation overrides are pinyin for Chinese and CMU
phonemes for English. It does not document a Thai pronunciation-dictionary or Thai
phoneme override.
[OmniVoice pronunciation controls](https://github.com/k2-fsa/OmniVoice#non-verbal--pronunciation-control)

Practical fit: do not upgrade the pinned model merely to obtain its generic integer
fallback, and do not run both upstream and application normalization simultaneously.
Continue producing final Thai `speechText` in the application. Evaluate an OmniVoice
upgrade separately with supply-chain, quality and regression gates.

### SSML describes the right separation, but OmniVoice does not accept SSML

W3C SSML provides:

- `say-as` to label ambiguous constructs for normalization;
- `sub alias` to keep a written form while supplying a different spoken form; and
- `phoneme` for an explicit pronunciation.

The standard also warns that unmarked automatic normalization is inherently ambiguous
and can differ between synthesis engines.
[W3C SSML 1.1 `say-as`](https://www.w3.org/TR/speech-synthesis/#S3.1.9),
[`phoneme`](https://www.w3.org/TR/speech-synthesis/#S3.1.10),
[`sub`](https://www.w3.org/TR/speech-synthesis/#S3.1.11),
[text-normalization ambiguity](https://www.w3.org/TR/speech-synthesis/#S1.2)

Practical fit: the concepts validate HERO AI's `displayText`/`speechText` design and a
pronunciation lexicon, but the current OmniVoice `generate(text=...)` API is plain text.
Sending SSML markup would give the model literal unsupported tokens. Implement the
equivalent alias behavior before the provider boundary.

### Thai audio QA can be automated as a screening gate

OpenAI Whisper is multilingual, explicitly lists Thai (`th`) in its tokenizer and can
be invoked with a fixed language. OpenAI also cautions that accuracy varies by language,
so it is a screening signal rather than ground truth.
[Whisper repository and language/accuracy guidance](https://github.com/openai/whisper),
[Thai language entry](https://github.com/openai/whisper/blob/main/whisper/tokenizer.py)

CER is more useful than space-delimited WER for Thai regression output. JiWER provides
maintained CER and alignment functions, although the repository's existing deterministic
CER implementation is adequate if it stays tested.
[JiWER source and CER documentation](https://github.com/jitsi/jiwer)

WhisperX is not a drop-in Thai forced aligner: its documentation requires a
language-specific phoneme ASR model for languages not in its default list, and Thai is
not currently in that default mapping.
[WhisperX other-language requirements](https://github.com/m-bain/whisperX#other-languages),
[default alignment models](https://github.com/m-bain/whisperX/blob/main/whisperx/alignment.py)

Meta MMS publishes a GPU forced aligner and a model trained over 1,130 languages, but
its code/model weights are CC-BY-NC 4.0 and its fairseq repository is archived. It is
not a good dependency for this commercial production path.
[MMS forced alignment and license](https://github.com/facebookresearch/fairseq/tree/main/examples/mms#forced-alignment-tooling)

Practical fit: extend the existing local Whisper audit first. Forced alignment would
add complexity without preventing a missing word such as `เปอร์เซ็นต์` better than a
short sentinel script plus ASR/token assertions.

## Recommended data and gates

### 1. Make a versioned Thai speech specification

Add a data-driven fixture file, for example
`data/hero-voice/thai-speech-cases.json`, with:

```json
{
  "id": "percent-ascii",
  "category": "percent",
  "display": "แม่น 30% และ 90%",
  "spoken": "แม่น สามสิบเปอร์เซ็นต์ และ เก้าสิบเปอร์เซ็นต์",
  "requiredTokens": ["เปอร์เซ็นต์"],
  "source": "support-ticket-2026-07-24"
}
```

Seed it with all reported failures, then cover:

- ASCII and Thai digits; cardinals, decimals, negatives and thousands separators;
- percentages/per-mille, Baht and other currencies, units and ratios;
- addresses (`ซอย 15`, `เลขที่ 150`), telephone, OTP, PIN and postal codes;
- dates, clock times, Buddhist/AD years, ranges and fractions;
- `ๆ`, `ฯ`, abbreviations, initials and punctuation;
- URLs, email addresses, hashtags and symbols that should be skipped or verbalized;
- Thai sentences containing English brands, names, acronyms and versions.

Every support pronunciation bug should first become the smallest failing fixture. This
turns customer reports into permanent regression coverage.

### 2. Create one reviewed pronunciation lexicon

Use a versioned data file, not scattered regex replacements. Each entry should include
`match`, `spoken`, locale/context, case policy, source ticket, reviewer and review date.
Keep brand/name aliases human-reviewed. PyThaiNLP G2P may suggest a Thai respelling, but
must not silently publish it.

The lexicon implements the same written/spoken separation as SSML `sub alias`, while
remaining compatible with OmniVoice plain text.

### 3. Add a zero-cost preflight linter

After normalization and before queueing RunPod, classify unresolved high-risk tokens:

`0-9`, `๐-๙`, `%`, `‰`, currency symbols, `+`, `/`, URLs/emails, `ๆ`, unapproved Latin
words and abbreviation patterns.

Known safe punctuation can pass. Unknown constructs should either fail fast with a
specific message or emit a privacy-safe metric such as `unresolved_token=percent`;
never log the complete customer script. This catches a new class of omission before
GPU cost is incurred.

### 4. Run three regression layers

1. **Every PR, no GPU:** run all fixture transformations, exact expected output,
   idempotence (`normalize(normalize(x)) == normalize(x)`), display-text preservation
   and the unresolved-token linter. Extend `npm run verify:omnivoice` or add a focused
   `verify:hero-voice-thai`.
2. **Canary/nightly GPU:** synthesize a short sentinel suite using a representative
   voice set; run all 48 voices weekly or before a model/reference change. Record the
   app commit, OmniVoice source/model revision, voice ID and worker version.
3. **ASR screening:** compare Whisper output against normalized `speechText`, not the
   display script. Use CER plus case-specific required/forbidden tokens. A whole-clip
   CER threshold alone can miss one omitted `%` word in a long clip.

Human listening remains required for Thai naturalness, English-with-Thai-accent,
prosody and meaning-changing homographs. Automation should catch omissions and gross
pronunciation regressions, not claim a perfect linguistic oracle.

## Immediate sequence

1. Add `30%`, `90%`, `100%`, `30 %`, `30.5%`, `-5%` and `๓๐%` to the fixture before
   implementing the percent rule.
2. Implement the percent verbalization in the existing application speech layer and
   keep subtitles/display text unchanged.
3. Make the production clip audit reference exported `speechText` and require the
   token `เปอร์เซ็นต์` for the percent sentinel.
4. Move existing hard-coded English aliases into the reviewed lexicon.
5. Expand the fixture by issue frequency; evaluate an upstream OmniVoice upgrade only
   as a separate canary project.

This approach requires no new paid service. Fast checks are CPU-only; the repository
already has local Whisper audit commands, and only the scheduled audio sentinel consumes
the same RunPod capacity used for normal synthesis.
