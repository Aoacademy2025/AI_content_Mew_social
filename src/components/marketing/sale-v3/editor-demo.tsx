"use client";

import { useEffect, useRef } from "react";
import { DEMO_CLIPS, type DemoClipKey } from "./demo-data";

// The sale-page hero: a copy of the real video editor (editor v2 tokens, caption
// list, preview, quick styles, 5 tracks) playing four real team clips, driven by a
// simulated chat that calls the real connector tool names. Everything the chat
// "does" only changes what is on screen here; nothing talks to the server.

const A = "/sale/";
const META: Record<DemoClipKey, { tab: string; name: string; thumb: string; hook: string; ask: string; file: string }> = {
  brownie: { tab: "ขายของ", name: "กล่องบราวนี่ G01", thumb: "brownie-w2.jpg", hook: "หยุดก่อน! ของขวัญแก้ง่วงทั้งออฟฟิศ", ask: "ทำคลิปขายกล่องบราวนี่จากสคริปต์นี้", file: "สคริปต์บราวนี่.txt" },
  locked: { tab: "ข่าว + พิธีกร", name: "Locked Chats อธิบายง่าย", thumb: "locked-w3.jpg", hook: "ChatGPT ซ่อนแชทได้แล้ว", ask: "ใช้คลิปพิธีกรที่อัปไว้ ใส่ซับกับภาพประกอบให้", file: "คลิปพิธีกร.mp4" },
  digital: { tab: "สอนใช้งาน", name: "เปิดร้านขายไฟล์", thumb: "digital-w0.jpg", hook: "เปิดร้านขายไฟล์ ใน 2 นาที", ask: "ทำคลิปสอนเปิดร้าน ใช้ภาพจริงจากคลัง", file: "สคริปต์สอนเปิดร้าน.txt" },
  pixza: { tab: "มาสคอตแบรนด์", name: "พิกซ่า สร้างร้าน", thumb: "pixza-w2.jpg", hook: "ขายผ่านลิงก์ รับพร้อมเพย์", ask: "ทำคลิปโปรโมตร้าน ใช้ภาพมาสคอตของแบรนด์", file: "ภาพมาสคอต 5 ภาพ" },
};
const KEYS = Object.keys(META) as DemoClipKey[];
// The real V2_QUICK_STYLES: [preset, effect, label, hint]
const QS: [string, string, string, string][] = [
  ["stroke", "bounce", "เด้งไวรัล", "ขอบดำ เด้งเข้า"],
  ["shadow", "fade", "เงาเข้ม", "เงานุ่ม อ่านง่าย"],
  ["sharp-outline", "quick", "ขอบหนา", "คมชัด"],
  ["box-rounded", "fade", "มินิมอล", "กล่องเรียบ"],
];
const MUSIC: Record<string, string> = {
  pop_acoustic_groovy_playful: "ป๊อปอะคูสติก สนุก",
  cinematic_dramatic_classical: "ซีเนมาติก ดราม่า",
};
const MUSIC_ALT = ["ป๊อปอะคูสติก สนุก", "ซีเนมาติก ดราม่า"];
const CHIPS: [string, string][] = [
  ["hook", "ใส่พาดหัวตอนเปิด"],
  ["style", "เปลี่ยนสไตล์ซับ"],
  ["len", "ซับยาวขึ้น"],
  ["music", "เปลี่ยนเพลง"],
  ["export", "ส่งออก"],
];

type Cap = [number, number, string];
type CmdName = "hook" | "style" | "len" | "music" | "export";

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return String(m).padStart(2, "0") + ":" + s.toFixed(1).padStart(4, "0");
};

function groupCaps(raw: Cap[], long: boolean): Cap[] {
  if (!long) return raw.map((c) => [...c] as Cap);
  const out: Cap[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    const b = raw[i + 1];
    if (b && b[0] - a[1] < 0.45 && (a[2] + b[2]).length < 44) {
      out.push([a[0], b[1], a[2] + " " + b[2]]);
      i++;
    } else out.push([...a] as Cap);
  }
  return out;
}

function wavePath(w: number[]) {
  const step = 100 / w.length;
  let d = "";
  w.forEach((p, i) => {
    const h = Math.max(0.6, p * 11);
    d += `M${(i * step + step / 2).toFixed(2)} ${12 - h}V${12 + h}`;
  });
  return d;
}

