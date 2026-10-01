// Race commentary using the browser's built-in speech voices (British English preferred).
// Lines are picked at random from pools so the calls don't repeat word for word.
const pick = a => a[Math.floor(Math.random() * a.length)];
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

export const LINES = {
  start: ["And it's lights out and away we go!", "Lights out, and they're away cleanly!", "Five red lights... and away we go! Here we go, racing!"],
  lap1: ["End of the opening lap, and it's {leader} who leads the way.", "One lap down, {leader} out in front."],
  fastest: ["Purple! That's the fastest lap of the race for {name}, a {time}! Superb!", "Oh, look at that! Fastest lap, {name}, a {time}. Well done!", "Complete fastest time from {name}! A {time}, stunning lap!"],
  pb: ["Personal best for {name}, a {time}. Well driven!", "That's quicker from {name}, a {time}. Nicely done."],
  overtake: ["{a} goes past {b}! That's P{pos}!", "And {a} has done it! Through on {b} for P{pos}!", "What a move from {a}! {b} can do nothing about it!", "{a} makes it stick! Up into P{pos}!"],
  lead: ["And there's a new leader! {name} takes P1!", "{name} into the lead! What a moment!"],
  finalLap: ["The leader, {name}, starts the final lap!", "Final lap! {name} leads, can anyone catch them?"],
  win: ["And {name} takes the chequered flag! Wins the Grand Prix! Magnificent!", "{name} wins it! What a drive! The crowd are on their feet!"],
  finish: ["{name} crosses the line to finish in P{pos}.", "And it's P{pos} for {name}. Solid work."],
  pitIn: ["{name} is in the pits, box box!", "And {name} peels into the pit lane."],
  pitOut: ["A {secs} second stop for {name}! Good work from the crew.", "{name} is released, {secs} seconds, lovely work from the mechanics!"],
  crash: ["Oh, big moment for {name}! Into the barrier!", "Contact! {name} has hit the wall, that'll hurt!", "Oh dear, {name} is in the wall!"],
  filler: ["The crowd are absolutely loving this!", "{leader} leads by {gap} seconds.", "What a battle we've got on our hands here.", "Tyre management is going to be crucial today.", "Fantastic atmosphere in the grandstands this afternoon.", "{leader} looking very comfortable out in front.", "Keep an eye on the gaps, this could get interesting."],
};

// "1:17.4" is read naturally as "one seventeen point four"
export function spokenTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m > 0 ? `${m} ${s < 10 ? 'oh ' : ''}${s.toFixed(1)}` : `${s.toFixed(1)} seconds`;
}

export const commentary = {
  enabled: false, voice: null, queue: [], speaking: false, last: 0,
  init() {
    if (!('speechSynthesis' in window)) return;
    const choose = () => {
      const vs = speechSynthesis.getVoices(); if (!vs.length) return;
      const pref = ['Google UK English Male', 'Microsoft Ryan', 'Microsoft George', 'Daniel', 'Arthur', 'Oliver', 'Google UK English Female'];
      this.voice = pref.map(n => vs.find(v => v.name.includes(n))).find(Boolean) || vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || vs[0];
    };
    choose(); speechSynthesis.onvoiceschanged = choose;
  },
  // must be called from a click/tap so mobile browsers allow speech later
  unlock() { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {} },
  // priority: 3 = headline (interrupts), 2 = event, 1 = filler (dropped if busy)
  say(key, vars = {}, prio = 2) {
    if (!this.enabled || !('speechSynthesis' in window) || !LINES[key]) return;
    const text = fill(pick(LINES[key]), vars);
    if (prio >= 3 && this.speaking) { speechSynthesis.cancel(); this.queue = []; this.speaking = false; }
    if (prio <= 1 && (this.speaking || this.queue.length)) return;
    this.queue = this.queue.filter(q => q.prio >= prio).slice(-2);
    this.queue.push({ text, prio });
    this.next();
  },
  next() {
    if (this.speaking || !this.queue.length) return;
    const { text } = this.queue.shift();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang || 'en-GB'; u.rate = 1.1; u.pitch = 0.92; u.volume = 1;
    this.speaking = true; this.last = performance.now();
    u.onend = u.onerror = () => { this.speaking = false; setTimeout(() => this.next(), 250); };
    speechSynthesis.speak(u);
  },
  stop() { this.queue = []; this.speaking = false; try { speechSynthesis.cancel(); } catch {} },
};
