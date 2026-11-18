// Redraws the website's four phone screens (website/img/snaps/phone-*.jpg), 18 Nov, Alex: the pictures on them are the
// ones known to be free to use (the gym and the shore, Unsplash; app/lib/phaseCovers.ts), and Training is a live workout.
// Home, Nutrition and Check-in keep the earlier drawing with the photo parts drawn again over it; the workout is new.
// Run from the repo root: node <this file>. Needs the website server on :4322 and Chrome.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require(path.resolve("node_modules/sharp"));

const SITE = path.resolve("website");
const SNAPS = path.join(SITE, "img", "snaps");
const KEEP = path.join(__dirname, "snaps-before");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const src = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
const word = src.match(/<symbol id="i-word"[\s\S]*?<\/symbol>/)[0];
const mark = src.match(/<symbol id="i-mark"[\s\S]*?<\/symbol>/)[0];

const status = (c) => `
  <div class="sb" style="color:${c}">
    <b>9:41</b><i class="island"></i>
    <span class="sb-r">
      <svg viewBox="0 0 18 12" width="18" height="12"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>
      <svg viewBox="0 0 16 12" width="16" height="12"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M1.2 4.2a10 10 0 0 1 13.6 0M3.8 7a6.2 6.2 0 0 1 8.4 0"/><circle cx="8" cy="10" r="1.5" fill="currentColor"/></svg>
      <svg viewBox="0 0 27 13" width="27" height="13"><rect x=".7" y=".7" width="22.6" height="11.6" rx="3.6" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="1.2"/><rect x="2.4" y="2.4" width="19.2" height="8.2" rx="2.2" fill="currentColor"/><path d="M25 4.4v4.2c.9-.3 1.5-1.2 1.5-2.1s-.6-1.8-1.5-2.1z" fill="currentColor" fill-opacity=".5"/></svg>
    </span>
  </div>`;

const appBar = `
  <div class="ab">
    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>
    <svg class="ab-word" viewBox="0 0 2000 352"><use href="#i-word"/></svg>
    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15zM10 21h4"/></svg>
  </div>`;

const DUMBBELL = `<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12"/>`;