export function EditorDemo({ ctaHref }: { ctaHref: string }) {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const $$ = <T extends HTMLElement = HTMLElement>(s: string) => [...root.querySelectorAll<T>(s)];
    const ac = new AbortController();
    const on = { signal: ac.signal };
    let dead = false;
    let raf = 0;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, reduce ? Math.min(ms, 120) : ms));

    const v = $<HTMLVideoElement>("#v3");
    const scap = $("#scap");
    const clist = $("#clist");
    const log = $("#c3log");
    log.innerHTML = "";

    let K: DemoClipKey = "brownie";
    let C = DEMO_CLIPS[K];
    let S = { hook: false, hookEnd: 3.5, long: false, music: "", preset: "", fx: "", exported: false };
    let caps: Cap[] = [];
    let lastCap = -2;
    let started = false;
    let busy = false;
    let acts = 0;

    function renderCaps(flash?: boolean) {
      caps = groupCaps(C.caps, S.long);
      lastCap = -2;
      $("#ccount").textContent = `การ์ดซับ (${caps.length})`;
      clist.innerHTML = caps
        .map((c, i) => `<div class="ccard${flash ? " flash" : ""}" data-i="${i}"><small>${fmt(c[0])}–${fmt(c[1])}</small>${c[2]}</div>`)
        .join("");
      $("#lnSub").innerHTML = caps
        .map((c, i) => `<span class="seg3" data-i="${i}" style="left:${(c[0] / C.dur) * 100}%;width:calc(${((c[1] - c[0]) / C.dur) * 100}% - 2px)">${c[2]}</span>`)
        .join("");
      $$("#lenseg span").forEach((s) => s.classList.toggle("on", (s.dataset.len === "long") === S.long));
    }
    function setStyle(preset: string, fx: string) {
      S.preset = preset;
      S.fx = fx;
      scap.className = "scap st-" + preset + " fx-" + fx;
      $$("#qs span").forEach((s) => s.classList.toggle("on", s.dataset.p === preset));
      lastCap = -2;
    }
    function sizeCap() {
      const w = $("#pv").clientWidth;
      scap.style.fontSize = ((C.sub.fontSize || 70) * w) / 1080 * 1.05 + "px";
      scap.style.top = (C.sub.verticalPos || 78) + "%";
    }
    function renderMusic() {
      const n = S.music;
      $("#mname").textContent = n || "ยังไม่มีเพลง";
      $("#lnMusic").innerHTML = n ? `<span class="seg3">♪ ${n} · ลดเสียงตอนพูด</span>` : '<span class="emptyrow">ไม่มีเพลง</span>';
    }
    function renderHook() {
      const h = $("#lnHook");
      if (!S.hook) {
        h.innerHTML = '<span class="emptyrow">ยังไม่มีพาดหัว</span>';
        $("#hk").classList.remove("on");
        return;
      }
      h.innerHTML = `<span class="seg3" style="left:0;width:${(S.hookEnd / C.dur) * 100}%">${META[K].hook}</span>`;
      $("#hkText").textContent = META[K].hook;
    }

    function load(k: DemoClipKey, user: boolean) {
      K = k;
      C = DEMO_CLIPS[k];
      const m = META[k];
      S = { hook: false, hookEnd: Math.min(3.5, C.dur), long: false, music: MUSIC[C.bgm] || "", preset: "", fx: "", exported: false };
      $$("#picker button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.k === k)));
      $("#projName").textContent = m.name;
      $("#tcDur").textContent = fmt(C.dur);
      v.poster = A + k + "-poster.jpg";
      v.src = A + k + "-clean.mp4";
      $("#lnBroll").innerHTML = C.wins
        .map((w, i) => `<span class="seg3" style="left:${(w[0] / C.dur) * 100}%;width:calc(${((w[1] - w[0]) / C.dur) * 100}% - 2px);background-image:url(${A + w[2]})"><b>ช่วง ${i + 1}</b></span>`)
        .join("");
      $("#lnVoice").innerHTML = `<svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><path d="${wavePath(C.wave)}" stroke="#34D399" stroke-width=".42" stroke-linecap="round" opacity=".85"/></svg>`;
      $("#qs").innerHTML = QS.map((q) => `<span data-p="${q[0]}" data-fx="${q[1]}"><b>${q[2]}</b><small>${q[3]}</small></span>`).join("");
      setStyle(C.sub.preset, C.sub.effect || "fade");
      renderCaps();
      sizeCap();
      renderMusic();
      renderHook();
      const eb = $("#exportBtn");
      eb.textContent = "ส่งออกวิดีโอ";
      eb.classList.remove("busy");
      if (started) v.play().catch(() => {});
      if (user) {
        say("a", `เปิดโปรเจกต์ "${m.name}" แล้วครับ ลองสั่งแก้ต่อได้เลย`);
        setChips(true);
      }
    }

    function say(kind: string, html: string) {
      const d = document.createElement("div");
      d.className = kind;
      d.innerHTML = html;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    }
    async function tool(name: string, ms?: number) {
      const d = say("tool", `<i></i><span>${name}</span>`);
      await sleep(ms || 900);
      d.classList.add("ok");
      d.innerHTML = `<i></i><span>${name}</span><em>เสร็จ</em>`;
      return d;
    }
    async function typeUser(text: string) {
      const d = say("u", "");
      const g = [...new Intl.Segmenter("th", { granularity: "grapheme" }).segment(text)].map((x) => x.segment);
      if (reduce) {
        d.textContent = text;
        return;
      }
      for (let i = 1; i <= g.length; i += 2) {
        if (dead) return;
        d.textContent = g.slice(0, i).join("");
        log.scrollTop = log.scrollHeight;
        await sleep(22);
      }
      d.textContent = text;
    }
    function setChips(enabled: boolean) {
      $$<HTMLButtonElement>("#c3chips button").forEach((b) => (b.disabled = !enabled));
      $<HTMLInputElement>("#c3text").disabled = !enabled;
      $<HTMLButtonElement>("#c3form button").disabled = !enabled;
    }

    const CMD: Record<CmdName, () => Promise<void>> = {
      async hook() {
        await typeUser("ใส่พาดหัวตอนเปิด: " + META[K].hook);
        await tool("set_headline_hook");
        S.hook = true;
        renderHook();
        v.currentTime = 0;
        say("a", "ใส่แล้วครับ พาดหัวขึ้น 3.5 วินาทีแรก ดูที่จอกลางกับแถวสีส้มได้เลย");
      },
      async style() {
        const q = QS[(QS.findIndex((x) => x[0] === S.preset) + 1) % QS.length];
        await typeUser("เปลี่ยนซับเป็นแบบ" + q[2]);
        await tool("set_subtitle_style");
        setStyle(q[0], q[1]);
        say("a", `เปลี่ยนเป็นแบบ${q[2]}แล้วครับ การ์ดซับทุกใบเปลี่ยนตาม`);
      },
      async len() {
        const L = !S.long;
        await typeUser(L ? "ซับยาวขึ้น ให้ครบประโยค" : "ซับสั้นลง อ่านเร็วขึ้น");
        await tool("regroup_captions");
        S.long = L;
        renderCaps(true);
        $("[data-cmd=len]").textContent = L ? "ซับสั้นลง" : "ซับยาวขึ้น";
        say("a", `จัดซับใหม่เป็น ${caps.length} การ์ดครับ คำเดิมทุกคำ ไม่มีการเปลี่ยนข้อความ`);
      },
      async music() {
        const next = MUSIC_ALT.find((x) => x !== S.music) || MUSIC_ALT[0];
        await typeUser("เปลี่ยนเพลงเป็นแนว" + next);
        await tool("set_background_music");
        S.music = next;
        renderMusic();
        const row = $("#mrow");
        row.classList.add("flash");
        setTimeout(() => row.classList.remove("flash"), 900);
        say("a", `ใส่เพลง "${next}" แล้วครับ เสียงเพลงลดลงเองตอนมีเสียงพูด`);
      },
      async export() {
        await typeUser("โอเค ส่งออกเลย");
        const b = $("#exportBtn");
        b.classList.add("busy");
        b.textContent = "กำลังส่งออก…";
        const sw = $("#sweep");
        sw.classList.remove("go");
        void sw.offsetWidth;
        sw.classList.add("go");
        await tool("export_video", 1600);
        b.classList.remove("busy");
        b.textContent = "ส่งออกแล้ว ✓";
        S.exported = true;
        say("a", "ได้คลิปเต็มความละเอียดแล้วครับ อยู่ในคลังคลิปของคุณ การแก้ทั้งหมดก่อนหน้านี้ไม่ตัดโควตาเพิ่ม");
      },
    };
    async function run(cmd: CmdName) {
      if (busy || !CMD[cmd]) return;
      busy = true;
      setChips(false);
      try {
        await CMD[cmd]();
      } finally {
        busy = false;
        if (!dead) {
          setChips(true);
          acts++;
          if (acts >= 2) $("#c3cta").classList.add("on");
        }
      }
      root?.querySelector(`[data-cmd=${cmd}]`)?.classList.add("used");
    }

    $$<HTMLButtonElement>("#picker button").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.k as DemoClipKey;
        if (k === K || busy) return;
        load(k, true);
      }, on),
    );
    $$<HTMLButtonElement>("#c3chips button").forEach((b) => b.addEventListener("click", () => run(b.dataset.cmd as CmdName), on));
    $("#c3form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>("#c3text");
      const t = input.value.trim();
      if (!t || busy) return;
      input.value = "";
      const map: [RegExp, CmdName][] = [
        [/พาดหัว|หัวข้อ|ไตเติ้ล/, "hook"],
        [/ยาว|สั้น|ประโยค|การ์ด/, "len"],
        [/สไตล์|สี|ฟอนต์|ตัวหนังสือ|ซับ/, "style"],
        [/เพลง|ดนตรี|เสียงเพลง/, "music"],
        [/ส่งออก|export|ดาวน์โหลด|โหลด/, "export"],
      ];
      const hit = map.find(([r]) => r.test(t));
      if (hit) return run(hit[1]);
      busy = true;
      setChips(false);
      say("u", "").textContent = t; // visitor text is never parsed as HTML
      await sleep(500);
      say("a", "เดโมนี้ลองได้ 5 อย่างด้านบนครับ ของจริงสั่งได้มากกว่านี้ เช่น แก้คำในซับทีละการ์ด เปลี่ยนภาพทีละช่วง หรือเปลี่ยนเสียงพากย์");
      busy = false;
      setChips(true);
    }, on);

    // The voice is real, so let people hear it.
    const mute = $("#muteBtn");
    mute.addEventListener("click", () => {
      v.muted = !v.muted;
      mute.setAttribute("aria-pressed", String(!v.muted));
      mute.querySelector("span")!.textContent = v.muted ? "เปิดเสียงพากย์" : "ปิดเสียง";
      if (v.paused) v.play().catch(() => {});
    }, on);

    function frame() {
      const t = v.currentTime || 0;
      const p = Math.min(1, t / C.dur);
      $("#tcNow").textContent = fmt(t);
      const ph = $("#ph3");
      ph.style.setProperty("--w", $("#lnSub").clientWidth + "px");
      ph.style.setProperty("--p", String(p));
      const i = caps.findIndex((c) => t >= c[0] && t < c[1]);
      if (i !== lastCap) {
        lastCap = i;
        scap.innerHTML = i < 0 ? "" : `<span class="in">${caps[i][2]}</span>`;
        $$("#clist .ccard").forEach((c) => c.classList.toggle("on", Number(c.dataset.i) === i));
        $$("#lnSub .seg3").forEach((c) => c.classList.toggle("on", Number(c.dataset.i) === i));
        const cur = clist.querySelector<HTMLElement>(".ccard.on");
        if (cur) clist.scrollTop = cur.offsetTop - clist.offsetTop - 70;
      }
      $("#hk").classList.toggle("on", S.hook && t < S.hookEnd);
      raf = requestAnimationFrame(frame);
    }

    // The cursor shows the same edit can be a click on the web.
    async function cursorTo(el: HTMLElement | undefined, click: boolean) {
      const c = $("#cur");
      if (!el || innerWidth < 1080 || reduce) return;
      const sr = root!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      c.classList.add("on");
      c.style.transform = `translate(${r.left - sr.left + r.width * 0.55}px,${r.top - sr.top + r.height * 0.55}px)`;
      await sleep(1000);
      if (click) {
        c.classList.add("click");
        el.classList.add("press");
        await sleep(160);
        c.classList.remove("click");
        el.classList.remove("press");
      }
    }

    async function intro() {
      started = true;
      root!.classList.add("in");
      v.play().catch(() => {});
      await sleep(500);
      if (dead) return;
      say("u", `${META[K].ask} <span class="file">${META[K].file}</span>`);
      await sleep(500);
      await tool("create_video_job", 1100);
      if (dead) return;
      say("a", `เสร็จแล้วครับ คลิป ${Math.round(C.dur)} วินาที ซับ ${C.caps.length} การ์ด ภาพประกอบ ${C.wins.length} ช่วง ใช้ 1 คลิปจากโควตา`);
      await sleep(1800);
      if (dead) return;
      busy = true;
      await CMD.hook();
      busy = false;
      await sleep(1400);
      if (dead) return;
      const target = $$("#qs span")[2];
      await cursorTo(target, true);
      if (target) setStyle(target.dataset.p!, target.dataset.fx!);
      say("a", '<span class="dim">คุณกดเปลี่ยนสไตล์บนเว็บเองก็ได้ ผลเหมือนกัน</span>');
      await sleep(700);
      if (dead) return;
      $("#cur").classList.remove("on");
      setChips(true);
      $("[data-cmd=hook]").classList.add("used");
    }

    load(K, false);
    raf = requestAnimationFrame(frame);
    addEventListener("resize", () => sizeCap(), on);
    const app = $("#app");
    const introObs = new IntersectionObserver((es, o) => {
      if (es[0].isIntersecting) {
        o.disconnect();
        void intro();
      }
    }, { threshold: 0.3 });
    introObs.observe(app);
    const playObs = new IntersectionObserver((es) => {
      if (!started) return;
      if (es[0].isIntersecting) v.play().catch(() => {});
      else v.pause();
    }, { threshold: 0.1 });
    playObs.observe(app);

    return () => {
      dead = true;
      ac.abort();
      cancelAnimationFrame(raf);
      introObs.disconnect();
      playObs.disconnect();
      v.pause();
    };
  }, []);

  return (
    <section ref={rootRef} className="wrap stage3" id="demo" aria-label="ตัวอย่างหน้าตัดต่อจริง">
      <div className="picker" role="tablist" aria-label="เลือกคลิปตัวอย่าง" id="picker">
        {KEYS.map((k, i) => (
          <button key={k} role="tab" type="button" data-k={k} aria-selected={i === 0}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 30px thumbnail, already sized */}
            <img src={A + META[k].thumb} alt="" width={30} height={30} />
            {META[k].tab}
          </button>
        ))}
      </div>

      <div className="chat3" id="chat3" aria-label="แชทกับ AI ของคุณ">
        <div className="c3h"><span className="av" /><span>AI ของคุณ</span><small><i />เชื่อม HERO แล้ว</small></div>
        <div className="c3log" id="c3log" aria-live="polite" />
        <div className="c3ask">
          <div className="c3chips" id="c3chips">
            {CHIPS.map(([cmd, label]) => (
              <button key={cmd} type="button" data-cmd={cmd} disabled>{label}</button>
            ))}
          </div>
          <form className="c3in" id="c3form">
            <input id="c3text" placeholder="หรือพิมพ์สั่งเอง" autoComplete="off" aria-label="พิมพ์คำสั่ง" disabled />
            <button type="submit" aria-label="ส่ง" disabled>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 12V2M7 2 2.5 6.5M7 2l4.5 4.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </form>
          <div className="c3cta" id="c3cta"><span>อยากได้แบบนี้จากสคริปต์ของคุณ?</span><a href={ctaHref}>ทดลอง PRO ฟรี 7 วัน</a></div>
        </div>
      </div>

      <div className="app" id="app">
        <div className="chrome">
          <div className="dots"><i /><i /><i /></div>
          <div className="url">
            <svg width="10" height="12" viewBox="0 0 10 12" fill="none" aria-hidden="true"><rect x="1" y="5" width="8" height="6.5" rx="1.5" stroke="currentColor" /><path d="M3 5V3.5a2 2 0 0 1 4 0V5" stroke="currentColor" /></svg>
            studio.heroaiengine.com/video-editor
          </div>
        </div>
        <div className="abar">
          <span className="lg">H</span><span className="proj" id="projName">{META.brownie.name}</span><span className="saved"><i />บันทึกอัตโนมัติ</span>
          <span className="quota">โควตาเดือนนี้ <s><b id="qbar" /></s> <span id="qtext">12/100 คลิป</span></span>
          <button className="exportbtn" type="button" id="exportBtn" tabIndex={-1}>ส่งออกวิดีโอ</button>
        </div>
        <div className="amain">
          <aside className="lcol">
            <div className="lhead"><span className="glab" id="ccount">การ์ดซับ</span><span className="ur"><i>↶</i><i>↷</i></span></div>
            <div className="clist" id="clist" />
          </aside>
          <div className="ccol">
            <span className="pvlab"><i />พรีวิวพร้อมแต่ง</span>
            <div className="pv" id="pv">
              <video id="v3" muted playsInline loop preload="auto" poster={A + "brownie-poster.jpg"} />
              <div className="hk3" id="hk"><span id="hkText" /></div>
              <div className="scap" id="scap" />
              <div className="sweep" id="sweep" />
              <button className="mute" type="button" id="muteBtn" aria-pressed="false">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1.5 4.5h2l3-2.5v8l-3-2.5h-2z" fill="currentColor" /></svg>
                <span>เปิดเสียงพากย์</span>
              </button>
            </div>
          </div>
          <aside className="rcol">
            <div className="seg" aria-hidden="true"><span>พาดหัว</span><span className="on">ซับ</span><span>โลโก้</span><span>เพลง</span></div>
            <div className="rbody">
              <div><span className="glab">สไตล์แนะนำ</span><div className="qs" id="qs" /></div>
              <div><span className="glab">ความยาวการ์ดซับ</span><div className="lenseg" id="lenseg"><span data-len="short" className="on">สั้น อ่านเร็ว</span><span data-len="long">ยาว ครบประโยค</span></div></div>
              <div><span className="glab">เพลง</span><div className="mrow" id="mrow"><i>♪</i><span><b id="mname" /><small>ลดเสียงใต้เสียงพูดอัตโนมัติ</small></span></div></div>
            </div>
          </aside>
        </div>
        <div className="tl3" id="tl3">
          <div className="tbar">
            <span className="play" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1l7 4-7 4z" fill="#F2F2F8" /></svg></span>
            <span className="tcx"><span id="tcNow">00:00.0</span> <em>/ <span id="tcDur">00:24.0</span></em></span>
            <span className="zm"><i>−</i><i>+</i></span>
          </div>
          <div className="trk" id="trk">
            <div className="trow"><span className="tn"><i style={{ background: "var(--tHook)" }} />พาดหัว</span><div className="lane3 L-hook" id="lnHook" /></div>
            <div className="trow tall"><span className="tn"><i style={{ background: "var(--tBroll)" }} />ภาพประกอบ</span><div className="lane3 L-broll" id="lnBroll" /></div>
            <div className="trow"><span className="tn"><i style={{ background: "var(--tSub)" }} />ซับไทย</span><div className="lane3 L-sub" id="lnSub" /></div>
            <div className="trow"><span className="tn"><i style={{ background: "var(--tVoice)" }} />เสียงพูด</span><div className="lane3 L-voice" id="lnVoice" /></div>
            <div className="trow"><span className="tn"><i style={{ background: "var(--tMusic)" }} />เพลง</span><div className="lane3 L-music" id="lnMusic" /></div>
            <div className="ph3" id="ph3" />
          </div>
        </div>
      </div>

      <div className="cur" id="cur" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.5-6.5 1.6L8.2 18z" fill="#fff" stroke="#0b0a10" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        <em>คุณ</em>
      </div>

      <p className="foot3">ทั้ง 4 คลิปทีมงาน HERO ทำด้วยระบบจริง ภาพ เสียง และจังหวะซับมาจากงานจริง ส่วนแชทเป็นการจำลองให้ดูเร็วขึ้น ของจริงสร้างคลิปราว 3–6 นาที</p>
    </section>
  );
}