const screens = {
  home: (bg) => `
  <div class="scr" style="background:url(img/snaps/_base-home.jpg) 0 0 / 390px 844px">
    <div class="strip" style="top:242px;height:368px;background:${bg}">
      <div class="pcard" style="left:-303px"><img src="img/photo-shore.jpg" style="object-position:50% 60%"><i class="shade"></i></div>
      <div class="pcard" style="left:33px">
        <img src="img/photo-gym.jpg" style="object-position:34% 50%"><i class="shade"></i>
        <span class="chip" style="left:12px"><svg viewBox="0 0 24 24" width="13" height="13">${DUMBBELL}</svg>TRAINING</span>
        <span class="chip plain" style="right:12px">Week 4</span>
        <div class="glass">
          <div class="g-top"><b>Upper strength</b><span>2 weeks left</span></div>
          <div class="g-bar"><i style="width:57%"></i></div>
          <div class="g-dates"><span>5 Oct</span><span>15 Nov</span></div>
          <div class="g-foot"><div><small>UP NEXT</small><b>Upper B</b></div><span class="g-start">Start</span></div>
        </div>
      </div>
      <div class="pcard" style="left:369px;background:#2a3140"></div>
    </div>
  </div>`,

  nutrition: () => `
  <div class="scr" style="background:url(img/snaps/_base-nutrition.jpg) 0 0 / 390px 844px">
    <div class="banner" style="height:305px">
      <img src="img/photo-nutrition.jpg" style="object-position:50% 50%"><i class="shade deep"></i>
      ${status("#fff")}${appBar}
      <p class="b-eye" style="top:84px">NUTRITION</p>
      <p class="b-title" style="top:104px">Cut</p>
      <div class="b-bar" style="top:155px"><i style="width:29%"></i></div>
      <div class="b-facts" style="top:166px"><span>Started 5 Oct</span><span>Week <b>4</b> of 12</span></div>
      <div class="b-tabs" style="top:256px"><span class="on">TRAINING DAY</span><span>REST DAY</span></div>
    </div>
  </div>`,

  lifestyle: () => `
  <div class="scr" style="background:url(img/snaps/_base-lifestyle.jpg) 0 0 / 390px 844px">
    <div class="banner" style="height:232px">
      <img src="img/photo-shore.jpg" style="object-position:50% 54%"><i class="shade deep"></i>
      ${status("#fff")}
      <svg class="b-back" viewBox="0 0 24 24" width="22" height="22"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>
      <p class="b-screen">CHECK-IN</p>
      <span class="b-count"><i></i>5 / 5</span>
      <p class="b-eye" style="top:102px">DAILY</p>
      <p class="b-title" style="top:122px">Wednesday 28 October</p>
      <div class="b-pills"><span>Entries</span><span class="on">Progress</span><span>Calendar</span></div>
    </div>
  </div>`,

  training: () => `
  <div class="scr wo">
    ${status("#141a24")}
    <div class="wo-pillrow"><span class="wo-pill"><i class="wo-face">MF</i><b>Muscle Factory</b><svg viewBox="0 0 24 24" width="12" height="12"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg><em></em><b class="num">24:18</b></span></div>
    <div class="ws-scroll">
      <div class="ws-foldline"><span class="ws-done"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg></span><span class="ws-foldline-name">Bench press</span><i class="ws-chev"></i></div>
      <div class="ws-block">
        <div class="ws-bh"><span class="ws-bn on">2</span><h3 class="ws-bname">Barbell row</h3><span class="ws-tools">
          <i><svg viewBox="0 0 24 24" width="17" height="17"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M8 5.5v13l10.5-6.5z"/></svg></i>
          <i><svg viewBox="0 0 24 24" width="17" height="17"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v11H9l-5 4z"/></svg></i>
          <i><svg viewBox="0 0 24 24" width="17" height="17"><g fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></g></svg></i>
        </span></div>
        <div class="ws-bbody">
          <div class="ws-ask"><i></i><b>Finlay asked for a video</b><span class="ws-ink-pill">Record</span></div>
          <p class="ws-tgt"><b>Target</b><span>3 × 8–10<i class="bar"></i>60 kg<i class="bar"></i>Rest 2 min</span></p>
          <div class="ws-note"><span class="wo-coach"></span><div><small>FINLAY</small><p>Pull to your belly button. Pause for a second at the top.</p></div></div>
          <div class="ws-grid">
            <div class="ws-gh"><span>Set</span><span>Last</span><span class="c">kg</span><span class="c">Reps</span><span></span><span></span></div>
            <div class="ws-gr done"><span class="ws-sn">1</span><span class="ws-last">57.5 × 10</span><span class="ws-cell"><b>60</b><em>+2.5</em></span><span class="ws-cell"><b>10</b></span><span class="ws-pbcell"><i class="ws-pb">PB</i></span><span class="ws-tick done"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg></span></div>
            <div class="ws-gr"><span class="ws-sn">2</span><span class="ws-last">57.5 × 9</span><span class="ws-cell line"><b>60</b><em>+2.5</em></span><span class="ws-cell line focus"><b>9</b></span><span></span><span class="ws-tick ready"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg></span></div>
            <div class="ws-gr"><span class="ws-sn">3</span><span class="ws-last">55 × 9</span><span class="ws-cell line"></span><span class="ws-cell line"></span><span></span><span class="ws-tick"></span></div>
          </div>
          <div class="ws-setacts"><span>− Remove a set</span><span>+ Add a set</span></div>
        </div>
      </div>
      <div class="ws-block">
        <div class="ws-bh"><span class="ws-bn">3</span><h3 class="ws-bname">Lat pulldown</h3><span class="ws-tools">
          <i><svg viewBox="0 0 24 24" width="17" height="17"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" d="M8 5.5v13l10.5-6.5z"/></svg></i>
          <i><svg viewBox="0 0 24 24" width="17" height="17"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M4 5h16v11H9l-5 4z"/></svg></i>
          <i><svg viewBox="0 0 24 24" width="17" height="17"><g fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></g></svg></i>
        </span></div>
        <div class="ws-bbody">
          <p class="ws-tgt"><b>Target</b><span>3 × 10–12<i class="bar"></i>45 kg<i class="bar"></i>Rest 90 s</span></p>
          <div class="ws-grid">
            <div class="ws-gh"><span>Set</span><span>Last</span><span class="c">kg</span><span class="c">Reps</span><span></span><span></span></div>
            <div class="ws-gr"><span class="ws-sn">1</span><span class="ws-last">45 × 12</span><span class="ws-cell line"></span><span class="ws-cell line"></span><span></span><span class="ws-tick"></span></div>
          </div>
        </div>
      </div>
    </div>
    <div class="ws-dock"><span class="rest"><svg viewBox="0 0 24 24" width="15" height="15"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/></g></svg>Rest <b class="num">1:42</b></span><span class="fin">Finish</span></div>
  </div>`,
};

const css = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:390px;height:844px;overflow:hidden;background:#000}
body{font-family:Archivo,system-ui,sans-serif;font-weight:500;-webkit-font-smoothing:antialiased;color:#141a24}
.scr{position:relative;width:390px;height:844px;overflow:hidden}
.num{font-variant-numeric:tabular-nums}
.sb{position:absolute;top:0;left:0;right:0;height:54px;z-index:5}
.sb b{position:absolute;left:46px;top:18px;font-size:16px;font-weight:600;letter-spacing:.01em}
.island{position:absolute;left:133px;top:11px;width:124px;height:36px;border-radius:18px;background:#000}
.sb-r{position:absolute;right:30px;top:22px;display:flex;align-items:center;gap:6px}
.ab{position:absolute;top:54px;left:24px;right:24px;height:22px;display:flex;align-items:center;justify-content:space-between;color:#fff;z-index:5}
.ab-word{height:17px;width:auto}
.strip{position:absolute;left:0;right:0;overflow:hidden}
.pcard{position:absolute;top:4px;width:324px;height:360px;border-radius:28px;overflow:hidden;background:#15171c;color:#fff}
.pcard img,.banner>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,12,16,.5) 0%,rgba(10,12,16,.12) 34%,rgba(10,12,16,.3) 60%,rgba(10,12,16,.72) 100%)}
.shade.deep{background:linear-gradient(180deg,rgba(10,12,16,.62) 0%,rgba(10,12,16,.42) 50%,rgba(10,12,16,.66) 100%)}
.chip{position:absolute;top:12px;display:inline-flex;align-items:center;gap:7px;height:25px;padding:0 11px;border-radius:999px;background:rgba(40,42,48,.55);box-shadow:inset 0 0 0 1px rgba(255,255,255,.28);backdrop-filter:blur(8px);font-size:11px;font-weight:600;letter-spacing:.16em;color:#fff}
.chip.plain{letter-spacing:0;font-size:11px}
.glass{position:absolute;left:9px;right:9px;bottom:9px;height:151px;padding:17px 15px 0;border-radius:22px;background:rgba(92,98,112,.5);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22);backdrop-filter:blur(14px) saturate(120%)}
.g-top{display:flex;align-items:baseline;justify-content:space-between}
.g-top b{font-size:19px;font-weight:600;letter-spacing:-.015em}
.g-top span{font-size:11.5px;font-weight:600}
.g-bar{margin-top:13px;height:3px;border-radius:3px;background:rgba(255,255,255,.3)}
.g-bar i{display:block;height:100%;border-radius:3px;background:#fff}
.g-dates{margin-top:8px;display:flex;justify-content:space-between;font-size:10.5px;color:rgba(255,255,255,.88)}
.g-foot{margin-top:13px;padding-top:13px;border-top:1px solid rgba(255,255,255,.2);display:flex;align-items:center;justify-content:space-between}
.g-foot small{display:block;font-size:9.5px;font-weight:600;letter-spacing:.16em;color:rgba(255,255,255,.8)}
.g-foot b{display:block;margin-top:3px;font-size:16.5px;font-weight:600;letter-spacing:-.01em}
.g-start{display:grid;place-items:center;width:69px;height:40px;border-radius:14px;background:rgba(255,255,255,.26);font-size:15px;font-weight:600}
.banner{position:absolute;top:0;left:0;right:0;overflow:hidden;background:#17181c;color:#fff}
.banner.plain{background:#232428}
.b-mark{position:absolute;top:-40px;right:-110px;width:380px;color:#fff;opacity:.06}
.b-eye{position:absolute;left:22px;font-size:10.5px;font-weight:600;letter-spacing:.18em;color:rgba(255,255,255,.78)}
.b-title{position:absolute;left:22px;font-size:24px;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.b-bar{position:absolute;left:22px;right:22px;height:4px;border-radius:4px;background:rgba(255,255,255,.28)}
.b-bar i{display:block;height:100%;border-radius:4px;background:#fff}
.b-facts{position:absolute;left:22px;right:22px;display:flex;justify-content:space-between;font-size:13px;color:rgba(255,255,255,.9)}
.b-facts b{font-weight:600}
.b-tabs{position:absolute;left:22px;right:22px;height:29px;display:flex;justify-content:center;gap:36px;border-bottom:1px solid rgba(255,255,255,.22);font-size:11px;font-weight:600;letter-spacing:.14em;color:rgba(255,255,255,.6)}
.b-tabs span{position:relative;height:29px}
.b-tabs .on{color:#fff}
.b-tabs .on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:#fff}
.b-back{position:absolute;left:28px;top:63px;color:#fff}
.b-screen{position:absolute;left:0;right:0;top:66px;text-align:center;font-size:13.5px;font-weight:600;letter-spacing:.16em}
.b-count{position:absolute;right:16px;top:59px;display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border-radius:999px;background:rgba(60,62,68,.5);box-shadow:inset 0 0 0 1px rgba(255,255,255,.3);backdrop-filter:blur(8px);font-size:12px;font-weight:600}
.b-count i{width:7px;height:7px;border-radius:50%;background:#7ed08f}
.b-pills{position:absolute;left:16px;right:16px;top:172px;display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.b-pills span{display:grid;place-items:center;height:40px;border-radius:12px;background:rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.32);backdrop-filter:blur(8px);font-size:13.5px;font-weight:600}
.b-pills .on{background:#fff;color:#141a24;box-shadow:none}

/* The live workout (docs/DESIGN-RULES.md §6: the gym capsule, the head, the ask's line, the coach's note, the target
   band, the sets on one spine with the open set big, the dock). */
.wo{background:#F5F6F8}
.wo-pillrow{position:absolute;top:58px;left:0;right:0;display:flex;justify-content:center}
.wo-pill{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px 0 8px;border-radius:999px;background:#141a24;color:#fff;font-size:13.5px}
.wo-pill b{font-weight:600}
.wo-pill em{width:1px;height:12px;background:rgba(255,255,255,.3)}
.wo-face{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#3a3390;font-style:normal;font-size:8.5px;font-weight:600}
.wo-segs{position:absolute;top:110px;left:20px;right:20px;display:grid;grid-template-columns:repeat(6,1fr);gap:5px}
.wo-segs i{height:3px;border-radius:3px;background:#DCE1E8}
.wo-segs .done{background:#141a24}
.wo-segs .now{background:#3a3390}
.wo-eyerow{position:absolute;top:130px;left:20px;right:16px;height:32px;display:flex;align-items:center;justify-content:space-between}
.wo-eyerow p{display:flex;align-items:center;font-size:10.5px;font-weight:600;letter-spacing:.16em;color:#5b6474}
.bar{display:inline-block;width:1px;height:10px;margin:0 9px;background:#C9CFD8}
.wo-tools{display:flex;gap:6px}
.wo-tools span{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;box-shadow:inset 0 0 0 1.5px #DCE1E8;color:#141a24}
.wo-tools .amber{color:#a8761f;box-shadow:inset 0 0 0 1.5px rgba(168,118,31,.55)}
.wo-name{position:absolute;top:172px;left:20px;right:20px;font-size:26px;font-weight:500;letter-spacing:-.02em;line-height:1.15}
.wo-next{position:absolute;top:208px;left:20px;font-size:12px;color:#8b93a1}
.wo-next b{font-weight:600;color:#3a4250;margin-left:4px}
.wo-ask{position:absolute;top:240px;left:20px;right:20px;height:32px;display:flex;align-items:center;gap:8px;font-size:13px;color:#a8761f}
.wo-ask i{width:6px;height:6px;border-radius:50%;background:#a8761f}
.wo-ask b{font-weight:600}
.wo-rec{margin-left:auto;display:grid;place-items:center;height:32px;padding:0 16px;border-radius:999px;background:#141a24;color:#fff;font-size:13px;font-weight:600}
.wo-note{position:absolute;top:288px;left:20px;right:20px;display:flex;gap:12px;align-items:flex-start}
.wo-coach{flex:none;width:36px;height:36px;border-radius:50%;background:#EEF0F3 url(img/avatars/finlay.svg) center / cover}
.wo-note small{display:block;font-size:10.5px;font-weight:600;letter-spacing:.16em;color:#8b93a1}
.wo-note p{margin-top:2px;font-size:15px;line-height:1.35;color:#141a24}
.wo-target{position:absolute;top:356px;left:0;right:0;height:82px;padding:12px 20px 0 32px;background:rgba(58,51,144,.07)}
.wo-target::before{content:"";position:absolute;left:20px;top:12px;bottom:12px;width:2px;border-radius:2px;background:#3a3390}
.wo-target small{display:block;font-size:10.5px;font-weight:600;letter-spacing:.16em;color:#3a3390}
.wo-cols{margin-top:8px;display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
.wo-cols b{display:block;font-size:19px;font-weight:600;letter-spacing:-.01em;line-height:1.1;white-space:nowrap}
.wo-cols span{display:block;margin-top:4px;font-size:10px;font-weight:600;letter-spacing:.14em;color:#8b93a1}
.wo-setshead{position:absolute;top:464px;left:20px;right:20px;height:36px;display:flex;align-items:center;justify-content:space-between}
.wo-setshead p{font-size:11px;font-weight:600;letter-spacing:.16em}
.wo-setshead p span{margin-left:6px;color:#8b93a1}
.wo-unit{display:inline-flex;padding:3px;border-radius:999px;background:#fff;box-shadow:inset 0 0 0 1px #E1E5EB;font-size:12px;font-weight:600}
.wo-unit>*{display:grid;place-items:center;height:28px;padding:0 13px;border-radius:999px;color:#5b6474}
.wo-unit b{background:#141a24;color:#fff;font-weight:600}
.wo-sets{position:absolute;top:510px;left:20px;right:20px}
.spine{position:absolute;left:19.5px;top:14px;bottom:14px;width:1px;background:#DCE1E8}
.q{position:relative;display:flex;align-items:center;height:40px}
.ring{flex:none;display:grid;place-items:center;width:22px;height:22px;margin:0 16px 0 9px;border-radius:50%;background:#F5F6F8;box-shadow:inset 0 0 0 1.5px #C9CFD8;font-size:11px;font-weight:600;color:#8b93a1}
.ring.ok{color:#2f7a3f;box-shadow:inset 0 0 0 1.5px #2f7a3f}
.q p{font-size:15px;color:#3a4250}
.q p small{font-size:12px;color:#8b93a1}
.q.next p{color:#98A2B3}
.up{margin-left:10px;font-style:normal;font-size:11.5px;font-weight:600;color:#2f7a3f}
.open{position:relative;display:flex;align-items:center;height:104px}
.badge{flex:none;display:grid;place-items:center;width:34px;height:34px;margin:0 10px 0 3px;border-radius:50%;background:#F5F6F8;box-shadow:inset 0 0 0 1.5px #141a24,0 0 0 5px rgba(20,26,36,.07);font-size:14px;font-weight:600}
.pair{flex:1;display:flex;justify-content:center;gap:30px;padding-right:44px}
.fig{position:relative;display:flex;align-items:baseline;gap:7px;min-width:104px;justify-content:flex-end;padding-bottom:7px;border-bottom:1.5px solid #141a24}
.fig+.fig{border-bottom-color:#C9CFD8}
.fig b{font-size:46px;font-weight:300;letter-spacing:-.03em;line-height:1}
.fig small{font-size:10.5px;font-weight:600;letter-spacing:.14em;color:#8b93a1}
.fig .up{position:absolute;right:-22px;top:0;margin:0}
.wo-addrow{position:absolute;top:706px;right:20px;display:flex;gap:22px;font-size:12.5px;font-weight:600;color:#5b6474}
.wo-dock{position:absolute;left:16px;right:16px;bottom:30px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
.wo-dock span{display:flex;align-items:center;justify-content:center;gap:8px;height:48px;border-radius:999px;font-size:15px;font-weight:600}
.rest{background:#141a24;color:#fff}
.nextb{background:#fff;box-shadow:inset 0 0 0 1px #E1E5EB}

/* The workout sheet (app/client/workout-sheet.css's sizes). */
.ws-scroll{position:absolute;top:106px;left:16px;right:16px;bottom:0}
.ws-foldline{display:flex;align-items:center;gap:10px;min-height:46px}
.ws-done{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;box-shadow:inset 0 0 0 1.5px #2f7a3f;color:#2f7a3f}
.ws-foldline-name{flex:1;font-size:17px;font-weight:500;color:#3a4250}
.ws-chev{flex:none;width:7px;height:7px;margin:0 4px 0 2px;border-right:1.5px solid #8b93a1;border-bottom:1.5px solid #8b93a1;transform:rotate(-45deg)}
.ws-block{padding:14px 0 12px;margin-top:12px}
.ws-bh{display:flex;align-items:center;gap:10px;min-height:30px}
.ws-bn{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;box-shadow:inset 0 0 0 1.5px #E1E5EB;font-size:11px;font-weight:600;color:#8b93a1}
.ws-bn.on{box-shadow:inset 0 0 0 1.5px #141a24;color:#141a24}
.ws-bname{flex:1;font-size:20px;font-weight:600;line-height:1.25;letter-spacing:-.005em}
.ws-tools{flex:none;display:flex;gap:6px}
.ws-tools i{display:grid;place-items:center;width:30px;height:30px;color:#141a24}
.ws-bbody{display:flex;flex-direction:column;gap:12px;margin-left:32px;padding-top:10px}
.ws-ask{display:flex;align-items:center;gap:8px;min-height:32px;font-size:13px;color:#a8761f}
.ws-ask i{width:6px;height:6px;border-radius:50%;background:#a8761f}
.ws-ask b{font-weight:600}
.ws-ink-pill{margin-left:auto;display:grid;place-items:center;height:32px;padding:0 14px;border-radius:999px;background:#141a24;color:#fff;font-size:13px;font-weight:600}
.ws-tgt{display:flex;align-items:baseline;gap:8px;font-size:15px;line-height:1.4;color:#5b6474;font-variant-numeric:tabular-nums}
.ws-tgt>b{font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#3a3390}
.ws-note{display:flex;gap:12px;align-items:flex-start}
.ws-note small{display:block;font-size:10.5px;font-weight:600;letter-spacing:.16em;color:#8b93a1}
.ws-note p{margin-top:1px;font-size:16px;line-height:22px;color:#141a24}
.ws-grid{display:flex;flex-direction:column;margin-top:2px}
.ws-gh,.ws-gr{display:grid;grid-template-columns:36px minmax(0,1fr) 84px 60px 24px 28px;column-gap:7px;align-items:center}
.ws-gh{height:22px;font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#98A2B3}
.ws-gh .c{text-align:center}
.ws-gr{height:54px}
.ws-sn{font-size:18px;font-weight:500;color:#8b93a1;font-variant-numeric:tabular-nums}
.ws-last{font-size:15px;font-weight:600;color:#8b93a1;font-variant-numeric:tabular-nums;white-space:nowrap}
.ws-cell{position:relative;display:grid;place-items:center;height:44px;margin:0 6px}
.ws-cell.line{box-shadow:inset 0 -1.5px 0 #C9CFD8}
.ws-cell.line.focus{box-shadow:inset 0 -1.5px 0 #141a24}
.ws-cell b{font-size:26px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.ws-cell em{position:absolute;top:-6px;right:-4px;font-style:normal;font-size:12px;font-weight:600;line-height:1;color:#2f7a3f}
.ws-gr.done .ws-sn,.ws-gr.done .ws-cell b{font-weight:600;color:#2f7a3f}
.ws-gr.done>:not(.ws-tick){opacity:.6}
.ws-pbcell{display:grid;place-items:center}
.ws-pb{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;box-shadow:inset 0 0 0 1.5px rgba(47,122,63,.55);font-style:normal;font-size:9px;font-weight:600;letter-spacing:.02em;color:#2f7a3f}
.ws-tick{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;box-shadow:inset 0 0 0 1.5px #E1E5EB;color:transparent}
.ws-tick.ready{box-shadow:inset 0 0 0 1.5px #141a24;color:#141a24}
.ws-tick.done{box-shadow:inset 0 0 0 1.5px #2f7a3f;color:#2f7a3f}
.ws-setacts{display:flex;align-items:center;justify-content:flex-end;gap:18px;min-height:34px;margin-top:-4px;font-size:15px;font-weight:600;color:#5b6474}
.ws-dock{position:absolute;left:16px;right:16px;bottom:28px;display:flex;gap:10px;padding-top:14px;background:linear-gradient(180deg,rgba(245,246,248,0),#F5F6F8 30%)}
.ws-dock::before{content:"";position:absolute;left:-16px;right:-16px;top:14px;bottom:-28px;background:#F5F6F8;z-index:-1}
.ws-dock span{display:flex;align-items:center;justify-content:center;gap:8px;height:42px;border-radius:999px;font-weight:600}
.ws-dock .rest{flex:none;padding:0 16px;background:#141a24;color:#fff;font-size:13px}
.ws-dock .fin{flex:1;background:#141a24;color:#fff;font-size:14px}
`;

(async () => {
  fs.mkdirSync(KEEP, { recursive: true });
  for (const k of ["home", "nutrition", "lifestyle", "training"]) {
    const f = path.join(SNAPS, `phone-${k}.jpg`), kept = path.join(KEEP, `phone-${k}.jpg`);
    if (!fs.existsSync(kept)) fs.copyFileSync(f, kept);
    if (k !== "training") fs.copyFileSync(kept, path.join(SNAPS, `_base-${k}.jpg`));
  }
  // The page colour between the Home cards, read off the drawing it sits on.
  const px = await sharp(path.join(KEEP, "phone-home.jpg")).extract({ left: 50, top: 760, width: 6, height: 6 }).raw().toBuffer();
  const bg = `rgb(${px[0]},${px[1]},${px[2]})`;
  for (const k of Object.keys(screens)) {
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;500;600&display=block"><style>${css}</style><svg width="0" height="0" style="position:absolute"><defs>${word}${mark}</defs></svg>${screens[k](bg)}`;
    fs.writeFileSync(path.join(SITE, `_phone-${k}.html`), html);
    const png = path.join(__dirname, `phone-${k}.png`);
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=390,844", "--force-device-scale-factor=2", "--virtual-time-budget=6000", `--screenshot=${png}`, `http://localhost:4322/_phone-${k}.html`], { stdio: "ignore" });
    const meta = await sharp(png).metadata();
    await sharp(png).resize(780, 1688, { fit: "cover", position: "top" }).jpeg({ quality: 88 }).toFile(path.join(SNAPS, `phone-${k}.jpg`));
    console.log(k, meta.width, meta.height);
  }
  for (const k of ["home", "nutrition", "lifestyle", "training"]) {
    fs.rmSync(path.join(SITE, `_phone-${k}.html`), { force: true });
    fs.rmSync(path.join(SNAPS, `_base-${k}.jpg`), { force: true });
  }
})();
